/**
 * @botton/dsh-model-router 单元测试（node:test，零第三方依赖）。
 * 覆盖：配置校验 / cooldown 三态 / 路由收敛 / 包装层全部关键语义
 * （finish 前置处理 R-1、commit-on-first-chunk R-3、看门狗 aborted 分流 R-6、
 *  force-first 真尝试 R-7、耗尽合成 error finish、WeakSet 防递归、文法唯一 finish）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { normalizeConfig, DEFAULT_CONFIG, normalizeState } from '../lib/config.js';
import { CooldownBoard, hopKeyOf } from '../lib/cooldown.js';
import { Router } from '../lib/router.js';
import { createStreamWrapper } from '../lib/wrapper.js';
import { ProbeBoard, computeTrmBound } from '../lib/probe.js';
import { loadState, saveState } from '../lib/store.js';

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
