/**
 * @botton/dsh-model-router 单元测试（node:test，零第三方依赖）。
 * 覆盖：配置校验 / cooldown 三态 / 路由收敛 / 包装层全部关键语义
 * （finish 前置处理 R-1、commit-on-first-chunk R-3、看门狗 aborted 分流 R-6、
 *  force-first 真尝试 R-7、耗尽合成 error finish、WeakSet 防递归、文法唯一 finish）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { normalizeConfig, DEFAULT_CONFIG, normalizeState, quotaGroupCount, autoTuneMaxRetries } from '../lib/config.js';
import { CooldownBoard, hopKeyOf } from '../lib/cooldown.js';
import { Router } from '../lib/router.js';
import { Registry } from '../lib/registry.js';
import { createStreamWrapper } from '../lib/wrapper.js';
import { ProbeBoard, computeTrmBound } from '../lib/probe.js';
import { loadState, saveState } from '../lib/store.js';
import { dayKeyOf, stabilityGrade, DailyLedger, DailyReporter, DailyScheduler } from '../lib/daily.js';

// ---------- mock 工具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 收集 async iterable 全部分片 */
async function drain(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const log = { debug() {}, info() {}, warn() {}, error() {} };

/** 构造标准依赖（小超时便于测试看门狗） */
function makeDeps(overrides = {}) {
  const config = normalizeConfig({
    rules: [
      {
        match: { default: true },
        route: [
          { provider: 'p-a', model: 'm-1' },
          { provider: 'p-b', model: 'm-2' },
          { provider: 'p-c', model: 'm-3' },
        ],
      },
    ],
    fallbackPolicy: {
      maxRetries: 2,
      failureThreshold: 3,
      cooldownSec: 60,
      failoverSignals: ['QUOTA', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'TRANSPORT', 'SERVER', 'UNKNOWN', 'TIMEOUT'],
      allCooldownFallback: 'force-first',
    },
    firstTokenTimeoutMs: 1000,
    exhaustionWindowSec: 120,
    ...(overrides.config ?? {}),
  });
  // 测试专供：规范化后调小看门狗（绕过生产 >=1000ms 校验，加速测试）
  config.firstTokenTimeoutMs = 50;
  const router = new Router(config);
  const cooldown = new CooldownBoard(config.fallbackPolicy);
  const metrics = { sample() {}, snapshot() { return {}; } };
  const quota = { record() {} };
  return { config, router, cooldown, metrics, quota, log, ...(overrides.deps ?? {}) };
}

/** 模拟 LlmRuntime：记录 subOpts，按登记的工厂产流（重发经本 mock 再进 wrapper） */
function makeLlm(wrapperRef, streams = {}) {
  const calls = [];
  return {
    calls,
    stream(opts) {
      calls.push(opts);
      // 模拟真实 waterfall：重发流再次经过 wrapper（WeakSet 应放行）
      const factory = streams[opts.model] ?? streams.DEFAULT;
      if (!factory) throw new Error(`mock: no stream factory for ${opts.model}`);
      const g = wrapperRef.streamWrapper(opts, () => factory(opts));
      return g;
    },
  };
}

const finishStop = { type: 'finish', reason: { kind: 'stop' } };
const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };

// ---------- config ----------

test('config: 默认值与类型校验', () => {
  const c = normalizeConfig(undefined);
  assert.equal(c.propose, false);
  assert.equal(c.fallbackPolicy.maxRetries, 2);
  assert.equal(c.statusPath, '/api/model-router/status');
  assert.throws(() => normalizeConfig({ rules: [{ match: {}, route: [{ provider: 'a', model: 'b' }] }] }));
  assert.throws(() => normalizeConfig({ rules: [{ match: { default: true }, route: [] }] }));
  assert.throws(() => normalizeConfig({ fallbackPolicy: { switchAfterFirstChunk: true } }));
  assert.throws(() => normalizeConfig({ fallbackPolicy: { allCooldownFallback: 'bogus' } }));
  assert.throws(() => normalizeConfig({ firstTokenTimeoutMs: 10 }));
  const c2 = normalizeConfig({ rules: [{ match: { model: 'x' }, route: [{ provider: 'a', model: 'b', key: 'k' }] }] });
  assert.equal(c2.rules[0].route[0].key, 'k');
});

// ---------- cooldown ----------

test('cooldown: 三态状态机', () => {
  const board = new CooldownBoard({ failureThreshold: 3, cooldownSec: 10 });
  const key = hopKeyOf({ provider: 'p', model: 'm' });
  assert.equal(board.allow(key), true);
  board.onFail(key, 'QUOTA_EXCEEDED', 1000);
  board.onFail(key, 'QUOTA_EXCEEDED', 2000);
  assert.equal(board.allow(key), true); // 未达阈值仍 closed
  board.onFail(key, 'QUOTA_EXCEEDED', 3000);
  assert.equal(board.allow(key, 4000), false); // open
  assert.equal(board.allow(key, 3000 + 10000 + 1), true); // 冷却期满 → half-open 放行
  board.onFail(key, 'RATE_LIMIT', 3000 + 10000 + 2);
  assert.equal(board.allow(key, 3000 + 10000 + 3), false); // half-open 失败 → 重新 open
  board.forceReset(key);
  assert.equal(board.allow(key), true);
});

// ---------- router ----------

test('router: 匹配顺序与链耗尽收敛（R-2/R-8 汇聚点）', () => {
  const { config, router } = makeDeps();
  const seed = { provider: 'p-a', model: 'm-1' };
  // v0.2：candidates = 备用链（按策略展开、排除种子自身）
  const chain = router.candidates(seed);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].provider, 'p-b');
  assert.equal(router.pickPrimary(seed), null); // 种子已等于 explicit route[0]，不提议
  const other = router.pickPrimary({ provider: 'other', model: 'other' });
  assert.equal(other.provider, 'p-a'); // 提议 explicit route 首选

  router.recordExhausted({ code: 'QUOTA_EXCEEDED' });
  assert.equal(router.converged(), true);
  assert.equal(router.candidates(seed).length, 1); // 收敛为单候选
});

// ---------- router v0.2：策略展开 / 热更新 / pickPrimary 语义 ----------

/** 最小注册表桩（Router 只依赖 registeredPairs()） */
function makeRegistry(pairs) {
  return { registeredPairs: () => pairs };
}

function makeRouter(rules, registry) {
  const config = normalizeConfig({ rules });
  return new Router(config, registry ?? null);
}

test('router v0.2: explicit 策略排除种子自身（有/无注册表一致）', () => {
  const rule = {
    match: { default: true },
    route: [
      { provider: 'p-a', model: 'm-1' },
      { provider: 'p-b', model: 'm-2' },
      { provider: 'p-a', model: 'm-1' }, // 重复项
    ],
  };
  const seed = { provider: 'p-a', model: 'm-1' };
  assert.deepEqual(
    makeRouter([rule], null).candidates(seed),
    [{ provider: 'p-b', model: 'm-2' }],
  );
  const reg = makeRegistry([
    { provider: 'p-a', model: 'm-1' },
    { provider: 'p-b', model: 'm-2' },
  ]);
  assert.deepEqual(makeRouter([rule], reg).candidates(seed), [{ provider: 'p-b', model: 'm-2' }]);
});

test('router v0.2: same-model 跨供应商同模型，route 顺序作排序提示', () => {
  const reg = makeRegistry([
    { provider: 'p-a', model: 'm-1' },
    { provider: 'p-b', model: 'm-1' },
    { provider: 'p-c', model: 'm-1' },
    { provider: 'p-b', model: 'm-2' },
  ]);
  const rule = {
    match: { default: true },
    strategy: 'same-model',
    route: [{ provider: 'p-a', model: 'm-1' }, { provider: 'p-c', model: 'm-1' }],
  };
  const chain = makeRouter([rule], reg).candidates({ provider: 'p-a', model: 'm-1' });
  // 只取 model===m-1 且 provider!==p-a 的对；p-c 在手工 route 中 → 排前
  assert.deepEqual(chain, [
    { provider: 'p-c', model: 'm-1' },
    { provider: 'p-b', model: 'm-1' },
  ]);
});

test('router v0.2: same-provider 同供应商换模型', () => {
  const reg = makeRegistry([
    { provider: 'p-a', model: 'm-1' },
    { provider: 'p-a', model: 'm-2' },
    { provider: 'p-a', model: 'm-3' },
    { provider: 'p-b', model: 'm-1' },
  ]);
  const rule = { match: { default: true }, strategy: 'same-provider', route: [{ provider: 'p-a', model: 'm-1' }] };
  const chain = makeRouter([rule], reg).candidates({ provider: 'p-a', model: 'm-1' });
  assert.deepEqual(chain, [
    { provider: 'p-a', model: 'm-2' },
    { provider: 'p-a', model: 'm-3' },
  ]);
});

test('router v0.2: exclude-current 全表排除种子 + 上限 6', () => {
  const pairs = [];
  for (let i = 0; i < 8; i++) pairs.push({ provider: `p-${i}`, model: 'm' });
  pairs.push({ provider: 'p-a', model: 'm' });
  const reg = makeRegistry(pairs);
  const rule = { match: { default: true }, strategy: 'exclude-current', route: [{ provider: 'p-a', model: 'm' }] };
  const chain = makeRouter([rule], reg).candidates({ provider: 'p-a', model: 'm' });
  assert.equal(chain.length, 6); // EXCLUDE_CAP
  assert.ok(chain.every((h) => !(h.provider === 'p-a' && h.model === 'm')));
});

test('router v0.2: 注册表无可用扩展时回退手工 route（含目录未就绪 model:null 场景）', () => {
  const reg = makeRegistry([{ provider: 'p-a', model: null }]); // 目录未就绪
  const rule = {
    match: { default: true },
    strategy: 'same-model',
    route: [{ provider: 'p-a', model: 'm-1' }, { provider: 'p-b', model: 'm-2' }],
  };
  const chain = makeRouter([rule], reg).candidates({ provider: 'p-a', model: 'm-1' });
  assert.deepEqual(chain, [{ provider: 'p-b', model: 'm-2' }]);
});

test('router v0.2: pickPrimary 仅 explicit 提议 route[0]；非 explicit 策略不提议', () => {
  const reg = makeRegistry([{ provider: 'p-b', model: 'm-2' }]);
  const explicit = makeRouter([{ match: { default: true }, route: [{ provider: 'p-x', model: 'm-x' }] }], reg);
  assert.deepEqual(explicit.pickPrimary({ provider: 'p-a', model: 'm-1' }), { provider: 'p-x', model: 'm-x' });
  const sameModel = makeRouter(
    [{ match: { default: true }, strategy: 'same-model', route: [{ provider: 'p-x', model: 'm-x' }] }],
    reg,
  );
  assert.equal(sameModel.pickPrimary({ provider: 'p-a', model: 'm-1' }), null);
});

// ---------- v0.3：match AND 语义 + sessionIds 会话作用域 ----------

test('router v0.3: match 多条件 AND（provider+model 同时满足才命中）', () => {
  const router = makeRouter([
    { match: { provider: 'p-a', model: 'm-1' }, route: [{ provider: 'q-1', model: 'n-1' }] },
    { match: { default: true }, route: [{ provider: 'q-2', model: 'n-2' }] },
  ]);
  // provider 对、model 不对 → 落到 default 规则
  assert.deepEqual(router.candidates({ provider: 'p-a', model: 'm-x' }), [{ provider: 'q-2', model: 'n-2' }]);
  // 双条件全对 → 命中规则 1
  assert.deepEqual(router.candidates({ provider: 'p-a', model: 'm-1' }), [{ provider: 'q-1', model: 'n-1' }]);
  // v0.2 OR 语义下的「provider 或 model」如今要用两条规则表达
});

test('router v0.3: sessionIds 作用域——带 sessionId 命中，无 sessionId 不命中（提议路径）', () => {
  const router = makeRouter([
    { match: { sessionIds: ['s-1', 's-2'] }, route: [{ provider: 'q-1', model: 'n-1' }] },
    { match: { default: true }, route: [{ provider: 'q-2', model: 'n-2' }] },
  ]);
  // 故障切换路径（llm/stream 有 sessionId）
  assert.deepEqual(router.candidates({ provider: 'p-a', model: 'm-1', sessionId: 's-1' }), [{ provider: 'q-1', model: 'n-1' }]);
  assert.deepEqual(router.candidates({ provider: 'p-a', model: 'm-1', sessionId: 's-9' }), [{ provider: 'q-2', model: 'n-2' }]);
  // 提议路径（agent/request 无 sessionId）→ 会话限定规则不参与提议，落到 default 规则
  assert.deepEqual(router.pickPrimary({ provider: 'p-a', model: 'm-1' }), { provider: 'q-2', model: 'n-2' });
  assert.deepEqual(router.candidates({ provider: 'p-a', model: 'm-1' }), [{ provider: 'q-2', model: 'n-2' }]);
});

test('router v0.3: 组合作用域 模型×会话（AND）', () => {
  const router = makeRouter([
    { match: { model: 'm-1', sessionIds: ['s-1'] }, route: [{ provider: 'q-1', model: 'n-1' }] },
    { match: { default: true }, route: [{ provider: 'q-2', model: 'n-2' }] },
  ]);
  assert.deepEqual(
    router.candidates({ provider: 'p-a', model: 'm-1', sessionId: 's-1' }),
    [{ provider: 'q-1', model: 'n-1' }],
  );
  // 同模型但别的会话 → default
  assert.deepEqual(
    router.candidates({ provider: 'p-a', model: 'm-1', sessionId: 's-2' }),
    [{ provider: 'q-2', model: 'n-2' }],
  );
});

test('config v0.3: match.sessionIds 校验（合法通过、类型错误拒绝、去重）', () => {
  const ok = normalizeConfig({
    rules: [{ match: { sessionIds: ['a', 'b', 'a'] }, route: [{ provider: 'p', model: 'm' }] }],
  });
  assert.deepEqual(ok.rules[0].match.sessionIds, ['a', 'b']);
  assert.throws(() =>
    normalizeConfig({ rules: [{ match: { sessionIds: ['a', 42] }, route: [{ provider: 'p', model: 'm' }] }] }),
  );
  assert.throws(() =>
    normalizeConfig({ rules: [{ match: { sessionIds: 'not-array' }, route: [{ provider: 'p', model: 'm' }] }] }),
  );
  // 空 sessionIds 数组 = 无限定条件 → 拒绝
  assert.throws(() =>
    normalizeConfig({ rules: [{ match: { sessionIds: [] }, route: [{ provider: 'p', model: 'm' }] }] }),
  );
});

test('router v0.2: applyRuntime 热更新 propose/rules（不重置耗尽窗）', () => {
  const router = makeRouter([{ match: { default: true }, route: [{ provider: 'p-a', model: 'm-1' }] }]);
  router.recordExhausted({ code: 'QUOTA_EXCEEDED' });
  router.applyRuntime({ propose: true, rules: [{ match: { default: true }, route: [{ provider: 'q-1', model: 'n-1' }] }] });
  assert.equal(router.config.propose, true);
  assert.equal(router.config.rules[0].route[0].provider, 'q-1');
  assert.equal(router.converged(), true); // 耗尽窗保持
});

// ---------- v0.2：normalizeState / store ----------

test('normalizeState: 面板提交校验（合法通过、非法 strategy 拒绝）', () => {
  const ok = normalizeState({
    propose: true,
    rules: [{ match: { default: true }, strategy: 'exclude-current', route: [{ provider: 'a', model: 'b' }] }],
  });
  assert.equal(ok.propose, true);
  assert.equal(ok.rules[0].strategy, 'exclude-current');
  assert.throws(() => normalizeState({ propose: true, rules: [{ match: { default: true }, strategy: 'bogus', route: [{ provider: 'a', model: 'b' }] }] }));
  assert.throws(() => normalizeState(null));
});

test('store: saveState/loadState 原子往返 + 坏格式拒绝', async () => {  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'mr-store-'));
  try {
    const path = join(dir, 'state.json');
    const state = {
      propose: true,
      rules: [{ match: { default: true }, strategy: 'same-provider', route: [{ provider: 'a', model: 'b' }] }],
    };
    assert.equal(saveState(path, state, log), true);
    assert.equal(saveState(path, state, log), true); // 覆盖写（rename 原子替换）
    const loaded = loadState(path, log);
    assert.equal(loaded.propose, true);
    assert.equal(loaded.rules[0].strategy, 'same-provider');
    // 坏 version → 忽略
    writeFileSync(path, JSON.stringify({ version: 99, rules: [] }));
    assert.equal(loadState(path, log), null);
    // 不存在 → null（不抛）
    assert.equal(loadState(join(dir, 'missing.json'), log), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- wrapper ----------

test('wrapper: 首选成功 → 输出与无插件时逐分片一致（含 usage/finish）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const primary = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'hi' };
    yield usage;
    yield finishStop;
  })();
  const out = await drain(wrapper.call({ stream() {} }, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.deepEqual(out.map((c) => c.type), ['block-start', 'text-delta', 'usage', 'finish']);
  assert.equal(out.filter((c) => c.type === 'finish').length, 1);
});

test('wrapper: 首选未 commit 报 QUOTA_EXCEEDED → 切换备用成功，失败尝试分片零泄漏（R-1 主路径）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield finishStop;
    },
  });
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED', message: 'quota' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  // 失败尝试的 error finish 不应出现；输出 = 备用成功流
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']);
  assert.equal(out[1].reason.kind, 'stop');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].provider, 'p-b'); // 种子 hop 被排除，首重发 = p-b/m-2
  assert.equal(deps.cooldown.snapshot()['p-a/m-1']?.failures, 1);
  assert.equal(deps.cooldown.snapshot()['p-b/m-2']?.state, 'closed');
});

test('wrapper: 已 commit 后 error finish → 原样透传不切换（commit-on-first-chunk 硬约束）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {});
  const primary = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'partial' };
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']);
  assert.equal(out[1].reason.kind, 'error');
  assert.equal(llm.calls.length, 0); // 未重发
});

test('wrapper: 非 failover 信号错误 → 原样透传（进 agent/request-error 恢复通道）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {});
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.equal(out.length, 1);
  assert.equal(out[0].reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(llm.calls.length, 0);
});

test('wrapper: 用户 abort（未 commit）→ aborted finish 原样透传，绝不误判 TIMEOUT（R-6 反向）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {});
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.equal(out.length, 1);
  assert.equal(out[0].reason.kind, 'aborted');
  assert.equal(llm.calls.length, 0);
});

test('wrapper: 首选挂起 → 看门狗超时 → 切换备用（TIMEOUT failover 主路径，R-6）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'recovered' };
      yield finishStop;
    },
  });
  const primary = (async function* () {
    await sleep(500); // 挂起不产任何分片
    yield finishStop;
  })();
  const t0 = Date.now();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.equal(out.map((c) => c.type).join(','), 'text-delta,finish');
  assert.equal(out[1].reason.kind, 'stop');
  assert.ok(Date.now() - t0 < 400, `看门狗应在 ~50ms 触发，实际 ${Date.now() - t0}ms`);
  assert.equal(deps.cooldown.snapshot()['p-a/m-1']?.lastErrorCode, 'TIMEOUT');
});

test('wrapper: 重发候选挂起 → abort 注入 → adapter 产 aborted finish → 以 TIMEOUT 分流而非透传（R-6）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const seenSignals = [];
  const llm = makeLlm({ streamWrapper: wrapper }, {
    // mock adapter：挂起直到 signal abort，然后像 adapterFailureChunk 一样产 aborted finish
    'm-2': (opts) =>
      (async function* () {
        seenSignals.push(opts.signal);
        await new Promise((resolve) => {
          if (opts.signal.aborted) resolve();
          else opts.signal.addEventListener('abort', resolve, { once: true });
        });
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } };
      })(),
    'm-3': async function* () {
      yield { type: 'text-delta', index: 0, text: 'recovered' };
      yield finishStop;
    },
  });
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  // m-2 超时被 abort（aborted finish 被 wrapper 吃掉）→ 继续切 m-3 成功
  assert.equal(seenSignals.length, 1, 'm-2 应收到注入的 abort signal');
  assert.equal(seenSignals[0].aborted, true);
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']);
  assert.equal(out[1].reason.kind, 'stop');
  assert.equal(wrapper.stats.timeouts, 1);
  assert.equal(deps.cooldown.snapshot()['p-b/m-2']?.lastErrorCode, 'TIMEOUT');
});

test('wrapper: 候选耗尽 → 合成 error finish（真实 lastFailure.code），router 记录耗尽触发收敛', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const failer = () =>
    (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
    })();
  const llm = makeLlm({ streamWrapper: wrapper }, { DEFAULT: () => failer() });
  const primary = failer();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  const finishes = out.filter((c) => c.type === 'finish');
  assert.equal(finishes.length, 1); // 文法：恰好一个 terminal finish
  assert.equal(finishes[0].reason.kind, 'error');
  assert.equal(finishes[0].reason.failure.code, 'QUOTA_EXCEEDED'); // 保留真实错误码
  assert.equal(deps.router.converged(), true);
  // 收敛后：同种子再调用 → 链单候选 → 纯透传（不再整链重跑）
  const out2 = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, failer));
  assert.equal(out2.length, 1);
  assert.equal(out2[0].reason.failure.code, 'QUOTA_EXCEEDED');
});

test('wrapper: 候选全 cooldown + force-first → 强制尝试首选候选（R-7 真尝试）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  for (const hop of ['p-b/m-2', 'p-c/m-3']) {
    for (let i = 0; i < 3; i++) deps.cooldown.onFail(hop, 'QUOTA_EXCEEDED');
  }
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'forced' };
      yield finishStop;
    },
  });
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']); // 强制重试成功
  assert.equal(wrapper.stats.forced, 1);
});

test('wrapper: 候选全 cooldown + fail → 合成 NO_CANDIDATE，不发起尝试', async () => {
  const deps = makeDeps({
    config: { fallbackPolicy: { allCooldownFallback: 'fail' } },
  });
  const wrapper = createStreamWrapper(deps);
  for (const hop of ['p-b/m-2', 'p-c/m-3']) {
    for (let i = 0; i < 3; i++) deps.cooldown.onFail(hop, 'QUOTA_EXCEEDED');
  }
  const llm = makeLlm({ streamWrapper: wrapper }, {});
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.equal(out.length, 1);
  assert.equal(out[0].reason.failure.code, 'QUOTA_EXCEEDED'); // 首选真实错误透传
  assert.equal(llm.calls.length, 0);
});

test('wrapper: WeakSet 防递归——重发流经 mock waterfall 再入 wrapper 时放行', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield finishStop;
    },
  });
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']); // 未被无限递归拦截
  assert.equal(wrapper.stats.wraps, 1); // 仅首选计 1 次包装；重发子流在计数前即 WeakSet 早退
});

test('wrapper: markAgentLoopRequest 品牌重打在重发 subOpts 上', async () => {
  const { markAgentLoopRequest, isAgentLoopRequest } = await import('@deepseek-ai/dsh-llm');
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  let captured = null;
  const llm = {
    stream(opts) {
      if (!captured) captured = opts;
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'x' };
        yield finishStop;
      })();
    },
  };
  const seedOpts = markAgentLoopRequest({ provider: 'p-a', model: 'm-1' });
  await drain(wrapper.call(llm, seedOpts, () =>
    (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
    })(),
  ));
  assert.ok(captured, '应有重发调用');
  assert.equal(isAgentLoopRequest(captured), true, '重发 subOpts 须重打品牌');
});

test('wrapper: maxRetries=0 → 不重发，首选错误原样透传', async () => {
  const deps = makeDeps({ config: { fallbackPolicy: { maxRetries: 0 } } });
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {});
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.equal(out.length, 1);
  assert.equal(out[0].reason.failure.code, 'QUOTA_EXCEEDED');
  assert.equal(llm.calls.length, 0);
  assert.equal(deps.router.converged(), true); // 链耗尽仍应记录
});

test('metrics v0.3: 记录 sessionId 并在 snapshot 暴露最近活跃会话（新→旧去重）', async () => {
  const { Metrics } = await import('../lib/metrics.js');
  const m = new Metrics();
  m.sample({ provider: 'p-a', model: 'm-1', attemptIndex: 0, outcome: 'committed', sessionId: 's-1' });
  m.sample({ provider: 'p-a', model: 'm-1', attemptIndex: 0, outcome: 'committed', sessionId: 's-2' });
  m.sample({ provider: 'p-a', model: 'm-1', attemptIndex: 0, outcome: 'committed', sessionId: 's-1' });
  m.sample({ provider: 'p-a', model: 'm-1', attemptIndex: 0, outcome: 'committed' });
  const snap = m.snapshot();
  assert.deepEqual(snap.sessionIds, ['s-1', 's-2']); // 新→旧、去重、无 sessionId 的不计
  assert.equal(snap.recent.every((r) => typeof r.seq === 'number'), true);
});

// ---------- v0.3.1 复核修复回归 ----------

test('复核 F-1: 看门狗触发窗口与首分片竞态——commit 后绝不切换（无双流拼接）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'recovered' };
      yield finishStop;
    },
  });
  // 首分片立即到达（commit）→ 之后挂起 200ms（远超 50ms 看门狗）→ 继续正常收尾
  const primary = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'first' };
    await sleep(200);
    yield { type: 'text-delta', index: 0, text: 'second' };
    yield finishStop;
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  // 修复前：看门狗 50ms 触发 → 切 m-2 → 输出 = first + recovered 拼接（文法违规）
  // 修复后：commit 即免疫看门狗，primary 流完整走完，零重发
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'text-delta', 'finish']);
  assert.equal(out.filter((c) => c.type === 'finish')[0].reason.kind, 'stop');
  assert.equal(llm.calls.length, 0, 'commit 后不得重发');
  assert.equal(wrapper.stats.failovers, 0);
});

test('复核 F-2: default 规则不再按位置短路——面板后加的作用域规则不被遮蔽', () => {
  // default 在前、限定规则在后（面板「添加规则」追加产生的真实布局）
  const router = makeRouter([
    { match: { default: true }, route: [{ provider: 'q-2', model: 'n-2' }] },
    { match: { model: 'm-1' }, route: [{ provider: 'q-1', model: 'n-1' }] },
  ]);
  // 限定规则命中（旧实现会被 default 短路遮蔽 → 死规则）
  assert.deepEqual(router.candidates({ provider: 'p-a', model: 'm-1' }), [{ provider: 'q-1', model: 'n-1' }]);
  // 其余会话回落 default
  assert.deepEqual(router.candidates({ provider: 'p-a', model: 'm-x' }), [{ provider: 'q-2', model: 'n-2' }]);
  // 提议路径同样两阶段：限定规则不中 → default 兜底
  assert.deepEqual(router.pickPrimary({ provider: 'p-a', model: 'm-1' }), { provider: 'q-1', model: 'n-1' });
});

test('复核 F-3: explicit 链重复 hop 去重（避免对同一候选重试两次）', () => {
  const rule = {
    match: { default: true },
    route: [
      { provider: 'p-b', model: 'm-2' },
      { provider: 'p-b', model: 'm-2' }, // 重复
      { provider: 'p-c', model: 'm-3' },
    ],
  };
  const chain = makeRouter([rule], null).candidates({ provider: 'p-a', model: 'm-1' });
  assert.deepEqual(chain, [
    { provider: 'p-b', model: 'm-2' },
    { provider: 'p-c', model: 'm-3' },
  ]);
});

// ==================== v0.4.0 健康探测模块 ====================

function probeLlm(byModel) {
  const calls = [];
  return {
    calls,
    stream(opts) {
      calls.push(opts);
      const gen = byModel[opts.model] ?? byModel.default;
      return gen(opts);
    },
  };
}

test('probe: TRM 边界计算——QPS 阶梯找 RPM 边界 + 安全系数 0.6', () => {
  // 复刻 trm-test 商汤场景：0.11 干净、0.12 越界 → 边界 0.11，安全 0.066
  const bound = computeTrmBound(
    [
      { qps: 0.05, success: 5, total: 5 },
      { qps: 0.1, success: 5, total: 5 },
      { qps: 0.11, success: 5, total: 5 },
      { qps: 0.12, success: 3, total: 5 },
    ],
    0.6,
  );
  assert.equal(bound.boundaryQps, 0.11);
  assert.equal(bound.safeQps, 0.066);
  assert.equal(bound.safeIntervalMs, Math.round(1000 / 0.066));
  // 首档即失败 → 无边界
  const none = computeTrmBound([{ qps: 0.05, success: 2, total: 5 }], 0.6);
  assert.equal(none.boundaryQps, null);
  assert.equal(none.safeQps, null);
});

test('probe: runProbe 成功/失败记录健康状态（up/degraded/down + 连续失败）', async () => {
  const board = new ProbeBoard(log, { timeoutMs: 2000 });
  const llm = probeLlm({
    'm-ok': async function* () {
      yield { type: 'text-delta', index: 0, text: 'pong' };
      yield finishStop;
    },
    'm-bad': async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } };
    },
  });
  // 成功 → up + TTFT 记录
  const ok = await board.runProbe(llm, 'p-a', 'm-ok');
  assert.equal(ok.ok, true);
  assert.equal(board.healthOf('p-a', 'm-ok').status, 'up');
  assert.equal(typeof board.healthOf('p-a', 'm-ok').ttftMs, 'number');
  // 探测走 llm.stream 且带跳过标记（不进 failover 包装）
  assert.equal(llm.calls[0].provider, 'p-a');
  assert.ok(llm.calls[0].__mr_probe);
  // 1 次失败 → degraded；连续 3 次 → down
  await board.runProbe(llm, 'p-b', 'm-bad');
  assert.equal(board.healthOf('p-b', 'm-bad').status, 'degraded');
  await board.runProbe(llm, 'p-b', 'm-bad');
  await board.runProbe(llm, 'p-b', 'm-bad');
  const down = board.healthOf('p-b', 'm-bad');
  assert.equal(down.status, 'down');
  assert.equal(down.consecutiveFails, 3);
  assert.equal(down.lastError, 'RATE_LIMIT');
});

test('probe: __mr_probe 标记 → wrapper 直透不做 failover（探针必须测到目标本身）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {});
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
  })();
  // 对照：无标记时同场景会切到 p-b（见 R-1 主路径用例）
  const out = await drain(
    wrapper.call(llm, { provider: 'p-a', model: 'm-1', __mr_probe: true }, () => primary),
  );
  assert.equal(out.length, 1, '原样透传，未被重定向到兜底');
  assert.equal(out[0].reason.kind, 'error');
  assert.equal(llm.calls.length, 0, '零重发');
  assert.equal(deps.cooldown.snapshot()['p-a/m-1'], undefined, '不触发 cooldown 记账');
});

test('router: healthReorder——down 排末、同档延迟低优先、无探测数据保序', () => {
  const probe = new ProbeBoard(log);
  probe._record('p-a', 'm-1', { ok: true, ttftMs: 200, lastProbeAt: 'x' }); // 健康·慢
  probe._record('p-b', 'm-2', { ok: false, errorCode: 'RATE_LIMIT', lastProbeAt: 'x' }); // 降级
  probe._record('p-c', 'm-3', { ok: true, ttftMs: 50, lastProbeAt: 'x' }); // 健康·快
  const rules = [
    {
      match: { default: true },
      route: [
        { provider: 'p-a', model: 'm-1' },
        { provider: 'p-b', model: 'm-2' },
        { provider: 'p-c', model: 'm-3' },
      ],
    },
  ];
  const router = new Router(normalizeConfig({ rules }), null, probe);
  const chain = router.candidates({ provider: 'seed', model: 'seed' });
  assert.deepEqual(chain.map((h) => h.provider), ['p-c', 'p-a', 'p-b']);
  // 无健康记录的新候选（p-d）rank=0 → 按原顺序与 p-c 竞争（ttft=Infinity 在后）
  probe._record('p-c', 'm-3', { ok: true, ttftMs: 50, lastProbeAt: 'x' });
  const routerNoProbe = new Router(normalizeConfig({ rules }), null, null);
  const plain = routerNoProbe.candidates({ provider: 'seed', model: 'seed' });
  assert.deepEqual(plain.map((h) => h.provider), ['p-a', 'p-b', 'p-c'], '未接探测时保序');
});

test('config: probe 配置默认关闭 + 非法值 fail-fast', () => {
  const cfg = normalizeConfig({ rules: [] });
  assert.equal(cfg.probe.enabled, false);
  assert.equal(cfg.probe.intervalSec, 300);
  assert.throws(() => normalizeConfig({ rules: [], probe: { intervalSec: 5 } }), /intervalSec/);
  assert.throws(() => normalizeConfig({ rules: [], probe: { timeoutMs: 100 } }), /timeoutMs/);
  assert.throws(() => normalizeConfig({ rules: [], probe: { prompt: '' } }), /prompt/);
  const on = normalizeConfig({ rules: [], probe: { enabled: true, intervalSec: 60 } });
  assert.equal(on.probe.enabled, true);
  assert.equal(on.probe.intervalSec, 60);
});

test('v0.4.1: 空 sessionIds 明确拒绝（含与其他条件组合的 AND 死规则）', () => {
  // 纯空 sessionIds：旧报错「须含 provider/model/sessionIds 之一」让人摸不着头脑
  assert.throws(
    () => normalizeConfig({ rules: [{ match: { sessionIds: [] }, route: [{ provider: 'p', model: 'm' }] }] }),
    /空数组/,
  );
  // 与 model 组合的空 sessionIds 同样是死规则（AND 语义下永不命中）
  assert.throws(
    () => normalizeConfig({ rules: [{ match: { model: 'm-1', sessionIds: [] }, route: [{ provider: 'p', model: 'm' }] }] }),
    /空数组/,
  );
  // 正常 sessionIds 不受影响
  const ok = normalizeConfig({
    rules: [{ match: { sessionIds: ['s-1'] }, route: [{ provider: 'p', model: 'm' }] }],
  });
  assert.deepEqual(ok.rules[0].match.sessionIds, ['s-1']);
});

test('metrics v0.4.2: noteSession 透传路径捕捉会话（新→旧去重 + 容量上限）', async () => {
  const { Metrics } = await import('../lib/metrics.js');
  const m = new Metrics();
  m.noteSession('s-a');
  m.noteSession('s-b');
  m.noteSession('s-a'); // 重复 → 移到最新
  m.noteSession(undefined);
  m.noteSession(42);
  assert.deepEqual(m.snapshot().sessionIds, ['s-a', 's-b']); // 新→旧、去重、非法值忽略
  // 容量：内部 30、快照暴露 10
  for (let i = 0; i < 35; i++) m.noteSession('gen-' + i);
  assert.equal(m.sessions.size, 30);
  assert.equal(m.snapshot().sessionIds.length, 10);
  assert.equal(m.snapshot().sessionIds[0], 'gen-34'); // 最新在前
});

// ==================== v0.5.0 时间窗（峰谷定价） ====================

test('router v0.5.0: localHHMM/inTimeWindow——时区确定性换算与跨零点窗', async () => {
  const { localHHMM, inTimeWindow } = await import('../lib/router.js');
  // 2026-09-04T16:30:00Z = 上海 00:30（次日）/ UTC 16:30
  const t = new Date('2026-09-04T16:30:00Z');
  assert.equal(localHHMM('Asia/Shanghai', t), '00:30');
  assert.equal(localHHMM('UTC', t), '16:30');
  // DeepSeek 式谷时窗 00:30–08:30：上海 00:30 命中，UTC 16:30 不命中
  const offpeak = { start: '00:30', end: '08:30' };
  assert.equal(inTimeWindow(offpeak, 'Asia/Shanghai', t), true);
  assert.equal(inTimeWindow(offpeak, 'UTC', t), false);
  // 跨零点窗 22:00–08:00：上海 00:30 命中；同日窗 09:00–18:00 不命中
  assert.equal(inTimeWindow({ start: '22:00', end: '08:00' }, 'Asia/Shanghai', t), true);
  assert.equal(inTimeWindow({ start: '09:00', end: '18:00' }, 'Asia/Shanghai', t), false);
});

test('router v0.5.0: matchRule 时间窗门控——双 default 按窗口择一', () => {
  const router = makeRouter([
    { match: { default: true, hours: { start: '00:30', end: '08:30' } }, route: [{ provider: 'q-off', model: 'n-off' }] },
    { match: { default: true }, route: [{ provider: 'q-peak', model: 'n-peak' }] },
  ]);
  // 谷时（上海 00:30）→ 第一条 default（谷价路由）
  router._now = new Date('2026-09-04T16:30:00Z');
  assert.deepEqual(router.candidates({ provider: 'p', model: 'm' }), [{ provider: 'q-off', model: 'n-off' }]);
  // 峰时（上海 12:00）→ 窗外 default 跳过，落纯 default
  router._now = new Date('2026-09-04T04:00:00Z');
  assert.deepEqual(router.candidates({ provider: 'p', model: 'm' }), [{ provider: 'q-peak', model: 'n-peak' }]);
  router._now = null;
});

test('config v0.5.0: hours/timeZone 校验（fail-fast）', () => {
  assert.throws(
    () => normalizeConfig({ rules: [{ match: { hours: { start: '25:00', end: '08:00' } }, route: [{ provider: 'p', model: 'm' }] }] }),
    /HH:MM/,
  );
  assert.throws(
    () => normalizeConfig({ rules: [{ match: { hours: { start: '08:00', end: '08:00' } }, route: [{ provider: 'p', model: 'm' }] }] }),
    /不能相同/,
  );
  assert.throws(() => normalizeConfig({ rules: [], timeZone: 'Mars/Olympus' }), /IANA/);
  // hours 可独立作为条件；default+hours 合法；显式时区合法；缺省为 null（系统时区）
  const ok = normalizeConfig({
    rules: [
      { match: { hours: { start: '22:00', end: '08:00' } }, route: [{ provider: 'p', model: 'm' }] },
      { match: { default: true, hours: { start: '00:30', end: '08:30' } }, route: [{ provider: 'p2', model: 'm2' }] },
    ],
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(ok.rules[0].match.hours.start, '22:00');
  assert.equal(ok.timeZone, 'Asia/Shanghai');
  assert.equal(normalizeConfig({ rules: [] }).timeZone, null);
});

// ==================== v0.5.1 会话标题（面板「指定会话」显示标题） ====================

test('titles v0.5.1: foldSessionTitle——last-wins 折叠与异常输入', async () => {
  const { foldSessionTitle } = await import('../lib/titles.js');
  // 无标题事件 → null；非数组 → null
  assert.equal(foldSessionTitle([{ type: 'user/message', data: {} }]), null);
  assert.equal(foldSessionTitle(undefined), null);
  assert.equal(foldSessionTitle('nope'), null);
  // last-wins：取最后一条 session/title
  const events = [
    { type: 'session/title', data: { title: '旧标题' } },
    { type: 'user/message', data: {} },
    { type: 'session/title', data: { title: '新标题' } },
  ];
  assert.equal(foldSessionTitle(events), '新标题');
  // 空标题 / 非字符串标题 → null
  assert.equal(foldSessionTitle([{ type: 'session/title', data: { title: '' } }]), null);
  assert.equal(foldSessionTitle([{ type: 'session/title', data: {} }]), null);
});

test('titles v0.6.0: makeSessionTitleResolver 两级——live 命中 + sessionQuery 持久化兜底', async () => {
  const { makeSessionTitleResolver } = await import('../lib/titles.js');
  const fakeSession = (title) => ({
    events: title === undefined ? [] : [{ type: 'session/title', data: { title } }],
  });
  const store = {
    get(id) {
      if (id === 's1') return fakeSession('修 YOLO 数据集');   // live 命中
      return undefined; // s2/s3 不在 live store
    },
  };
  // sessionQuery 引擎：s2 返回快照对象形态（dsh-session-title），s3 rejected
  const queryEngine = {
    async readTitleSnapshots(ids) {
      return ids.map((id) =>
        id === 's2'
          ? { status: 'fulfilled', value: { session: {}, title: { title: '持久化兜底标题', messageSeqs: [1], source: { kind: 'fallback' } } } }
          : { status: 'rejected', reason: new Error('not found') },
      );
    },
  };
  const resolve = makeSessionTitleResolver(store, () => queryEngine, null, {});
  assert.deepEqual(await resolve(['s1', 's2', 's3']), [
    { id: 's1', title: '修 YOLO 数据集' },
    { id: 's2', title: '持久化兜底标题' },
    { id: 's3', title: null },
  ]);
  // 引擎未挂载（getQuery → undefined）→ live 未命中的全 null，不抛
  const resolveNoQ = makeSessionTitleResolver(store, () => undefined, null, {});
  assert.deepEqual(await resolveNoQ(['s2']), [{ id: 's2', title: null }]);
  // getQuery 本身抛异常也不影响
  const resolveBadQ = makeSessionTitleResolver(store, () => { throw new Error('boom'); }, null, {});
  assert.deepEqual(await resolveBadQ(['s2']), [{ id: 's2', title: null }]);
  // 空入参
  assert.deepEqual(await resolve([]), []);
  // 惰性函数形式：store 每次查询现取
  let calls = 0;
  const lazy = makeSessionTitleResolver(() => { calls += 1; return store; }, () => undefined, null, {});
  await lazy(['s1']);
  assert.equal(calls, 1);
});

test('metrics v0.5.1: snapshot().sessions——新→旧 + 时间戳，回退路径含 id', async () => {
  const { Metrics } = await import('../lib/metrics.js');
  const m = new Metrics();
  m.noteSession('a');
  m.noteSession('b');
  m.noteSession('a'); // a 刷新到最新
  const snap = m.snapshot();
  assert.deepEqual(snap.sessions.map((s) => s.id), ['a', 'b']);
  assert.equal(typeof snap.sessions[0].ts, 'number');
  // sample 内部先 noteSession，故走主路径（带 ts）；回退路径仅在旧数据（无 sessions 表）触发
  const m2 = new Metrics();
  m2.sample({ provider: 'p', model: 'm', attemptIndex: 0, outcome: 'committed', sessionId: 'ring-1' });
  const snap2 = m2.snapshot();
  assert.deepEqual(snap2.sessions.map((s) => s.id), ['ring-1']);
  assert.equal(typeof snap2.sessions[0].ts, 'number');
});

// ==================== v0.6.0 commit-on-substantive + 信号表对齐 ====================

test('wrapper v0.6.0: 结构性分片后报 QUOTA → failover，缓冲分片零泄漏（429 实机场景）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'rescued' };
      yield finishStop;
    },
  });
  // 网关先发无内容分片（block-start/usage）再报 429——v0.5 在此 commit 后只能透传
  const primary = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield usage;
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: '429' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  // 首选的结构性分片（block-start/usage）不得出现在输出
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']);
  assert.equal(out[0].text, 'rescued');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].provider, 'p-b');
  assert.equal(deps.metrics, deps.metrics);
});

test('wrapper v0.6.0: 实质分片 commit 后中途 QUOTA → 仍透传（文法硬约束不变）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {});
  const primary = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'partial' };
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  // text-delta 已实质 commit：冲刷缓冲后透传，绝不切换（避免两流拼接）
  assert.deepEqual(out.map((c) => c.type), ['block-start', 'text-delta', 'finish']);
  assert.equal(out[2].reason.kind, 'error');
  assert.equal(llm.calls.length, 0);
});

test('wrapper v0.6.0: 仅结构性分片 + stop finish → 冲刷缓冲后透传（文法完整）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {});
  const primary = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield finishStop;
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.deepEqual(out.map((c) => c.type), ['block-start', 'finish']);
});

test('wrapper v0.6.0: 空 delta 不 commit（reasoning-delta 空 text = 结构性）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield finishStop;
    },
  });
  const primary = (async function* () {
    yield { type: 'reasoning-delta', index: 0, text: '' };
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']);
  assert.equal(llm.calls.length, 1);
});

test('wrapper v0.6.0: chunkSubstantive 分类表', async () => {
  const { chunkSubstantive } = await import('../lib/wrapper.js');
  assert.equal(chunkSubstantive({ type: 'block-start', index: 0, blockType: 'text' }), false);
  assert.equal(chunkSubstantive({ type: 'usage', usage: {} }), false);
  assert.equal(chunkSubstantive({ type: 'text-delta', index: 0, text: '' }), false);
  assert.equal(chunkSubstantive({ type: 'text-delta', index: 0, text: 'x' }), true);
  assert.equal(chunkSubstantive({ type: 'reasoning-delta', index: 0, text: 'x' }), true);
  assert.equal(chunkSubstantive({ type: 'tool-call-delta', index: 0, id: 't', argumentsDelta: '' }), true);
  // block-end：空文本块 = 结构性；有内容/tool-call = 实质
  assert.equal(chunkSubstantive({ type: 'block-end', index: 0, block: { type: 'text', text: '' } }), false);
  assert.equal(chunkSubstantive({ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }), true);
  assert.equal(chunkSubstantive({ type: 'block-end', index: 0, block: { type: 'tool-call' } }), true);
});

test('config v0.6.0: failoverSignals 默认表含 QUOTA/TRANSPORT/SERVER/UNKNOWN（实机错误码对齐）', () => {
  const s = normalizeConfig(undefined).fallbackPolicy.failoverSignals;
  for (const code of ['QUOTA', 'TRANSPORT', 'SERVER', 'UNKNOWN', 'TIMEOUT', 'EMPTY_RESPONSE']) {
    assert.equal(s.includes(code), true, `missing ${code}`);
  }
});

test('routes v0.6.0: 状态响应复用注入后的 ms——会话标题真实进入响应（防二次 snapshot 回潮）', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  let snapCalls = 0;
  const metrics = {
    snapshot() {
      snapCalls += 1;
      return { recent: [], byRoute: {}, sessionIds: ['s1'], sessions: [{ id: 's1', ts: 1 }] };
    },
  };
  const routes = makeStatusRoutes({
    config: { statusPath: '/api/model-router/status', rules: [], fallbackPolicy: {}, probe: {}, timeZone: null, storePath: '' },
    router: { snapshot() { return {}; }, recordExhausted() {} },
    cooldown: { snapshot() { return {}; } },
    metrics,
    quota: { snapshot() { return {}; } },
    registry: null,
    probe: null,
    llm: {},
    wrapperStats: {},
    startedAt: Date.now(),
    resolveSessions: (ids) => ids.map((id) => ({ id, title: '标题-' + id })),
    saveStateFn: () => {},
    log,
  });
  const statusRoute = routes.find((r) => r.path === '/api/model-router/status');
  assert.ok(statusRoute, 'status route missing');
  const req = {
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081' },
  };
  let body;
  const res = { writeHead() {}, setHeader() {}, end(b) { body = JSON.parse(b); } };
  await statusRoute.handler(req, res);
  assert.equal(body.ok, true);
  assert.equal(snapCalls, 1, 'metrics.snapshot 必须只调一次（注入结果直接进响应）');
  assert.equal(body.metrics.sessions[0].title, '标题-s1');
});

test('titles v0.6.0: 第 3 级持久化日志直读——zstd 容器解码 + mtime 缓存', async () => {
  const zlib = await import('node:zlib');
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    return; // Node 缺内置 zstd 时跳过
  }
  const { makeSessionTitleResolver } = await import('../lib/titles.js');
  const { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'mr-titles-'));
  try {
    // 构造 dsh 持久化布局：<dir>/<slug>/session-p1/session.jsonl.zstd（拼接两帧）
    const sid = 'p1';
    const sessionDir = join(dir, '--Volumes-Public-dsh-dsh工作台--', `session-${sid}`);
    mkdirSync(sessionDir, { recursive: true });
    const header = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ session: 1 }) + '\n', 'utf8'));
    const dataLines = [
      JSON.stringify({ type: 'user/message', seq: 8, data: {} }),
      JSON.stringify({ type: 'session/title', seq: 11, data: { title: '持久化直读标题', messageSeqs: [8], source: { kind: 'fallback' } } }),
      JSON.stringify({ type: 'session/title-llm-request', seq: 14, data: {} }),
      JSON.stringify({ type: 'user/message', seq: 20, data: {} }),
    ].join('\n') + '\n';
    const data = zlib.zstdCompressSync(Buffer.from(dataLines, 'utf8'));
    const logPath = join(sessionDir, 'session.jsonl.zstd');
    writeFileSync(logPath, Buffer.concat([header, data]));
    const mtimeMs = statSync(logPath).mtimeMs;

    const resolve = makeSessionTitleResolver(() => undefined, () => undefined, dir, {});
    const out = await resolve([sid]);
    assert.deepEqual(out, [{ id: sid, title: '持久化直读标题' }]);
    // mtime 未变 → 走缓存（结果一致）
    assert.deepEqual(await resolve([sid]), [{ id: sid, title: '持久化直读标题' }]);
    // 无此会话 → null
    assert.deepEqual(await resolve(['ghost']), [{ id: 'ghost', title: null }]);
    void mtimeMs;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ==================== v0.6.1 配额感知冷却 + 首选跳过 + 总预算 ====================

test('cooldown v0.6.1: QUOTA 一次即熔断且冷却 10 分钟；RATE_LIMIT 走常规阈值', async () => {
  const { CooldownBoard } = await import('../lib/cooldown.js');
  const board = new CooldownBoard({ failureThreshold: 3, cooldownSec: 60, quotaFailureThreshold: 1, quotaCooldownSec: 600 });
  // QUOTA：1 次即 open，冷却 600s 内不放行
  board.onFail('k1', 'QUOTA', 1000);
  let snap = board.snapshot()['k1'];
  assert.equal(snap.state, 'open');
  assert.equal(board.allow('k1', 1000 + 60_000), false, 'QUOTA 冷却 60s 不应放行（须 600s）');
  assert.equal(board.allow('k1', 1000 + 600_000), true, 'QUOTA 冷却 600s 后应转 half-open 放行');
  // RATE_LIMIT：常规阈值 3 次，60s 冷却
  board.onFail('k2', 'RATE_LIMIT', 1000);
  board.onFail('k2', 'RATE_LIMIT', 2000);
  assert.equal(board.snapshot()['k2'].state, 'closed');
  board.onFail('k2', 'RATE_LIMIT', 3000);
  assert.equal(board.snapshot()['k2'].state, 'open');
  assert.equal(board.allow('k2', 3000 + 30_000), false, 'RATE_LIMIT 冷却 60s 未满不放行');
  assert.equal(board.allow('k2', 3000 + 60_000), true, 'RATE_LIMIT 冷却 60s 期满放行');
});

test('wrapper v0.6.1: 首选被熔断 → 跳过首选直接从可用候选发起（不撞已耗尽上游）', async () => {
  const deps = makeDeps();
  // 预置：首选 p-a/m-1 已因 QUOTA 熔断（阈值 1）
  deps.cooldown.onFail('p-a/m-1', 'QUOTA');
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'skipped-primary' };
      yield finishStop;
    },
  });
  let primaryRan = false;
  const primary = (async function* () { primaryRan = true; yield finishStop; })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  // 首选未被调用；首次尝试 = p-b/m-2（经 llm.stream）
  assert.equal(primaryRan, false);
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].provider, 'p-b');
});

test('wrapper v0.6.1: 首选熔断且无可用候选（allCooldownFallback=fail）→ 纯透传兜底', async () => {
  const deps = makeDeps();
  deps.config.fallbackPolicy.allCooldownFallback = 'fail';
  deps.cooldown.onFail('p-a/m-1', 'QUOTA');
  deps.cooldown.onFail('p-b/m-2', 'QUOTA');
  deps.cooldown.onFail('p-c/m-3', 'QUOTA');
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {});
  const primary = (async function* () { yield { type: 'text-delta', index: 0, text: 'passthrough' }; yield finishStop; })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  // 兜底透传：至少尝试一次（首选），不静默失败
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']);
  assert.equal(llm.calls.length, 0);
});

test('wrapper v0.6.1: 总预算限制——第二跳看门狗被预算压缩（挂起不超预算）', async () => {
  const deps = makeDeps();
  deps.config.firstTokenTimeoutMs = 1000;
  deps.config.failoverBudgetMs = 1500;
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {
    // 第二候选挂起 800ms > 剩余预算 500ms → 应在 ~500ms 被 TIMEOUT 切走
    'm-2': (opts) => (async function* () { await sleep(800); yield finishStop; })(),
    'm-3': async function* () {
      yield { type: 'text-delta', index: 0, text: 'in-budget' };
      yield finishStop;
    },
  });
  const t0 = Date.now();
  const primary = (async function* () { await sleep(1100); yield finishStop; })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  const elapsed = Date.now() - t0;
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']);
  assert.equal(out[0].text, 'in-budget');
  // 1000(首选超时) + ~500(预算压缩的第二跳) < 2s（若无预算会是 1000+800+）
  assert.ok(elapsed < 2000, `应在预算内完成，实际 ${elapsed}ms`);
  assert.equal(llm.calls.length, 2);
});

// ==================== v0.7.0 优先模式 ====================

test('modes v0.7.0: applyModeOverrides——预设覆盖等待参数、不动 maxRetries 与规则', async () => {
  const { applyModeOverrides, MODE_PRESETS, VALID_MODES } = await import('../lib/modes.js');
  assert.deepEqual([...VALID_MODES].sort(), ['balanced', 'fast', 'stable']);
  const cfg = {
    mode: 'balanced',
    firstTokenTimeoutMs: 30000,
    failoverBudgetMs: 90000,
    fallbackPolicy: { cooldownSec: 60, quotaCooldownSec: 600, maxRetries: 4 },
  };
  applyModeOverrides(cfg, 'stable');
  assert.equal(cfg.mode, 'stable');
  assert.equal(cfg.firstTokenTimeoutMs, 60000);
  assert.equal(cfg.failoverBudgetMs, 300000);
  assert.equal(cfg.fallbackPolicy.cooldownSec, 120);
  assert.equal(cfg.fallbackPolicy.quotaCooldownSec, 900);
  assert.equal(cfg.fallbackPolicy.maxRetries, 4, '模式不得触碰 maxRetries（链深度属用户规则设计）');
  applyModeOverrides(cfg, 'fast');
  assert.equal(cfg.firstTokenTimeoutMs, 15000);
  assert.equal(cfg.fallbackPolicy.quotaCooldownSec, 300);
  // 非法模式 no-op
  applyModeOverrides(cfg, 'bogus');
  assert.equal(cfg.mode, 'fast');
  void MODE_PRESETS;
});

test('config v0.7.0: mode 校验（非法拒绝、合法通过、normalizeState 透传）', () => {
  assert.throws(() => normalizeConfig({ rules: [], mode: 'turbo' }), /mode 须为/);
  assert.equal(normalizeConfig({ rules: [], mode: 'stable' }).mode, 'stable');
  assert.equal(normalizeConfig({ rules: [] }).mode, 'balanced');
  const st = normalizeState({ propose: false, rules: [], mode: 'fast' });
  assert.equal(st.mode, 'fast');
  assert.throws(() => normalizeState({ propose: false, rules: [], mode: 'xxx' }));
});

test('cooldown v0.7.0: applyPolicy 热更新阈值/冷却，open 态保留生效中的冷却时长', async () => {
  const { CooldownBoard } = await import('../lib/cooldown.js');
  const board = new CooldownBoard({ failureThreshold: 3, cooldownSec: 60, quotaFailureThreshold: 1, quotaCooldownSec: 600 });
  board.onFail('k', 'QUOTA', 1000); // open，activeCooldownMs=600s
  assert.equal(board.allow('k', 1000 + 120_000), false);
  // 切到 fast：quotaCooldown 300s —— 已 open 的保留 600s（不重置进行中的熔断）
  board.applyPolicy({ failureThreshold: 3, cooldownSec: 30, quotaFailureThreshold: 1, quotaCooldownSec: 300 });
  assert.equal(board.allow('k', 1000 + 400_000), false, '已 open 的保留旧冷却 600s');
  assert.equal(board.allow('k', 1000 + 600_000), true);
  // 重新 open 后采用新时长
  board.onFail('k', 'QUOTA', 1_000_000);
  assert.equal(board.allow('k', 1_000_000 + 310_000), true, '新 open 采用 fast 档 300s 冷却');
  assert.equal(board.circuits.get('k').cooldownMs, 30_000);
});

// ---------- v0.8.0 批 2：C-2 元数据 / C-1 quotaGroup 去重 / A-3 自动调优 ----------

/** Registry 最小 llm 桩（只依赖 adapters.keys()/listConfigurableProviders/listModels） */
function makeRegistryLlm(providers) {
  return {
    adapters: new Map(providers.map((p) => [p.provider, {}])),
    listConfigurableProviders: () =>
      providers.map((p) => ({ provider: p.provider, displayName: p.displayName ?? null })),
    listModels: async (provider) => providers.find((p) => p.provider === provider)?.models ?? [],
  };
}

test('registry v0.8.0 C-2: registeredPairs 携带元数据（providerMeta 兜底 + route 内联优先）', async () => {
  const cfg = normalizeConfig({
    providerMeta: { 'p-a': { quotaGroup: 'g1', tier: 'free' } },
    rules: [
      {
        match: { default: true },
        route: [
          { provider: 'p-a', model: 'm-1' }, // 无内联 → providerMeta 兜底
          { provider: 'p-b', model: 'm-2', quotaGroup: 'g2', tier: 'paid-baseline' }, // 内联优先
          { provider: 'p-c', model: 'm-3' }, // 无任何元数据
        ],
      },
    ],
  });
  const llm = makeRegistryLlm([
    { provider: 'p-a', models: [{ id: 'm-1' }] },
    { provider: 'p-b', models: [{ id: 'm-2' }] },
    { provider: 'p-c', models: [{ id: 'm-3' }] },
  ]);
  const reg = new Registry(llm, log, 300, cfg);
  reg.refreshProviders();
  await reg.refreshModels();
  const pairs = reg.registeredPairs();
  assert.deepEqual(
    pairs.map((p) => ({ provider: p.provider, model: p.model, quotaGroup: p.quotaGroup, tier: p.tier })),
    [
      { provider: 'p-a', model: 'm-1', quotaGroup: 'g1', tier: 'free' },
      { provider: 'p-b', model: 'm-2', quotaGroup: 'g2', tier: 'paid-baseline' },
      { provider: 'p-c', model: 'm-3', quotaGroup: undefined, tier: undefined },
    ],
  );
});

test('registry v0.8.0 C-2: metaSnapshot——未声明元数据不列出，tier 缺省 unknown', async () => {
  const cfg = normalizeConfig({
    providerMeta: { 'p-a': { quotaGroup: 'g1' } }, // 无 tier → unknown
    rules: [{ match: { default: true }, route: [{ provider: 'p-b', model: 'm-2', tier: 'free' }] }],
  });
  const llm = makeRegistryLlm([
    { provider: 'p-a', models: [] },
    { provider: 'p-b', models: [] },
    { provider: 'p-c', models: [] }, // 未声明 → 不列出
  ]);
  const reg = new Registry(llm, log, 300, cfg);
  reg.refreshProviders();
  await reg.refreshModels();
  const snap = reg.metaSnapshot();
  assert.deepEqual(snap, {
    'p-a': { quotaGroup: 'g1', tier: 'unknown' },
    'p-b': { quotaGroup: null, tier: 'free' },
  });
  assert.equal(snap['p-c'], undefined);
});

test('router v0.8.0 C-1: quotaGroup 去重——同组保留链序第一个（explicit 内联 4 项 → 3 项）', () => {
  const rule = {
    match: { default: true },
    route: [
      { provider: 'p-a', model: 'm-1', quotaGroup: 'g1' },
      { provider: 'p-b', model: 'm-2', quotaGroup: 'g2' },
      { provider: 'p-c', model: 'm-3', quotaGroup: 'g1' }, // 与 p-a 同组 → 去重
      { provider: 'p-d', model: 'm-4' }, // 无组 → 保留
    ],
  };
  const chain = makeRouter([rule], null).candidates({ provider: 'p-x', model: 'm-x' });
  assert.deepEqual(
    chain.map((h) => `${h.provider}/${h.model}`),
    ['p-a/m-1', 'p-b/m-2', 'p-d/m-4'],
  );
});

test('router v0.8.0 C-1: 无 quotaGroup 保序不误删', () => {
  const rule = {
    match: { default: true },
    route: [
      { provider: 'p-a', model: 'm-1' },
      { provider: 'p-b', model: 'm-2' },
      { provider: 'p-c', model: 'm-3' },
    ],
  };
  const chain = makeRouter([rule], null).candidates({ provider: 'p-x', model: 'm-x' });
  assert.deepEqual(
    chain.map((h) => `${h.provider}/${h.model}`),
    ['p-a/m-1', 'p-b/m-2', 'p-c/m-3'],
  );
});

test('router v0.8.0 C-1: same-provider 策略经注册表元数据去重', () => {
  const reg = makeRegistry([
    { provider: 'p-a', model: 'm-1', quotaGroup: 'g1' },
    { provider: 'p-a', model: 'm-2', quotaGroup: 'g1' }, // 同组 → 去重
    { provider: 'p-a', model: 'm-3' }, // 无组 → 保留
  ]);
  const rule = {
    match: { default: true },
    strategy: 'same-provider',
    route: [{ provider: 'p-a', model: 'm-1' }],
  };
  const chain = makeRouter([rule], reg).candidates({ provider: 'p-a', model: 'm-1' });
  assert.deepEqual(
    chain.map((h) => `${h.provider}/${h.model}`),
    ['p-a/m-2', 'p-a/m-3'],
  );
});

test('config v0.8.0 A-3: quotaGroupCount——providerMeta 与 route 内联并集', () => {
  const cfg = normalizeConfig({
    providerMeta: { 'p-a': { quotaGroup: 'g1' }, 'p-b': { quotaGroup: 'g2' } },
    rules: [
      {
        match: { default: true },
        route: [
          { provider: 'p-c', model: 'm-3', quotaGroup: 'g1' }, // 与 p-a 同组，不重复计数
          { provider: 'p-d', model: 'm-4', quotaGroup: 'g3' },
        ],
      },
    ],
  });
  assert.equal(quotaGroupCount(cfg), 3); // g1, g2, g3
});

test('config v0.8.0 A-3: auto-tune——未显式声明回填 max(2*count, 5)', () => {
  const cfg = normalizeConfig({
    providerMeta: { 'p-a': { quotaGroup: 'g1' }, 'p-b': { quotaGroup: 'g2' } },
    rules: [
      {
        match: { default: true },
        route: [
          { provider: 'p-a', model: 'm-1' },
          { provider: 'p-b', model: 'm-2' },
        ],
      },
    ],
  });
  assert.equal(cfg.fallbackPolicy.maxRetries, 2, '默认值');
  autoTuneMaxRetries(cfg);
  assert.equal(cfg.fallbackPolicy.maxRetries, 5, 'quotaGroupCount=2 → max(4,5)=5');
  // 单组时仍保底 5（quotaGroupCount=1 → max(2,5)=5，公式下限）
  const cfg1 = normalizeConfig({
    rules: [{ match: { default: true }, route: [{ provider: 'p-a', model: 'm-1' }] }],
  });
  autoTuneMaxRetries(cfg1);
  assert.equal(cfg1.fallbackPolicy.maxRetries, 5);
});

test('config v0.8.0 A-3: 用户显式 maxRetries=2 不被自动调优覆盖（hasExplicitMaxRetries）', () => {
  const cfg = normalizeConfig({
    fallbackPolicy: { maxRetries: 2 },
    providerMeta: { 'p-a': { quotaGroup: 'g1' }, 'p-b': { quotaGroup: 'g2' } },
    rules: [{ match: { default: true }, route: [{ provider: 'p-a', model: 'm-1' }] }],
  });
  assert.equal(cfg._hasExplicitMaxRetries, true);
  autoTuneMaxRetries(cfg);
  assert.equal(cfg.fallbackPolicy.maxRetries, 2, '显式 2 保持');
  // 未声明时标记为 false（raw 无 fallbackPolicy）
  assert.equal(normalizeConfig({ rules: [] })._hasExplicitMaxRetries, false);
  assert.equal(normalizeConfig({})._hasExplicitMaxRetries, false);
});

// ---------- v0.8.0 批 3：G1 每日报告数据层 ----------

test('daily v0.8.0 G1: dayKeyOf 时区日界换算（跨时区跨日）', () => {
  // UTC 2026-09-06T17:30:00Z → Asia/Shanghai 已是 09-07 01:30；America/Los_Angeles 仍是 09-06
  const ts = Date.parse('2026-09-06T17:30:00Z');
  assert.equal(dayKeyOf(ts, 'Asia/Shanghai'), '2026-09-07');
  assert.equal(dayKeyOf(ts, 'UTC'), '2026-09-06');
  assert.equal(dayKeyOf(ts, 'America/Los_Angeles'), '2026-09-06');
  // 无 timeZone → 系统时区（不抛错即可）
  assert.equal(typeof dayKeyOf(ts, null), 'string');
});

test('daily v0.8.0 G1: stabilityGrade 评级边界（S/A/B/C/D/N/A）', () => {
  assert.equal(stabilityGrade({ calls: 0, failed: 0 }), 'N/A');
  assert.equal(stabilityGrade({ calls: 2, failed: 0 }), 'N/A', '样本 <3 不足以评价');
  assert.equal(stabilityGrade({ calls: 3, failed: 0 }), 'S');
  assert.equal(stabilityGrade({ calls: 1000, failed: 19 }), 'A', '1.9%');
  assert.equal(stabilityGrade({ calls: 1000, failed: 20 }), 'B', '2% 边界落入 B');
  assert.equal(stabilityGrade({ calls: 1000, failed: 49 }), 'B', '4.9%');
  assert.equal(stabilityGrade({ calls: 1000, failed: 50 }), 'C', '5% 边界落入 C');
  assert.equal(stabilityGrade({ calls: 1000, failed: 149 }), 'C', '14.9%');
  assert.equal(stabilityGrade({ calls: 1000, failed: 150 }), 'D', '15% 边界落入 D');
  assert.equal(stabilityGrade({ calls: 1000, failed: 800 }), 'D', '80% 仍 D（最差档）');
});

test('daily v0.8.0 G1: aggregate 按 provider×model 聚合（含失败/切换/错误码/token/时延）', () => {
  const reporter = new DailyReporter({ ledger: null, log });
  const records = [
    { provider: 'p-a', model: 'm-1', outcome: 'committed', inSequence: false, attempts: 1, switched: false, ttftMs: 200, e2eMs: 800, tokens: { inputTokens: 10, outputTokens: 5 }, ts: 1 },
    { provider: 'p-a', model: 'm-1', outcome: 'committed', inSequence: true, attempts: 2, switched: true, ttftMs: 400, e2eMs: 1500, tokens: { inputTokens: 20, outputTokens: 10 }, ts: 2 },
    { provider: 'p-a', model: 'm-1', outcome: 'failed', inSequence: true, attempts: 3, switched: true, errorCode: 'QUOTA', e2eMs: 3000, ts: 3 },
    { provider: 'p-a', model: 'm-1', outcome: 'aborted', inSequence: false, attempts: 1, switched: false, e2eMs: 500, ts: 4 },
    { provider: 'p-b', model: 'm-2', outcome: 'committed', inSequence: false, attempts: 1, switched: false, ttftMs: 100, e2eMs: 300, tokens: { inputTokens: 5, outputTokens: 2 }, ts: 5 },
  ];
  const { summary, byProviderModel, errors } = reporter.aggregate(records);
  assert.deepEqual(summary, {
    calls: 5,
    succeeded: 3,
    failed: 1,
    aborted: 1,
    inSequenceCalls: 2,
    switchedCalls: 2,
    switchCount: 3, // attempts 2+3 → (2-1)+(3-1)=3
  });
  assert.equal(byProviderModel.length, 2);
  const g1 = byProviderModel.find((g) => g.provider === 'p-a' && g.model === 'm-1');
  assert.equal(g1.calls, 4);
  assert.equal(g1.failed, 1);
  assert.equal(g1.aborted, 1);
  assert.equal(g1.succeeded, 2);
  assert.equal(g1.switchedCalls, 2);
  assert.equal(g1.avgTtftMs, 300); // (200+400)/2
  assert.equal(g1.inputTokens, 30);
  assert.equal(g1.outputTokens, 15);
  assert.equal(g1.grade, 'D'); // 4 calls 1 failed → failRate 0.25 ≥ 0.15 → D
  assert.deepEqual(g1.topErrors, [{ code: 'QUOTA', count: 1 }]);
  assert.deepEqual(errors, [{ code: 'QUOTA', count: 1 }]);
});

test('daily v0.8.0 G1: DailyLedger 追加写持久化 + 日切换 + todaySnapshot', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'mr-daily-'));
  try {
    const ledger = new DailyLedger({ storePath: join(dir, 'state.json'), timeZone: 'Asia/Shanghai', log });
    const t1 = Date.parse('2026-09-06T12:00:00+08:00');
    const t2 = Date.parse('2026-09-06T15:00:00+08:00');
    const t3 = Date.parse('2026-09-07T09:00:00+08:00');
    ledger.recordCall({ provider: 'p-a', model: 'm-1', outcome: 'committed', ts: t1 });
    ledger.recordCall({ provider: 'p-a', model: 'm-1', outcome: 'committed', ts: t2 });
    assert.equal(ledger.readDayRecords('2026-09-06').length, 2, 'NDJSON 可读回');
    assert.equal(ledger.hasData('2026-09-06'), true);
    ledger.recordCall({ provider: 'p-b', model: 'm-2', outcome: 'committed', ts: t3 });
    assert.equal(ledger.currentDay, '2026-09-07', '跨日自动切换');
    assert.equal(ledger.readDayRecords('2026-09-06').length, 2, '历史日从文件读');
    assert.equal(ledger.readDayRecords('2026-09-07').length, 1);
    const snap = ledger.todaySnapshot();
    assert.equal(snap.day, '2026-09-07');
    assert.equal(snap.calls, 1);
    assert.equal(ledger.hasReport('2026-09-06'), false);
    assert.equal(ledger.hasData('2026-09-05'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily v0.8.0 G1: DailyReporter generate/readReport/l1Summary', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'mr-daily-'));
  try {
    const ledger = new DailyLedger({ storePath: join(dir, 'state.json'), timeZone: 'Asia/Shanghai', log });
    const reporter = new DailyReporter({ ledger, log });
    // 昨日 + 前日各若干记录
    ledger.recordCall({ provider: 'p-a', model: 'm-1', outcome: 'committed', inSequence: false, attempts: 1, switched: false, ttftMs: 200, e2eMs: 800, tokens: { inputTokens: 10, outputTokens: 5 }, ts: Date.parse('2026-09-06T10:00:00+08:00') });
    ledger.recordCall({ provider: 'p-a', model: 'm-1', outcome: 'failed', inSequence: true, attempts: 2, switched: true, errorCode: 'QUOTA', ttftMs: 300, e2eMs: 2000, ts: Date.parse('2026-09-06T11:00:00+08:00') });
    ledger.recordCall({ provider: 'p-b', model: 'm-2', outcome: 'committed', inSequence: false, attempts: 1, switched: false, ttftMs: 100, e2eMs: 400, tokens: { inputTokens: 5, outputTokens: 2 }, ts: Date.parse('2026-09-05T10:00:00+08:00') });
    // 当日
    ledger.recordCall({ provider: 'p-c', model: 'm-3', outcome: 'committed', inSequence: false, attempts: 1, switched: false, tokens: { inputTokens: 7, outputTokens: 3 }, ts: Date.parse('2026-09-07T10:00:00+08:00') });

    const report = reporter.generate('2026-09-06');
    assert.equal(report.summary.calls, 2);
    assert.equal(report.byProviderModel.length, 1);
    assert.equal(report.byProviderModel[0].grade, 'N/A', '2 calls 样本不足 → N/A');
    assert.equal(reporter.readReport('2026-09-06').day, '2026-09-06');
    assert.equal(reporter.readReport('2026-09-05'), null, '未生成返回 null');

    const l1 = reporter.l1Summary(3, Date.parse('2026-09-07T12:00:00+08:00'));
    assert.equal(l1.today.day, '2026-09-07');
    assert.equal(l1.today.calls, 1);
    // days 含 09-05（报告缺失但原始数据在 → 实时聚合）与 09-06（报告）
    const days = l1.days.map((d) => d.day);
    assert.deepEqual(days, ['2026-09-05', '2026-09-06']);
    assert.equal(l1.days.find((d) => d.day === '2026-09-05').summary.calls, 1);
    assert.equal(l1.days.find((d) => d.day === '2026-09-06').summary.calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily v0.8.0 G1: DailyScheduler 凌晨 1 点后生成昨日报告 + 未到不生成 + 防重复', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'mr-daily-'));
  try {
    const ledger = new DailyLedger({ storePath: join(dir, 'state.json'), timeZone: 'Asia/Shanghai', log });
    const reporter = new DailyReporter({ ledger, log });
    ledger.recordCall({ provider: 'p-a', model: 'm-1', outcome: 'committed', ts: Date.parse('2026-09-06T12:00:00+08:00') });

    // 未到 1 点：不生成
    const early = new DailyScheduler({ ledger, reporter, timeZone: 'Asia/Shanghai', log, now: () => new Date('2026-09-07T00:59:00+08:00') });
    early.tick();
    assert.equal(ledger.hasReport('2026-09-06'), false, '00:59 未到生成时刻');

    // 01:05：生成昨日报告
    let genCount = 0;
    const spyReporter = { ...reporter, generate: (day) => { genCount += 1; return reporter.generate(day); } };
    const onTime = new DailyScheduler({ ledger, reporter: spyReporter, timeZone: 'Asia/Shanghai', log, now: () => new Date('2026-09-07T01:05:00+08:00') });
    onTime.tick();
    assert.equal(ledger.hasReport('2026-09-06'), true);
    assert.equal(genCount, 1);
    onTime.tick();
    assert.equal(genCount, 1, 'lastGenerated 防重复生成');

    // 昨日无数据：标记跳过不生成
    const emptyLedger = new DailyLedger({ storePath: join(dir, 'empty.json'), timeZone: 'Asia/Shanghai', log });
    const emptyRep = new DailyReporter({ ledger: emptyLedger, log });
    let emptyGen = 0;
    const emptySpy = { ...emptyRep, generate: (day) => { emptyGen += 1; return emptyRep.generate(day); } };
    const emptySched = new DailyScheduler({ ledger: emptyLedger, reporter: emptySpy, timeZone: 'Asia/Shanghai', log, now: () => new Date('2026-09-07T01:05:00+08:00') });
    emptySched.tick();
    assert.equal(emptyGen, 0, '昨日无数据不生成');
    emptySched.tick();
    assert.equal(emptyGen, 0, '标记 lastGenerated 后不空扫');

    onTime.dispose();
    early.dispose();
    emptySched.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== v0.8.0 批 4：G1 接入 ====================

test('config v0.8.0 G1: reports 域校验（enabled/hour 类型、默认值、非法拒绝）', () => {
  const c = normalizeConfig(undefined);
  assert.equal(c.reports.enabled, false, 'G1 默认关闭（零记账零调度）');
  assert.equal(c.reports.hour, '01:00');
  assert.equal(normalizeConfig({ rules: [], reports: { enabled: true } }).reports.enabled, true);
  assert.equal(normalizeConfig({ rules: [], reports: { hour: '03:30' } }).reports.hour, '03:30');
  assert.throws(() => normalizeConfig({ rules: [], reports: { enabled: 'yes' } }), /reports\.enabled/);
  assert.throws(() => normalizeConfig({ rules: [], reports: { hour: '25:00' } }), /reports\.hour/);
  assert.throws(() => normalizeConfig({ rules: [], reports: { hour: '1:00' } }), /reports\.hour/);
});

test('wrapper v0.8.0 G1: 纯透传路径记账 recordCall(inSequence:false) + usage 捕获 + 同步 quota.record（口径一致）', async () => {
  const deps = makeDeps({
    config: { rules: [{ match: { default: true }, route: [{ provider: 'p-a', model: 'm-1' }] }] }, // 唯一候选=首选 → 无重发 → 透传
  });
  const dailyCalls = [];
  const quotaRecs = [];
  deps.daily = { recordCall: (rec) => dailyCalls.push(rec) };
  deps.quota = { record: (p, u) => quotaRecs.push([p, u]) };
  const wrapper = createStreamWrapper(deps);
  const primary = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'hi' };
    yield usage;
    yield finishStop;
  })();
  const out = await drain(wrapper.call({}, { provider: 'p-a', model: 'm-1', sessionId: 'sess-x' }, () => primary));
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'usage', 'finish']);
  assert.equal(dailyCalls.length, 1);
  const rec = dailyCalls[0];
  assert.equal(rec.provider, 'p-a');
  assert.equal(rec.model, 'm-1');
  assert.equal(rec.outcome, 'committed');
  assert.equal(rec.inSequence, false, '透传不算切换序列');
  assert.equal(rec.switched, false);
  assert.equal(rec.sessionId, 'sess-x');
  assert.equal(rec.attemptsTotal, 1);
  assert.equal(rec.tokens.inputTokens, 10);
  assert.equal(rec.tokens.outputTokens, 5);
  assert.equal(quotaRecs.length, 1, '透传也同步 quota.record（口径与切换路径统一）');
  assert.deepEqual(quotaRecs[0], ['p-a', { inputTokens: 10, outputTokens: 5 }]);
});

test('wrapper v0.8.0 G1: 透传路径内层 throw → try/finally 兜底记账 EMPTY_RESPONSE 后原样重抛（不丢账）', async () => {
  const deps = makeDeps({
    config: { rules: [{ match: { default: true }, route: [{ provider: 'p-a', model: 'm-1' }] }] },
  });
  const dailyCalls = [];
  deps.daily = { recordCall: (rec) => dailyCalls.push(rec) };
  const wrapper = createStreamWrapper(deps);
  const throwing = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'partial' };
    throw new Error('boom');
  })();
  await assert.rejects(
    () => drain(wrapper.call({}, { provider: 'p-a', model: 'm-1' }, () => throwing)),
    /boom/,
  );
  assert.equal(dailyCalls.length, 1, '异常路径不得跳过记账');
  assert.equal(dailyCalls[0].outcome, 'failed');
  assert.equal(dailyCalls[0].errorCode, 'EMPTY_RESPONSE');
  assert.equal(dailyCalls[0].inSequence, false);
  assert.equal(dailyCalls[0].attemptsTotal, 1);
});

test('wrapper v0.8.0 G1: sessionId 修复——runAttempt 记账/metrics.sample 收到真实 sessionId', async () => {
  const deps = makeDeps();
  const samples = [];
  const dailyCalls = [];
  deps.metrics = { sample: (s) => samples.push(s), snapshot: () => ({}) };
  deps.daily = { recordCall: (rec) => dailyCalls.push(rec) };
  const wrapper = createStreamWrapper(deps);
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield finishStop;
    },
  });
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA' } } };
  })();
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1', sessionId: 'sess-1' }, () => primary));
  assert.deepEqual(out.map((c) => c.type), ['text-delta', 'finish']);
  assert.equal(samples.length, 2, '首选失败采样 + 重发成功采样');
  assert.ok(samples.every((s) => s.sessionId === 'sess-1'), `metrics.sample 须携带 sessionId：${JSON.stringify(samples)}`);
  assert.equal(dailyCalls.length, 2);
  assert.ok(dailyCalls.every((r) => r.sessionId === 'sess-1'));
  assert.equal(dailyCalls[0].inSequence, true);
  assert.equal(dailyCalls[0].attemptIndex, 0);
  assert.equal(dailyCalls[1].attemptIndex, 1);
  assert.equal(dailyCalls[1].switched, true, '第二跳 switched=true');
});

test('routes v0.8.0 G1: 报告接口——disabled 503 / day 非法 400 / 无数据 404 / l1=1 摘要 / 指定日报告 / generate', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'mr-reports-'));
  const base = {
    config: { statusPath: '/api/model-router/status', rules: [], fallbackPolicy: {}, probe: {}, timeZone: null, storePath: '' },
    router: { snapshot() { return {}; }, recordExhausted() {} },
    cooldown: { snapshot() { return {}; } },
    metrics: { snapshot() { return {}; } },
    quota: { snapshot() { return {}; } },
    registry: null,
    probe: null,
    llm: {},
    wrapperStats: {},
    startedAt: Date.now(),
    resolveSessions: null,
    saveStateFn: () => {},
    log,
  };
  const mkReq = (method, url, remote = '127.0.0.1') => ({
    method,
    url,
    socket: { remoteAddress: remote },
    headers: { host: '127.0.0.1:3081' },
  });
  const call = async (routes, req, path = '/api/model-router/reports') => {
    const route = routes.find((r) => r.path === path);
    assert.ok(route, `route missing: ${path}`);
    let body;
    const res = { writeHead() {}, setHeader() {}, end(b) { body = JSON.parse(b); } };
    await route.handler(req, res);
    return body;
  };
  try {
    // reports.enabled=false → 503 明确提示（接口存在性稳定）
    let body = await call(makeStatusRoutes(base), mkReq('GET', '/api/model-router/reports'));
    assert.equal(body.ok, false);
    assert.match(body.error, /reports disabled/);
    body = await call(makeStatusRoutes(base), mkReq('POST', '/api/model-router/reports/generate'), '/api/model-router/reports/generate');
    assert.equal(body.ok, false);
    assert.match(body.error, /reports disabled/);

    const ledger = new DailyLedger({ storePath: join(dir, 'state.json'), timeZone: 'Asia/Shanghai', log });
    const reporter = new DailyReporter({ ledger, log });
    const routes = makeStatusRoutes({ ...base, daily: ledger, reporter });
    const yesterdayTs = Date.now() - 86400_000;

    // 回环围栏：非回环 remote → 403
    body = await call(routes, mkReq('GET', '/api/model-router/reports', '10.0.0.1'));
    assert.equal(body.ok, false);
    assert.match(body.error, /forbidden/);

    // l1=1 摘要：days 数组 + today 快照
    body = await call(routes, mkReq('GET', '/api/model-router/reports?l1=1'));
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.days));
    assert.ok(body.today && typeof body.today === 'object');

    // day 非法格式 → 400
    body = await call(routes, mkReq('GET', '/api/model-router/reports?day=2026-9-6'));
    assert.equal(body.ok, false);
    assert.match(body.error, /YYYY-MM-DD/);

    // 无数据 → 404
    body = await call(routes, mkReq('GET', '/api/model-router/reports?day=2020-01-01'));
    assert.equal(body.ok, false);
    assert.match(body.error, /no data/);

    // 记账一条昨日数据 → 指定日实时聚合 200
    ledger.recordCall({
      provider: 'p-a', model: 'm-1', outcome: 'committed', inSequence: false,
      attempts: 1, switched: false, e2eMs: 100, ttftMs: 40,
      tokens: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      ts: yesterdayTs,
    });
    body = await call(routes, mkReq('GET', `/api/model-router/reports?day=${dayKeyOf(yesterdayTs, 'Asia/Shanghai')}`));
    assert.equal(body.ok, true);
    assert.equal(body.report.summary.calls, 1);
    assert.equal(body.report.byProviderModel[0].provider, 'p-a');

    // generate：昨日有数据 → 200 报告落盘；再次触发 → already:true 不重复写
    body = await call(routes, mkReq('POST', '/api/model-router/reports/generate'), '/api/model-router/reports/generate');
    assert.equal(body.ok, true);
    assert.equal(body.report.summary.calls, 1);
    assert.equal(body.day, dayKeyOf(yesterdayTs, 'Asia/Shanghai'));
    const again = await call(routes, mkReq('POST', '/api/model-router/reports/generate'), '/api/model-router/reports/generate');
    assert.equal(again.already, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes v0.8.0 G1: status version 去硬编码（读 package.json）', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const { readFileSync } = await import('node:fs');
  const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const routes = makeStatusRoutes({
    config: { statusPath: '/api/model-router/status', rules: [], fallbackPolicy: {}, probe: {}, timeZone: null, storePath: '' },
    router: { snapshot() { return {}; }, recordExhausted() {} },
    cooldown: { snapshot() { return {}; } },
    metrics: { snapshot() { return { recent: [], byRoute: {}, sessions: [] }; } },
    quota: { snapshot() { return {}; } },
    registry: null,
    probe: null,
    llm: {},
    wrapperStats: {},
    startedAt: Date.now(),
    saveStateFn: () => {},
    log,
  });
  const statusRoute = routes.find((r) => r.path === '/api/model-router/status');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3081' } };
  let body;
  const res = { writeHead() {}, setHeader() {}, end(b) { body = JSON.parse(b); } };
  await statusRoute.handler(req, res);
  assert.equal(body.version, pkgVersion, 'version 须与 package.json 一致（不再硬编码）');
});

// ==================== v0.8.0 B-1/B-2 按需负载测试 ====================

test('loadtest v0.8.0 B-1: probe phase——结构正确 + 默认只测 free + PROBE_MARK 透传', async () => {
  const { LoadTestRunner } = await import('../lib/loadtest.js');
  const llm = probeLlm({
    'm-free': async function* () {
      yield { type: 'text-delta', index: 0, text: 'pong' };
      yield finishStop;
    },
    'm-bad': async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } };
    },
  });
  const registry = {
    registeredPairs: () => [
      { provider: 'p-a', model: 'm-free', tier: 'free' },
      { provider: 'p-b', model: 'm-bad', tier: 'free' },
      { provider: 'p-paid', model: 'm-paid', tier: 'paid-baseline' },
      { provider: 'p-unk', model: 'm-unk' }, // 未声明 tier → unknown，默认同样排除
    ],
  };
  const runner = new LoadTestRunner({ llm, registry, log });
  const result = await runner.run('probe');
  assert.equal(result.phase, 'probe');
  assert.equal(result.aborted, false);
  assert.equal(result.targets.length, 2, '默认 tierFilter=free，paid/unknown 排除');
  const ok = result.targets.find((t) => t.model === 'm-free');
  assert.equal(ok.ok, true);
  assert.equal(typeof ok.ttftMs, 'number');
  const bad = result.targets.find((t) => t.model === 'm-bad');
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, 'RATE_LIMIT');
  // 请求经 singleRaw → 必带 PROBE_MARK → wrapper 直透不记账（生产状态零污染）
  assert.equal(llm.calls.length, 2);
  for (const c of llm.calls) assert.ok(c.__mr_probe, '探针请求必须带 PROBE_MARK');
  // snapshot 反映最近结果
  const snap = runner.snapshot();
  assert.equal(snap.running, false);
  assert.equal(snap.last.phase, 'probe');
});

test('loadtest v0.8.0 B-1: rpm phase——429 检测 lastOkRpm/first429Rpm + 自动等待恢复（S-3）', async () => {
  const { LoadTestRunner } = await import('../lib/loadtest.js');
  let n = 0;
  const llm = probeLlm({
    'm-rpm': async function* () {
      n += 1;
      if (n > 3) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } };
      } else {
        yield { type: 'text-delta', index: 0, text: 'pong' };
        yield finishStop;
      }
    },
  });
  const registry = { registeredPairs: () => [{ provider: 'p-a', model: 'm-rpm', tier: 'free' }] };
  const runner = new LoadTestRunner({ llm, registry, log });
  const started = Date.now();
  // 阶梯 [100, 200] × 2 样本：100 档 2 发全过（n=1,2）；200 档 n=3 过、n=4 429 → 越界即停
  const result = await runner.run('rpm', { qpsLadder: [100, 200], samplesPerStep: 2, recoveryMs: 60 });
  const t = result.targets[0];
  assert.equal(t.lastOkRpm, 100, '最后干净档 = 边界');
  assert.equal(t.first429Rpm, 200, '首个 429 所在档');
  assert.equal(t.ladder.length, 2);
  assert.deepEqual(t.ladder[1], { qps: 200, success: 1, total: 2 });
  assert.ok(Date.now() - started >= 40, '触发限流后自动等待恢复再交还控制权');
});

test('loadtest v0.8.0 B-1: context phase——多尺寸上下文探测结构', async () => {
  const { LoadTestRunner } = await import('../lib/loadtest.js');
  const llm = probeLlm({
    'm-ctx': async function* () {
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield finishStop;
    },
  });
  const registry = { registeredPairs: () => [{ provider: 'p-a', model: 'm-ctx', tier: 'free' }] };
  const runner = new LoadTestRunner({ llm, registry, log });
  const result = await runner.run('context', { sizes: [16, 32] });
  assert.equal(result.phase, 'context');
  assert.equal(result.targets.length, 1);
  const sizes = result.targets[0].sizes;
  assert.deepEqual(sizes.map((s) => s.tokens), [16, 32]);
  assert.ok(sizes.every((s) => s.ok === true));
  // 请求体按 tokens×4 字符粗估（触达超长上下文拒绝/接受判定）
  assert.ok(JSON.stringify(llm.calls[0].messages).includes('x'.repeat(64)));
});

test('loadtest v0.8.0 B-1: quota-group phase——同组分组成员 + 并发保护 + abortAll', async () => {
  const { LoadTestRunner } = await import('../lib/loadtest.js');
  const llm = probeLlm({
    'm-g1': async function* () {
      yield { type: 'text-delta', index: 0, text: 'pong' };
      yield finishStop;
    },
    'm-g2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'pong' };
      yield finishStop;
    },
  });
  const registry = {
    registeredPairs: () => [
      { provider: 'p-a', model: 'm-g1', tier: 'free', quotaGroup: 'g1' },
      { provider: 'p-b', model: 'm-g2', tier: 'free', quotaGroup: 'g1' },
      { provider: 'p-c', model: 'm-1', tier: 'free' },
    ],
  };
  const runner = new LoadTestRunner({ llm, registry, log });
  const result = await runner.run('quota-group');
  assert.equal(result.groups.length, 2);
  const g1 = result.groups.find((g) => g.quotaGroup === 'g1');
  assert.equal(g1.members.length, 2);
  assert.ok(g1.members.every((m) => m.ok === true));
  const none = result.groups.find((g) => g.quotaGroup === null);
  assert.equal(none.members.length, 1);
  // 并发保护：running 时二次 run 拒绝
  runner.running = true;
  await assert.rejects(runner.run('probe'), /already running/);
  runner.running = false;
  // abortAll：运行中置标志 → 当前请求完成后停止调度
  const slowLlm = probeLlm({
    default: async function* () {
      await sleep(80);
      yield { type: 'text-delta', index: 0, text: 'x' };
      yield finishStop;
    },
  });
  const slowRegistry = {
    registeredPairs: () => [0, 1, 2, 3].map((i) => ({ provider: 'p-s', model: `m-slow-${i}`, tier: 'free' })),
  };
  const slowRunner = new LoadTestRunner({ llm: slowLlm, registry: slowRegistry, log });
  const runPromise = slowRunner.run('probe');
  await sleep(5);
  slowRunner.abortAll();
  const aborted = await runPromise;
  assert.equal(aborted.aborted, true);
  assert.ok(aborted.targets.length < 4, '中止后不再调度全部目标');
});

test('routes v0.8.0 B-2: loadtest 端点——GET 快照 / POST 202 / DELETE 200 / 405 / 400 / 409 / 403 / 503', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const base = {
    config: { statusPath: '/api/model-router/status', rules: [], fallbackPolicy: {}, probe: {}, timeZone: null, storePath: '' },
    router: { snapshot() { return {}; }, recordExhausted() {} },
    cooldown: { snapshot() { return {}; } },
    metrics: { snapshot() { return {}; } },
    quota: { snapshot() { return {}; } },
    registry: null,
    probe: null,
    llm: {},
    wrapperStats: {},
    startedAt: Date.now(),
    saveStateFn: () => {},
    log,
  };
  const runs = [];
  const loadtest = {
    running: false,
    snapshot() {
      return { running: this.running, last: null, results: {} };
    },
    async run(phase, opts) {
      runs.push({ phase, opts });
      return { phase, targets: [] };
    },
    abortAll() {
      this.abortedCalls = (this.abortedCalls ?? 0) + 1;
    },
  };
  const routes = makeStatusRoutes({ ...base, loadtest });
  const mkReq = (method, url, remote = '127.0.0.1', bodyStr = '') => ({
    method,
    url,
    socket: { remoteAddress: remote },
    headers: { host: '127.0.0.1:3081' },
    [Symbol.asyncIterator]: async function* () {
      if (bodyStr) yield Buffer.from(bodyStr);
    },
  });
  const call = async (routeList, req) => {
    const route = routeList.find((r) => r.path === '/api/model-router/loadtest');
    let body;
    const res = {
      writeHead(code) {
        res.status = code;
      },
      setHeader() {},
      end(b) {
        body = JSON.parse(b);
      },
    };
    await route.handler(req, res);
    return { status: res.status, body };
  };
  const LT = '/api/model-router/loadtest';
  // GET → 快照
  let r = await call(routes, mkReq('GET', LT));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.running, false);
  // POST probe → 202 + 默认只测 free（opts 空）
  r = await call(routes, mkReq('POST', LT, '127.0.0.1', JSON.stringify({ phase: 'probe' })));
  assert.equal(r.status, 202);
  assert.equal(r.body.phase, 'probe');
  assert.deepEqual(runs[0], { phase: 'probe', opts: {} });
  // POST 显式参数 → opts 透传
  await call(routes, mkReq('POST', LT, '127.0.0.1', JSON.stringify({ phase: 'rpm', tiers: ['paid-baseline'], qpsLadder: [0.1], samplesPerStep: 3 })));
  assert.deepEqual(runs[1].opts, { tiers: ['paid-baseline'], qpsLadder: [0.1], samplesPerStep: 3 });
  // 非法 phase → 400
  r = await call(routes, mkReq('POST', LT, '127.0.0.1', JSON.stringify({ phase: 'nope' })));
  assert.equal(r.status, 400);
  // 已在跑 → 409
  loadtest.running = true;
  r = await call(routes, mkReq('POST', LT, '127.0.0.1', JSON.stringify({ phase: 'probe' })));
  assert.equal(r.status, 409);
  loadtest.running = false;
  // 非 POST/GET/DELETE → 405
  r = await call(routes, mkReq('PUT', LT));
  assert.equal(r.status, 405);
  // DELETE → 200 + abortAll 被调用
  r = await call(routes, mkReq('DELETE', LT));
  assert.equal(r.status, 200);
  assert.equal(loadtest.abortedCalls, 1);
  // 非回环 → 403
  r = await call(routes, mkReq('GET', LT, '10.0.0.1'));
  assert.equal(r.status, 403);
  // 未装配 → 503
  r = await call(makeStatusRoutes(base), mkReq('GET', LT));
  assert.equal(r.status, 503);
});

// ==================== v0.8.0 部署发现修复：providerMeta 持久化链路 ====================

test('config v0.8.0 修复: normalizeState 接受并清洗 providerMeta（未提交时不重置）', async () => {
  const { normalizeState } = await import('../lib/config.js');
  // 合法：清洗 + 返回
  const s1 = normalizeState({
    propose: true,
    rules: [],
    providerMeta: { 'p-a': { tier: 'free', quotaGroup: 'g1' }, 'p-b': { quotaGroup: 'g2' } },
  });
  assert.deepEqual(s1.providerMeta, {
    'p-a': { tier: 'free', quotaGroup: 'g1' },
    'p-b': { quotaGroup: 'g2' },
  });
  // 未提交 → undefined（热生效/持久化跳过，保留 patch 值）
  const s2 = normalizeState({ propose: true, rules: [] });
  assert.equal(s2.providerMeta, undefined);
  // 非法 tier → 抛错（handler 映射 400）
  assert.throws(() => normalizeState({ rules: [], providerMeta: { 'p-a': { tier: 'gold' } } }), /tier/);
  // providerMeta 非对象 → 抛错
  assert.throws(() => normalizeState({ rules: [], providerMeta: 'x' }), /providerMeta 须为对象/);
});

test('store v0.8.0 修复: loadState 读回 providerMeta（round-trip + 旧文件向后兼容）', async () => {
  const { loadState } = await import('../lib/store.js');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mr-store-'));
  try {
    const p = join(dir, 'state.json');
    writeFileSync(p, JSON.stringify({ version: 1, propose: true, rules: [], providerMeta: { 'p-a': { tier: 'free' } } }));
    const state = loadState(p, { warn() {} });
    assert.deepEqual(state.providerMeta, { 'p-a': { tier: 'free' } });
    // 旧 store 无 providerMeta 键 → undefined（向后兼容，index 跳过覆盖）
    writeFileSync(p, JSON.stringify({ version: 1, propose: false, rules: [] }));
    const old = loadState(p, { warn() {} });
    assert.equal(old.providerMeta, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes v0.8.0 修复: POST /state 带 providerMeta → 热生效 + 持久化 payload 含 providerMeta', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const config = {
    statusPath: '/api/model-router/status',
    rules: [],
    fallbackPolicy: {},
    probe: {},
    timeZone: null,
    storePath: '',
    providerMeta: { 'p-patch': { tier: 'free' } },
  };
  let saved;
  const routes = makeStatusRoutes({
    config,
    router: { snapshot() { return {}; }, recordExhausted() {}, applyRuntime() {} },
    cooldown: { snapshot() { return {}; }, applyPolicy() {} },
    metrics: { snapshot() { return {}; } },
    quota: { snapshot() { return {}; } },
    registry: null,
    probe: null,
    llm: {},
    wrapperStats: {},
    startedAt: Date.now(),
    saveStateFn: (s) => {
      saved = s;
      return true;
    },
    log,
  });
  const route = routes.find((r) => r.path === '/api/model-router/state');
  const req = {
    method: 'POST',
    url: '/api/model-router/state',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081' },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ propose: true, rules: [], providerMeta: { 'p-a': { tier: 'free', quotaGroup: 'g1' } } }));
    },
  };
  let body;
  const res = {
    writeHead() {},
    setHeader() {},
    end(b) {
      body = JSON.parse(b);
    },
  };
  await route.handler(req, res);
  assert.deepEqual(config.providerMeta, { 'p-a': { tier: 'free', quotaGroup: 'g1' } }, '热生效：config.providerMeta 被替换');
  assert.deepEqual(saved.providerMeta, { 'p-a': { tier: 'free', quotaGroup: 'g1' } }, '持久化 payload 含 providerMeta');
  // 未提交 providerMeta 的 state 不得重置 patch 值
  const req2 = {
    method: 'POST',
    url: '/api/model-router/state',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081' },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ propose: false, rules: [] }));
    },
  };
  await route.handler(req2, res);
  assert.deepEqual(config.providerMeta, { 'p-a': { tier: 'free', quotaGroup: 'g1' } }, '未提交 → 保留既有 providerMeta');
});

test('routes v0.8.0 修复: status GET 响应 config.providerMeta 回显', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const config = {
    statusPath: '/api/model-router/status',
    rules: [],
    fallbackPolicy: {},
    probe: {},
    timeZone: null,
    storePath: '',
    mode: 'balanced',
    providerMeta: { 'test-p': { tier: 'free', quotaGroup: 'g1' } },
  };
  const routes = makeStatusRoutes({
    config,
    router: { snapshot() { return {}; }, recordExhausted() {} },
    cooldown: { snapshot() { return {}; } },
    metrics: { snapshot() { return { recent: [], byRoute: {}, sessions: [] }; } },
    quota: { snapshot() { return {}; } },
    registry: null,
    probe: null,
    llm: {},
    wrapperStats: {},
    startedAt: Date.now(),
    saveStateFn: () => {},
    log,
  });
  const statusRoute = routes.find((r) => r.path === '/api/model-router/status');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3081' } };
  let body;
  const res = {
    writeHead() {},
    setHeader() {},
    end(b) {
      body = JSON.parse(b);
    },
  };
  await statusRoute.handler(req, res);
  assert.deepEqual(body.config.providerMeta, { 'test-p': { tier: 'free', quotaGroup: 'g1' } }, 'status 须回显 providerMeta（此前漏列）');
});


