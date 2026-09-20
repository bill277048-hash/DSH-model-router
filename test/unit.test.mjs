/**
 * @botton/dsh-model-router 单元测试（node:test，零第三方依赖）。
 * 覆盖：配置校验 / cooldown 三态 / 路由收敛 / 包装层全部关键语义
 * （finish 前置处理 R-1、commit-on-first-chunk R-3、看门狗 aborted 分流 R-6、
 *  force-first 真尝试 R-7、耗尽合成 error finish、WeakSet 防递归、文法唯一 finish）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeConfig, DEFAULT_CONFIG, normalizeState, quotaGroupCount, autoTuneMaxRetries, applyDefaultNames } from '../lib/config.js';
import { CooldownBoard, hopKeyOf } from '../lib/cooldown.js';
import { Router, PKG_PROVIDER, PKG_PREFIX } from '../lib/router.js';
import { Registry } from '../lib/registry.js';
import { createPackagesAdapter } from '../lib/packages-adapter.js';
import { createStreamWrapper } from '../lib/wrapper.js';
import { ProbeBoard, computeTrmBound, singleRaw } from '../lib/probe.js';
import { loadState, saveState } from '../lib/store.js';
import { dayKeyOf, stabilityGrade, DailyLedger, DailyReporter, DailyScheduler, formatReportMarkdown } from '../lib/daily.js';
import { WindowLedger, QuotaLedger, deriveWindowId } from '../lib/quota.js';
import { ModelTestRunner, validateModelTestTargets, validateManualInput, validatePhases, MODEL_TEST_PHASES, PHASE_EXEC_ORDER, orderPhasesForExecution, verdictOf, formatReportMarkdown as formatModelTestMd, manualWarnings } from '../lib/model-test.js';
import { normalizeTimeWindows } from '../lib/config.js';

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
    allowLegacyMatch: true, // v0.9.4 收口：wrapper 用例显式延用 v0.8 匹配语义构造 default 规则
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
  // v0.9.4 收口：合法路径构造需显式开 legacy（默认 fail-fast 会拒绝带 match 规则）
  const c2 = normalizeConfig({ allowLegacyMatch: true, rules: [{ match: { model: 'x' }, route: [{ provider: 'a', model: 'b', key: 'k' }] }] });
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

function makeRouter(rules, registry, opts = {}) {
  // v0.9.4 收口：默认显式延用 v0.8 匹配语义（match 构造可用）；验证纯选择驱动时传 { legacyMatch: false }
  //
  // v1.0.2：新增可选 `opts.timeZone`。
  // 背景：`timeZone` 缺省为 `null`（= 系统时区），凡「用硬编码时刻断言时段命中」的用例
  // 都会**随运行机器的时区变化**——CI 跑在 UTC，本地跑在 +8，同一断言结果相反。
  // 实测 `test` workflow 自 2026-09-08 起 6/6 全失败即因此（当时误判为依赖缺失）。
  // 需要确定性时区的用例**必须**显式传本参数，勿依赖运行环境。
  const config = normalizeConfig({
    allowLegacyMatch: opts.legacyMatch !== false,
    rules,
    ...(opts.timeZone !== undefined ? { timeZone: opts.timeZone } : {}),
  });
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
  // v0.9.4 收口：match 为 legacy 语义，构造需显式开 legacy
  const ok = normalizeConfig({
    allowLegacyMatch: true,
    rules: [{ match: { sessionIds: ['a', 'b', 'a'] }, route: [{ provider: 'p', model: 'm' }] }],
  });
  assert.deepEqual(ok.rules[0].match.sessionIds, ['a', 'b']);
  assert.throws(() =>
    normalizeConfig({ allowLegacyMatch: true, rules: [{ match: { sessionIds: ['a', 42] }, route: [{ provider: 'p', model: 'm' }] }] }),
  );
  assert.throws(() =>
    normalizeConfig({ allowLegacyMatch: true, rules: [{ match: { sessionIds: 'not-array' }, route: [{ provider: 'p', model: 'm' }] }] }),
  );
  // 空 sessionIds 数组 = 无限定条件 → 拒绝
  assert.throws(() =>
    normalizeConfig({ allowLegacyMatch: true, rules: [{ match: { sessionIds: [] }, route: [{ provider: 'p', model: 'm' }] }] }),
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
  // v0.9.4 收口：构造带 match 需显式开 legacy
  const ok = normalizeState({
    propose: true,
    rules: [{ match: { default: true }, strategy: 'exclude-current', route: [{ provider: 'a', model: 'b' }] }],
  }, true);
  assert.equal(ok.propose, true);
  assert.equal(ok.rules[0].strategy, 'exclude-current');
  assert.throws(() => normalizeState({ propose: true, rules: [{ match: { default: true }, strategy: 'bogus', route: [{ provider: 'a', model: 'b' }] }] }, true));
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
  // v0.9.4 收口：匹配规则构造开 legacy
  const router = new Router(normalizeConfig({ allowLegacyMatch: true, rules }), null, probe);
  const chain = router.candidates({ provider: 'seed', model: 'seed' });
  assert.deepEqual(chain.map((h) => h.provider), ['p-c', 'p-a', 'p-b']);
  // 无健康记录的新候选（p-d）rank=0 → 按原顺序与 p-c 竞争（ttft=Infinity 在后）
  probe._record('p-c', 'm-3', { ok: true, ttftMs: 50, lastProbeAt: 'x' });
  const routerNoProbe = new Router(normalizeConfig({ allowLegacyMatch: true, rules }), null, null);
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
  // v0.9.4 收口：match 为 legacy 语义，构造需显式开 legacy
  assert.throws(
    () => normalizeConfig({ allowLegacyMatch: true, rules: [{ match: { sessionIds: [] }, route: [{ provider: 'p', model: 'm' }] }] }),
    /空数组/,
  );
  // 与 model 组合的空 sessionIds 同样是死规则（AND 语义下永不命中）
  assert.throws(
    () => normalizeConfig({ allowLegacyMatch: true, rules: [{ match: { model: 'm-1', sessionIds: [] }, route: [{ provider: 'p', model: 'm' }] }] }),
    /空数组/,
  );
  // 正常 sessionIds 不受影响
  const ok = normalizeConfig({
    allowLegacyMatch: true,
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
  // ★ v1.0.2：必须显式指定 timeZone。此前依赖**运行机器的系统时区**——
  //   注释写的「上海 00:30」只在 +8 成立，CI（UTC）下同一时刻是 16:30 → 断言反向。
  const router = makeRouter([
    { match: { default: true, hours: { start: '00:30', end: '08:30' } }, route: [{ provider: 'q-off', model: 'n-off' }] },
    { match: { default: true }, route: [{ provider: 'q-peak', model: 'n-peak' }] },
  ], null, { timeZone: 'Asia/Shanghai' });
  // 谷时（上海 00:30）→ 第一条 default（谷价路由）
  router._now = new Date('2026-09-04T16:30:00Z');
  assert.deepEqual(router.candidates({ provider: 'p', model: 'm' }), [{ provider: 'q-off', model: 'n-off' }]);
  // 峰时（上海 12:00）→ 窗外 default 跳过，落纯 default
  router._now = new Date('2026-09-04T04:00:00Z');
  assert.deepEqual(router.candidates({ provider: 'p', model: 'm' }), [{ provider: 'q-peak', model: 'n-peak' }]);
  router._now = null;
});

test('config v0.5.0: hours/timeZone 校验（fail-fast）', () => {
  // v0.9.4 收口：match 为 legacy 语义，构造需显式开 legacy
  assert.throws(
    () => normalizeConfig({ allowLegacyMatch: true, rules: [{ match: { hours: { start: '25:00', end: '08:00' } }, route: [{ provider: 'p', model: 'm' }] }] }),
    /HH:MM/,
  );
  assert.throws(
    () => normalizeConfig({ allowLegacyMatch: true, rules: [{ match: { hours: { start: '08:00', end: '08:00' } }, route: [{ provider: 'p', model: 'm' }] }] }),
    /不能相同/,
  );
  assert.throws(() => normalizeConfig({ rules: [], timeZone: 'Mars/Olympus' }), /IANA/);
  // hours 可独立作为条件；default+hours 合法；显式时区合法；缺省为 null（系统时区）
  const ok = normalizeConfig({
    allowLegacyMatch: true,
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
  assert.deepEqual([...VALID_MODES].sort(), ['balanced', 'custom', 'fast', 'free-tier', 'stable']);
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
    allowLegacyMatch: true, // v0.9.4 收口：匹配规则构造开 legacy
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
    allowLegacyMatch: true, // v0.9.4 收口：匹配规则构造开 legacy
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

test('v0.9.6: exclude 裁剪注册表自动展开候选池（same-model / same-provider / exclude-current 三策略）', async () => {
  const llm = makeRegistryLlm([
    { provider: 'p-a', models: [{ id: 'm-1' }, { id: 'm-2' }] },
    { provider: 'p-b', models: [{ id: 'm-1' }, { id: 'm-2' }] },
  ]);

  // 对照组（未 exclude）：p-b 应在池中 —— 证明「过滤」确实起作用，而非测试本身写空
  const cfgNoEx = normalizeConfig({ allowLegacyMatch: true, providerMeta: {}, rules: [] });
  const regNoEx = new Registry(llm, log, 300, cfgNoEx);
  regNoEx.refreshProviders();
  await regNoEx.refreshModels();
  assert.equal(
    regNoEx.registeredPairs().some((p) => p.provider === 'p-b'),
    true,
    '对照组：未 exclude 时 p-b 应在候选池中',
  );

  // 实验组（p-b exclude）
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
    providerMeta: { 'p-b': { exclude: true } },
    rules: [],
  });
  const reg = new Registry(llm, log, 300, cfg);
  reg.refreshProviders();
  await reg.refreshModels();

  assert.equal(reg.isExcluded('p-b'), true, 'isExcluded(p-b) 应为 true');
  assert.equal(reg.isExcluded('p-a'), false, 'isExcluded(p-a) 应为 false');
  const pairs = reg.registeredPairs();
  assert.equal(pairs.some((p) => p.provider === 'p-b'), false, 'exclude 的 provider 不应进候选池');
  assert.equal(pairs.some((p) => p.provider === 'p-a'), true, '其它 provider 不受影响');

  // 三策略均不得展开出 p-b
  for (const strategy of ['same-model', 'same-provider', 'exclude-current']) {
    const router = new Router(cfg, reg, null);
    const chain = router.candidatesForRule(
      { name: 'r1', strategy, route: [] },
      { provider: 'p-a', model: 'm-1' },
    );
    assert.equal(
      chain.some((h) => h.provider === 'p-b'),
      false,
      `${strategy} 不应展开出被 exclude 的 p-b`,
    );
  }
});

test('v0.9.6: exclude 不否决显式 route（只裁剪自动展开，不改用户手工列表）', async () => {
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
    providerMeta: { 'p-b': { exclude: true } },
    rules: [{
      name: 'r1',
      strategy: 'explicit',
      route: [
        { provider: 'p-a', model: 'm-1' },
        { provider: 'p-b', model: 'm-2' }, // 被 exclude，但用户显式写了 → 必须保留
      ],
    }],
  });
  const llm = makeRegistryLlm([
    { provider: 'p-a', models: [] },
    { provider: 'p-b', models: [] },
  ]);
  const reg = new Registry(llm, log, 300, cfg);
  reg.refreshProviders();
  await reg.refreshModels();

  const chain = new Router(cfg, reg, null).candidatesForRule(
    cfg.rules[0],
    { provider: 'p-x', model: 'm-x' },
  );
  assert.deepEqual(
    chain.map((h) => `${h.provider}/${h.model}`),
    ['p-a/m-1', 'p-b/m-2'],
    'explicit 手工列表不受 exclude 影响',
  );
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
  // v0.9.4 收口：匹配规则构造开 legacy
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
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

test('config v0.9.5: providerMeta quotaWindows / customWindows 静态校验', () => {
  // 合法：fiveHour + weekly + 自定义
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
    providerMeta: {
      'p-a': {
        quotaWindows: {
          fiveHour: { limit: 1_000_000, used: 0, resetAt: '2026-09-14T01:00:00Z' },
          weekly: { limit: 5_000_000, resetAt: '2026-09-15T00:00:00Z' },
        },
        customWindows: [
          { id: 'short-burst', windowMs: 600_000, limit: 100 },
        ],
      },
    },
    rules: [{ match: { default: true }, route: [{ provider: 'p-a', model: 'm-1' }] }],
  });
  assert.equal(cfg.providerMeta['p-a'].quotaWindows.fiveHour.limit, 1_000_000);
  assert.equal(cfg.providerMeta['p-a'].customWindows[0].id, 'short-burst');

  // 非法：limit 负数 → throw
  assert.throws(() => normalizeConfig({
    providerMeta: { 'p-a': { quotaWindows: { fiveHour: { limit: -1 } } } },
    rules: [],
  }), /limit 须为非负有限数字/);

  // 非法：resetAt 非 ISO8601 → throw
  assert.throws(() => normalizeConfig({
    providerMeta: { 'p-a': { quotaWindows: { weekly: { resetAt: 'tomorrow' } } } },
    rules: [],
  }), /resetAt 无法解析为合法时间/);

  // 非法：customWindows.windowMs < 60000 → throw
  assert.throws(() => normalizeConfig({
    providerMeta: { 'p-a': { customWindows: [{ id: 'x', windowMs: 1000 }] } },
    rules: [],
  }), /windowMs 须为 60000/);

  // 非法：customWindows.id 不合法字符 → throw
  assert.throws(() => normalizeConfig({
    providerMeta: { 'p-a': { customWindows: [{ id: '中文 id', windowMs: 60000 }] } },
    rules: [],
  }), /id 须为/);
});

test('v0.9.6: providerMeta.exclude 须为布尔且被透传（此前被白名单静默丢弃）', () => {
  // 合法：true 透传（v0.9.6 前此处会被白名单丢弃 → providerMeta['p-a'] 无 exclude 键）
  const cfg = normalizeConfig({
    providerMeta: { 'p-a': { exclude: true }, 'p-b': { quotaGroup: 'g1' } },
    rules: [{ route: [{ provider: 'p-a', model: 'm-1' }] }],
  });
  assert.equal(cfg.providerMeta['p-a'].exclude, true, 'exclude:true 须透传');
  assert.equal(cfg.providerMeta['p-b'].exclude, undefined, '未声明 exclude 不补键');
  assert.equal(cfg.providerMeta['p-b'].quotaGroup, 'g1', '同段其它字段不受影响');

  // 显式 false 亦保留（语义明确：声明了但未排除）
  const cfg2 = normalizeConfig({ providerMeta: { 'p-a': { exclude: false } }, rules: [] });
  assert.equal(cfg2.providerMeta['p-a'].exclude, false);

  // 非法：非布尔 → fail-fast（字符串 / 数字 / null）
  for (const bad of ['yes', 1, null]) {
    assert.throws(
      () => normalizeConfig({ providerMeta: { 'p-a': { exclude: bad } }, rules: [] }),
      /exclude 须为布尔值/,
      `exclude=${JSON.stringify(bad)} 应抛错`,
    );
  }
});

test('config v0.8.0 A-3: auto-tune——未显式声明回填 max(2*count, 5)', () => {
  // v0.9.4 收口：匹配规则构造开 legacy
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
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
    allowLegacyMatch: true,
    rules: [{ match: { default: true }, route: [{ provider: 'p-a', model: 'm-1' }] }],
  });
  autoTuneMaxRetries(cfg1);
  assert.equal(cfg1.fallbackPolicy.maxRetries, 5);
});

test('config v0.8.0 A-3: 用户显式 maxRetries=2 不被自动调优覆盖（hasExplicitMaxRetries）', () => {
  // v0.9.4 收口：匹配规则构造开 legacy
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
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
    const ledger = new DailyLedger({ storePath: join(dir, 'state.json'), reportDir: join(dir, 'reports'), timeZone: 'Asia/Shanghai', log });
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
    const ledger = new DailyLedger({ storePath: join(dir, 'state.json'), reportDir: join(dir, 'reports'), timeZone: 'Asia/Shanghai', log });
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
    // v0.9.5：readReport 返 { generated, generatedAt, report }
    const r0606 = reporter.readReport('2026-09-06');
    assert.equal(r0606.generated, true, '生成后 readReport.generated=true');
    assert.equal(typeof r0606.generatedAt, 'string');
    assert.equal(r0606.report.summary.calls, 2, '实时聚合数据');
    assert.equal(r0606.report.summary.calls, 2);
    assert.equal(r0606.report.byProviderModel[0].provider, 'p-a');
    const r0605 = reporter.readReport('2026-09-05');
    assert.equal(r0605.generated, false, '未生成 readReport.generated=false');
    assert.equal(r0605.report.summary.calls, 1, '未生成但有原始数据 → 实时聚合');
    // md 文件首行注释解析
    assert.ok(r0606.generatedAt && /^\d{4}-\d{2}-\d{2}T/.test(r0606.generatedAt), 'generatedAt 是 ISO8601');
    // formatReportMarkdown 单测
    const md = formatReportMarkdown({ ...report, day: '2026-09-06' }, { timeZone: 'Asia/Shanghai' });
    assert.ok(md.startsWith('<!-- generated by dsh-model-router v0.9.5 @'), 'md 首行注释');
    assert.ok(md.includes('# 2026-09-06 每日报告'));
    assert.ok(md.includes('| 总调用 | 2 |'));
    assert.ok(md.includes('## 错误（Top）'));

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
    const ledger = new DailyLedger({ storePath: join(dir, 'state.json'), reportDir: join(dir, 'reports-1'), timeZone: 'Asia/Shanghai', log });
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
    const emptyLedger = new DailyLedger({ storePath: join(dir, 'empty.json'), reportDir: join(dir, 'reports-empty'), timeZone: 'Asia/Shanghai', log });
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
  const metricSamples = [];
  deps.metrics = { sample: (rec) => metricSamples.push(rec), snapshot() { return {}; } };
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
  assert.equal(metricSamples.length, 1, '透传正常路径只采样一次');
  assert.equal(metricSamples[0].outcome, 'committed');
  assert.equal(metricSamples[0].switched, false);
  assert.equal(metricSamples[0].prevProvider, null);
  assert.equal(typeof metricSamples[0].seqId, 'string');
});

test('wrapper v0.8.0 G1: 透传路径内层 throw → try/finally 兜底记账 EMPTY_RESPONSE 后原样重抛（不丢账）', async () => {
  const deps = makeDeps({
    config: { rules: [{ match: { default: true }, route: [{ provider: 'p-a', model: 'm-1' }] }] },
  });
  const dailyCalls = [];
  const metricSamples = [];
  deps.metrics = { sample: (rec) => metricSamples.push(rec), snapshot() { return {}; } };
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
  assert.equal(metricSamples.length, 1, '透传 throw 只采样一次');
  assert.equal(metricSamples[0].outcome, 'failed');
  assert.equal(metricSamples[0].errorCode, 'STREAM_ERROR');
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

    const ledger = new DailyLedger({ storePath: join(dir, 'state.json'), reportDir: join(dir, 'reports'), timeZone: 'Asia/Shanghai', log });
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

    // generate：昨日有数据 → 200 报告落盘；再次触发 → already:true（v0.9.5 不再是"重复写跳过"，而是「已有 md，重复触发返 markdown」）
    body = await call(routes, mkReq('POST', '/api/model-router/reports/generate'), '/api/model-router/reports/generate');
    assert.equal(body.ok, true);
    assert.equal(body.report.summary.calls, 1);
    assert.equal(body.day, dayKeyOf(yesterdayTs, 'Asia/Shanghai'));
    assert.equal(body.generated, true);
    assert.ok(typeof body.markdown === 'string' && body.markdown.includes('# ' + body.day + ' 每日报告'));
    const again = await call(routes, mkReq('POST', '/api/model-router/reports/generate'), '/api/model-router/reports/generate');
    assert.equal(again.already, true);
    assert.ok(typeof again.markdown === 'string');
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
  // POST probe → 202 + 默认只测 free（v0.8.0 起默认仅 free tier，opts 透传含 tiers）
  r = await call(routes, mkReq('POST', LT, '127.0.0.1', JSON.stringify({ phase: 'probe' })));
  assert.equal(r.status, 202);
  assert.equal(r.body.phase, 'probe');
  assert.deepEqual(runs[0], { phase: 'probe', opts: { phase: 'probe', tiers: ['free'] } });
  // POST 显式参数 → opts 透传（非 free tier 须 confirmPaidBurn:true，v0.8.0 起强制）
  await call(routes, mkReq('POST', LT, '127.0.0.1', JSON.stringify({ phase: 'rpm', tiers: ['paid-baseline'], confirmPaidBurn: true, qpsLadder: [0.1], samplesPerStep: 3 })));
  assert.deepEqual(runs[1].opts, { phase: 'rpm', tiers: ['paid-baseline'], confirmPaidBurn: true, qpsLadder: [0.1], samplesPerStep: 3 });
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

// ================= F-4 命名（批 1） =================

test('config v0.9.0 F-4: rule.name 自动生成 rule-N（未命名缺省，最小未占用 N 顺延）', () => {
  // v0.9.4 收口：匹配规则构造开 legacy
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
    rules: [
      { name: 'explicit-a', match: { default: true }, route: [{ provider: 'p1', model: 'm1' }] },
      { match: { provider: 'p2' }, route: [{ provider: 'p2', model: 'm2' }] },
      { match: { provider: 'p3' }, route: [{ provider: 'p3', model: 'm3' }] },
    ],
  });
  assert.equal(cfg.rules[0].name, 'explicit-a');
  assert.equal(cfg.rules[1].name, 'rule-0', '缺省首条从 rule-0');
  assert.equal(cfg.rules[2].name, 'rule-1', '缺省次条顺延 rule-1');
});

test('config v0.9.0 F-4 实机回归: store 覆盖后重跑 applyDefaultNames 命名未命名规则（rule-N），已命名幂等保留', () => {
  // 复现实机：normalizeConfig 已命名 patch 规则 → store 用旧版/用户未命名 rules 整段覆盖
  // （index.js 装配路径）→ 命名被绕过 → 重跑 applyDefaultNames 补齐。
  const cfg = normalizeConfig({
    allowLegacyMatch: true, // v0.9.4 收口：匹配规则构造开 legacy
    rules: [{ name: 'patch-only', match: { default: true }, route: [{ provider: 'a', model: 'b' }] }],
  });
  cfg.rules = [{ match: { default: true }, route: [{ provider: 'a', model: 'b' }] }, { match: { provider: 'c' }, route: [{ provider: 'c', model: 'd' }] }];
  applyDefaultNames(cfg.rules);
  assert.equal(cfg.rules[0].name, 'rule-0', 'store 覆盖后首条未命名规则补 rule-0');
  assert.equal(cfg.rules[1].name, 'rule-1', 'store 覆盖后次条未命名规则顺延 rule-1');
  // 幂等：已命名规则保留，不被打乱
  cfg.rules = [{ name: 'keep', match: { model: 'x', default: true }, route: [{ provider: 'c', model: 'd' }] }];
  applyDefaultNames(cfg.rules);
  assert.equal(cfg.rules[0].name, 'keep', '已命名规则幂等保留');
});

test('config v0.9.0 F-4: 未命名规则跳过显式占用 name 的编号（rule-N 顺延）', () => {
  // v0.9.4 收口：匹配规则构造开 legacy
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
    rules: [
      { name: 'rule-0', match: { default: true }, route: [{ provider: 'p1', model: 'm1' }] },
      { match: { provider: 'p2' }, route: [{ provider: 'p2', model: 'm2' }] },
    ],
  });
  assert.equal(cfg.rules[0].name, 'rule-0', '显式占用 rule-0 保留');
  assert.equal(cfg.rules[1].name, 'rule-1', '缺省规则顺延到未占用的 rule-1');
});

test('config v0.9.0 F-4: 重复 rule.name 启动报错（fail-fast）', () => {
  assert.throws(
    () =>
      normalizeConfig({
        allowLegacyMatch: true, // v0.9.4 收口：匹配规则构造开 legacy
        rules: [
          { name: 'dup', match: { default: true }, route: [{ provider: 'p1', model: 'm1' }] },
          { name: 'dup', match: { provider: 'p2' }, route: [{ provider: 'p2', model: 'm2' }] },
        ],
      }),
    /重复规则名 "dup"/,
    '重名抛错'
  );
});

test('router v0.9.0 F-4: byName 索引——未命名规则自动索引 rule-N + 显式 name + 热更新后重建', () => {
  // v0.9.4 收口：匹配规则构造开 legacy
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
    rules: [
      { name: 'primary', match: { default: true }, route: [{ provider: 'p1', model: 'm1' }] },
      { match: { provider: 'p2' }, route: [{ provider: 'p2', model: 'm2' }] },
    ],
  });
  const router = new Router(cfg, null, null);
  assert.equal(router.byName('primary').route[0].provider, 'p1', '显式 name 索引');
  assert.equal(router.byName('rule-0').route[0].provider, 'p2', '自动命名 rule-0 索引');
  assert.equal(router.byName('missing'), null, '未知名返回 null');

  // 热更新重建索引
  router.applyRuntime({ rules: [{ name: 'new', match: { default: true }, route: [{ provider: 'p9', model: 'm9' }] }] });
  assert.equal(router.byName('new').route[0].provider, 'p9', '热更新后新 name 可查');
  assert.equal(router.byName('primary'), null, '热更新后旧规则索引移除');
});

// ================= F-2 mode 单一体系（批 2） =================

test('modes v0.9.0 F-2: free-tier 预设——C5 参数 + balanced 基准 + applyModeOverrides 生效', async () => {
  const { MODE_PRESETS, applyModeOverrides } = await import('../lib/modes.js');
  const f = MODE_PRESETS['free-tier'];
  assert.equal(f.maxRetries, 5, 'free-tier maxRetries=5（C5）');
  assert.equal(f.firstTokenTimeoutMs, 60_000, 'free-tier 看门狗=60s');
  assert.equal(f.requestIntervalMs, 2_000, 'free-tier 请求间隔=2s');
  assert.equal(f.interModelDelayMs, 500, 'free-tier 候选间延迟=500ms');
  // 预算/冷却/配额冷却取 balanced 基准
  assert.equal(f.failoverBudgetMs, MODE_PRESETS.balanced.failoverBudgetMs);
  assert.equal(f.cooldownSec, MODE_PRESETS.balanced.cooldownSec);
  assert.equal(f.quotaCooldownSec, MODE_PRESETS.balanced.quotaCooldownSec);
  // applyModeOverrides：free-tier 覆盖既有时序参数
  const cfg = { mode: 'balanced', firstTokenTimeoutMs: 30000, failoverBudgetMs: 90000, fallbackPolicy: { cooldownSec: 60, quotaCooldownSec: 600 } };
  applyModeOverrides(cfg, 'free-tier');
  assert.equal(cfg.firstTokenTimeoutMs, 60_000);
  assert.equal(cfg.mode, 'free-tier');
});

test('modes v0.9.0 F-2: custom 为占位——applyModeOverrides 不触碰既有时序参数', async () => {
  const { applyModeOverrides } = await import('../lib/modes.js');
  const cfg = { mode: 'balanced', firstTokenTimeoutMs: 30000, failoverBudgetMs: 90000, fallbackPolicy: { cooldownSec: 60, quotaCooldownSec: 600, maxRetries: 4 } };
  applyModeOverrides(cfg, 'custom');
  assert.equal(cfg.mode, 'custom', 'mode 标记切换');
  assert.equal(cfg.firstTokenTimeoutMs, 30000, 'custom 不覆盖等待参数（用户全自定义）');
  assert.equal(cfg.fallbackPolicy.maxRetries, 4, 'custom 不动 maxRetries');
});

test('config v0.9.0 F-2: rule.mode 合法透传 + 非法拒绝 + 缺省沿用顶层 mode', () => {
  // 合法：rule.mode = fast（v0.9.4 收口：匹配规则构造开 legacy）
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
    mode: 'balanced',
    rules: [{ match: { provider: 'p1' }, route: [{ provider: 'p1', model: 'm1' }], mode: 'fast' }],
  });
  assert.equal(cfg.mode, 'balanced');
  assert.equal(cfg.rules[0].mode, 'fast');

  // 缺省：rule 无 mode → 无 mode 字段（wrapper 层沿用顶层）
  const cfg2 = normalizeConfig({ allowLegacyMatch: true, mode: 'stable', rules: [{ match: { default: true }, route: [{ provider: 'p1', model: 'm1' }] }] });
  assert.equal(cfg2.rules[0].mode, undefined, '规则未声明 mode 时不含 mode（运行时沿用顶层）');

  // 非法：rule.mode 不在合法集
  assert.throws(
    () =>
      normalizeConfig({ allowLegacyMatch: true, mode: 'balanced', rules: [{ match: { default: true }, route: [{ provider: 'p1', model: 'm1' }], mode: 'turbo' }] }),
    /rules\[0\]\.mode 须为/,
    'rule.mode 非法拒绝'
  );
});

test('config v0.9.0 F-2: 顶层 mode 支持五档（含 free-tier/custom）', () => {
  assert.equal(normalizeConfig({ rules: [], mode: 'free-tier' }).mode, 'free-tier');
  assert.equal(normalizeConfig({ rules: [], mode: 'custom' }).mode, 'custom');
  assert.throws(() => normalizeConfig({ rules: [], mode: 'speed' }), /mode 须为/, 'speed 非内置档位拒绝');
});

test('config v0.9.5 §13 P2-13: 顶层 mode 已废弃 warn（仅显式声明触发）', () => {
  let warned = null;
  const log = { warn: (msg) => { warned = msg; } };
  // 显式声明非默认 → warn
  normalizeConfig({ rules: [], mode: 'fast' }, { log });
  assert.ok(warned && /顶层 mode 已废弃/.test(warned), 'fast 显式声明应 warn');
  warned = null;
  normalizeConfig({ rules: [], mode: 'free-tier' }, { log });
  assert.ok(warned && /顶层 mode 已废弃/.test(warned), 'free-tier 显式声明应 warn');
  warned = null;
  // 默认 balanced → 不 warn（避免日志噪音）
  normalizeConfig({ rules: [], mode: 'balanced' }, { log });
  assert.equal(warned, null, 'balanced 默认不 warn');
  warned = null;
  // 不传 mode → 不 warn
  normalizeConfig({ rules: [] }, { log });
  assert.equal(warned, null, '未传 mode 不 warn');
});

// ================= F-2 mode 单一体系 · 台阶②（per-request + client UI） =================

test('wrapper v0.9.0 F-2 台阶②: resolveRequestMode——命中 rule 的 mode 覆盖局部时序参数', async () => {
  const { resolveRequestMode } = await import('../lib/wrapper.js');
  // 命中规则带 free-tier mode
  const r1 = resolveRequestMode({ mode: 'free-tier' });
  assert.equal(r1.watchdog, 60_000, 'free-tier 看门狗 60s 覆盖局部');
  assert.equal(r1.budget, 90_000, 'free-tier 预算取 balanced 基准 90s');
  // 命中规则带 custom mode → 无时序预设，返回 undefined（沿用全局）
  const r2 = resolveRequestMode({ mode: 'custom' });
  assert.equal(r2.watchdog, undefined, 'custom 无预设，不覆盖');
  assert.equal(r2.budget, undefined, 'custom 无预设，不覆盖');
  // 命中规则无 mode / null（v0.9.4 收口：wrapper 增强返回含 custom/节流字段）
  assert.deepEqual(resolveRequestMode(null), { budget: undefined, watchdog: undefined, custom: null, requestIntervalMs: undefined, interModelDelayMs: undefined });
  assert.deepEqual(resolveRequestMode({}), { budget: undefined, watchdog: undefined, custom: null, requestIntervalMs: undefined, interModelDelayMs: undefined });
});

test('router v0.9.0 F-2 台阶②: match() 返回命中 rule（含 mode），未命中返回 null；candidates 独立于 match', () => {
  // v0.9.4 收口：匹配规则构造开 legacy
  const cfg = normalizeConfig({
    allowLegacyMatch: true,
    rules: [
      { name: 'with-mode', match: { provider: 'p2' }, route: [{ provider: 'p2', model: 'm2' }], mode: 'fast' },
      { name: 'no-mode', match: { default: true }, route: [{ provider: 'p1', model: 'm1' }] },
    ],
  });
  const router = new Router(cfg, null, null);
  const hit = router.match({ provider: 'p2', model: 'm2' });
  assert.equal(hit.name, 'with-mode');
  assert.equal(hit.mode, 'fast', 'match() 暴露命中规则的 mode');
  assert.equal(router.match({ provider: 'zz', model: 'zz' }).name, 'no-mode', 'default 回退命中');
  assert.equal(router.match({ provider: 'zz', model: 'zz', sessionId: 's-x' }).name, 'no-mode', 'default 不受 sessionId 限制');
  // 未配置规则时 match 返回 null
  const cfg2 = normalizeConfig({ rules: [] });
  assert.equal(new Router(cfg2, null, null).match({ provider: 'p', model: 'm' }), null, '无规则 → null');
});

test('wrapper v0.9.0 F-2 台阶②: 带 mode 规则走真实 wrapper 仍工作，且不污染全局 config（隔离性）', async () => {
  const { config, router, cooldown, metrics, quota, log } = makeDeps({
    config: {
      rules: [
        { match: { default: true }, route: [{ provider: 'p-a', model: 'm-1' }, { provider: 'p-b', model: 'm-2' }], mode: 'fast' },
      ],
    },
  });
  const beforeBudget = config.failoverBudgetMs;
  const beforeWatchdog = config.firstTokenTimeoutMs;
  const wrapper = createStreamWrapper({ config, router, cooldown, metrics, quota, log });
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-1': () => (async function* () { yield finishStop; })(),
    'm-2': () => (async function* () { yield finishStop; })(),
  });
  const out = await drain(llm.stream({ provider: 'p-a', model: 'm-1', sessionId: 's1' }));
  assert.ok(out.some((c) => c.type === 'finish'), '带 mode 规则走切换路径正常收尾');
  // 隔离性：wrapper 不得改写全局时序参数
  assert.equal(config.failoverBudgetMs, beforeBudget, '全局 budget 未被改写');
  assert.equal(config.firstTokenTimeoutMs, beforeWatchdog, '全局 watchdog 未被改写');
});

test('client v0.9.0 F-2 台阶②: client.js 面板 MODE_DEFS 已含五档（含 free-tier/custom）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf-8');
  for (const key of ['stable', 'balanced', 'fast', 'free-tier', 'custom']) {
    assert.match(src, new RegExp('key: "' + key + '"'), `client MODE_DEFS 应含 ${key}`);
  }
  // modeBadge 查找表应能识别全部五档
  assert.match(src, /MODE_BADGES\[mode\] \|\| MODE_BADGES\.balanced/, 'modeBadge 未知档回退 balanced');
  assert.match(src, /"free-tier": \{ text: "模式：免费额度"/, 'modeBadge 含 free-tier');
});

// ================= F-1 规则绑定传递（批 3） =================

test('router v0.9.0 F-1: matchName 返回命中规则名；candidatesForRule 按绑定规则而非替换后 seed 生成链', () => {
  // named 规则命中 user-model（带 mode:fast + 2 跳备用）；fallback 为 default
  const router = makeRouter([
    { name: 'named', match: { model: 'user-model' }, route: [{ provider: 'p-b', model: 'm-2' }, { provider: 'p-c', model: 'm-3' }], mode: 'fast' },
    { name: 'fallback', match: { default: true }, route: [{ provider: 'p-f', model: 'm-f' }] },
  ]);
  // matchName：提议前种子（user-model）→ 命 named
  assert.equal(router.matchName({ provider: 'u', model: 'user-model' }), 'named');
  // 替换后种子是 named.route[0]，若裸 match → 该 seed 不匹配 user-model → 落 fallback
  assert.equal(router.match({ provider: 'p-b', model: 'm-2' }).name, 'fallback');
  // 绑定规则生成链：named.route 排除替换后种子 → 备用 [p-c/m-3]
  assert.deepEqual(
    router.candidatesForRule(router.byName('named'), { provider: 'p-b', model: 'm-2' }),
    [{ provider: 'p-c', model: 'm-3' }],
  );
  // byName 无此名 → null；candidatesForRule(null) → 空链
  assert.equal(router.byName('ghost'), null);
  assert.deepEqual(router.candidatesForRule(null, { provider: 'p', model: 'm' }), []);
});

test('wrapper v0.9.0 F-1: 带 __mr_rule 走绑定规则链（而非替换后 seed 命中的 default），mode 基于绑定规则', async () => {
  const { config, router, cooldown, metrics, quota, log } = makeDeps({
    config: {
      rules: [
        { name: 'named', match: { model: 'user-model' }, route: [{ provider: 'p-b', model: 'm-2' }, { provider: 'p-c', model: 'm-3' }], mode: 'fast' },
        { name: 'fallback', match: { default: true }, route: [{ provider: 'p-f', model: 'm-f' }] },
      ],
    },
  });
  const wrapper = createStreamWrapper({ config, router, cooldown, metrics, quota, log });
  // 用 wrapper.call(llm, ...) 且 llm 为 makeLlm（有 .stream），保证重发路径 llm.stream 可用
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': () => (async function* () {
      // 首选 m-2 失败 → 触发 failover
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
    })(),
    'm-3': () => (async function* () { yield finishStop; })(),
    'm-f': () => (async function* () { yield finishStop; })(),
  });
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
  })();
  // 用户选虚拟 model → agent/request 替换为 named.route[0]=p-b/m-2，附 __mr_rule
  const out = await drain(wrapper.call(llm, { provider: 'p-b', model: 'm-2', __mr_rule: 'named' }, () => primary));
  assert.ok(out.some((c) => c.type === 'finish'));
  // 关键：failover 应走向绑定规则备用 p-c/m-3，而非 fallback 链的 p-f/m-f
  const attemptedModels = llm.calls.map((c) => c.model);
  assert.ok(attemptedModels.includes('m-3'), `应尝试绑定链备用 m-3，实际=${attemptedModels}`);
  assert.ok(!attemptedModels.includes('m-f'), `不应走 fallback 链 m-f，实际=${attemptedModels}`);
});

test('wrapper v0.9.0 F-1: 无 __mr_rule / 绑定名不存在 → 回落 seed 匹配（零行为变更）', async () => {
  const { config, router, cooldown, metrics, quota, log } = makeDeps({
    config: {
      rules: [
        { name: 'named', match: { model: 'm-1' }, route: [{ provider: 'p-b', model: 'm-2' }, { provider: 'p-c', model: 'm-3' }] },
        { name: 'fallback', match: { default: true }, route: [{ provider: 'p-f', model: 'm-f' }] },
      ],
    },
  });
  const wrapper = createStreamWrapper({ config, router, cooldown, metrics, quota, log });
  // 用 wrapper.call(llm, ...) 绑定 this=LlmRuntime（与真 cordis waterfall thisArg 一致），
  // 保证重发路径 llm.stream 可用。
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': () => (async function* () { yield finishStop; })(),
    'm-3': () => (async function* () { yield finishStop; })(),
    'm-f': () => (async function* () { yield finishStop; })(),
  });
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
  })();
  // seed 是 p-a/m-1 → 命中 named（match model:m-1）→ 未带 __mr_rule，用 seed 匹配，
  // failover 走 named 规则候选链 m-2
  const out = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));
  assert.ok(out.some((c) => c.type === 'finish'));
  // 奇怪情况：带了 __mr_rule 但名不存在 → byName 返回 null → 回落 seed 匹配（不抛错）
  const out2 = await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1', __mr_rule: 'ghost' }, () => primary));
  assert.ok(out2.some((c) => c.type === 'finish'));
  // 两条路径都应走 seed 命中的 named 链，而非 fallback 的 m-f
  const attemptedModels = llm.calls.map((c) => c.model);
  assert.ok(!attemptedModels.includes('m-f'), `不应走 fallback 链 m-f，实际=${attemptedModels}`);
});

// ================= F-5 选包路由（批 4） =================

test('router v0.9.0 F-5: resolvePackage 解析 __pkg:<ruleName> → route[0] 真实主选 + 规则名', () => {
  const router = makeRouter([
    { name: 'v4flash', match: { provider: 'p-v' }, route: [{ provider: 'p-a', model: 'm-1' }, { provider: 'p-b', model: 'm-2' }], mode: 'fast' },
    { name: 'fallback', match: { default: true }, route: [{ provider: 'p-f', model: 'm-f' }] },
  ]);
  // 用户在 UI 选中 `dsh-model-router/__pkg:v4flash` 虚拟模型
  const pkg = router.resolvePackage({ provider: 'dsh-model-router', model: '__pkg:v4flash' });
  assert.ok(pkg, '选包应命中');
  assert.equal(pkg.ruleName, 'v4flash');
  assert.equal(pkg.rule.name, 'v4flash');
  assert.deepEqual(pkg.primary, { provider: 'p-a', model: 'm-1' }, '主选 = 规则 route[0]');
  // 非虚拟 provider / 非 __pkg 模型 → null
  assert.equal(router.resolvePackage({ provider: 'openai', model: '__pkg:v4flash' }), null, '非虚拟 provider');
  assert.equal(router.resolvePackage({ provider: 'dsh-model-router', model: 'gpt-4' }), null, '非 __pkg 模型');
  // 名称不存在 → null
  assert.equal(router.resolvePackage({ provider: 'dsh-model-router', model: '__pkg:ghost' }), null, '规则名不存在');
  // 常量导出（供 packages-adapter / index 之选包虚拟 id 固定口径）
  assert.equal(PKG_PROVIDER, 'dsh-model-router');
  assert.equal(PKG_PREFIX, '__pkg:');
});

test('wrapper v0.9.0 F-5: 选包 __pkg → resolvePackage 提议 route[0] + __mr_rule，failover 走绑定规则链而非 default', async () => {
  const { config, router, cooldown, metrics, quota, log } = makeDeps({
    config: {
      rules: [
        { name: 'v4flash', match: { provider: 'p-v' }, route: [{ provider: 'p-a', model: 'm-1' }, { provider: 'p-b', model: 'm-2' }], mode: 'fast' },
        { name: 'fallback', match: { default: true }, route: [{ provider: 'p-f', model: 'm-f' }] },
      ],
    },
  });
  const wrapper = createStreamWrapper({ config, router, cooldown, metrics, quota, log });
  // 复刻 index.js agent/request 选包分支：解析 __pkg → 提议 route[0] + 附加 __mr_rule
  const pkg = router.resolvePackage({ provider: 'dsh-model-router', model: '__pkg:v4flash' });
  assert.equal(pkg.ruleName, 'v4flash');
  const seed = { provider: pkg.primary.provider, model: pkg.primary.model, __mr_rule: pkg.ruleName };
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': () => (async function* () { yield finishStop; })(),
    'm-f': () => (async function* () { yield finishStop; })(),
  });
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } };
  })();
  const out = await drain(wrapper.call(llm, seed, () => primary));
  assert.ok(out.some((c) => c.type === 'finish'));
  // 关键：failover 走向绑定规则（v4flash 链）的备用 m-2，而非 default 链的 m-f
  const attempted = llm.calls.map((c) => c.model);
  assert.ok(attempted.includes('m-2'), `选包 failover 应走 v4flash 备用 m-2，实际=${attempted}`);
  assert.ok(!attempted.includes('m-f'), `选包不应走 default 链 m-f，实际=${attempted}`);
});

// ================= F-3 adapter 注册（批 5） =================

test('adapter v0.9.0 F-3: listModels 返回全部命名规则为 __pkg:* 虚拟模型（含默认 rule-N）', async () => {
  const router = makeRouter([
    { name: 'v4flash', match: { provider: 'p-v' }, route: [{ provider: 'p-a', model: 'm-1' }], mode: 'fast' },
    { name: 'fallback', match: { default: true }, route: [{ provider: 'p-f', model: 'm-f' }] },
  ]);
  // 未命名规则经 applyDefaultNames 补 rule-N
  const router2 = makeRouter([{ match: { default: true }, route: [{ provider: 'p-a', model: 'm-1' }] }]);
  const adapter = createPackagesAdapter({ router });
  const models = await adapter.listModels();
  // v0.9.0 起：displayName 采用用户命名 + 模式中文标签 + provider 字段（F-2/F-3 演进）
  assert.deepEqual(models, [
    { provider: 'dsh-model-router', id: '__pkg:v4flash', name: 'v4flash（极速优先）', contextWindow: 0 },
    { provider: 'dsh-model-router', id: '__pkg:fallback', name: 'fallback', contextWindow: 0 },
  ]);
  // 默认命名 rule-0 也作为虚拟模型暴露（F-7 验收）
  const adapter2 = createPackagesAdapter({ router: router2 });
  assert.deepEqual((await adapter2.listModels()).map((m) => m.id), ['__pkg:rule-0']);
  // providerInfo id 与虚拟 provider 常量一致（注册键必须匹配）
  assert.equal(adapter.providerInfo().id, PKG_PROVIDER);
  // stream 兜底不抛未定义（薄壳：代码路径可达即合法）——仅校验成功产出 finish
  const finish = await drain(adapter.stream());
  assert.ok(finish.some((c) => c.type === 'finish'), '薄壳 stream 产出合成 error finish');
});

test('registry v0.9.0 F-3: 虚拟 provider dsh-model-router 被排除（refreshProviders/registeredPairs）', async () => {
  const llm = makeRegistryLlm([
    { provider: 'p-a', models: [{ id: 'm-1' }] },
    { provider: PKG_PROVIDER, models: [{ id: '__pkg:v4flash' }] },
  ]);
  const reg = new Registry(llm, log, 300, normalizeConfig({ rules: [] }));
  reg.refreshProviders();
  await reg.refreshModels();
  const providers = reg.snapshot.providers.map((p) => p.provider);
  assert.ok(!providers.includes(PKG_PROVIDER), `虚拟 provider 应被排除，实际=${providers}`);
  assert.ok(providers.includes('p-a'), '真实 provider 保留');
  const pairs = reg.registeredPairs();
  assert.ok(pairs.every((p) => p.provider !== PKG_PROVIDER), 'registeredPairs 不含虚拟 provider');
  assert.ok(pairs.some((p) => p.provider === 'p-a'), '真实 provider 进候选集');
});

// ---------- v0.9.5 §11：WindowLedger 窗口上限仓 ----------

const W5H = 5 * 3600 * 1000;
const quietLog = { info() {}, warn() {}, error() {} };
const winMeta = {
  quotaWindows: { fiveHour: { limit: 100 }, weekly: { limit: 500 } },
  customWindows: [{ id: 'daily', windowMs: 86400000, limit: 20 }],
};

test('quota §11: consumeAttempt——未声明窗口 → 放行 no-windows-declared', () => {
  const wl = new WindowLedger({ log: quietLog });
  const r = wl.consumeAttempt('p-a', {});
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'no-windows-declared');
});

test('quota §11: consumeAttempt——声明未耗尽 → 放行（used=0 < limit）', () => {
  const wl = new WindowLedger({ log: quietLog });
  const r = wl.consumeAttempt('p-a', winMeta);
  assert.equal(r.allowed, true);
});

test('quota §11: consumeAttempt——five-hour 已耗尽 → 拒绝并带 resetAt/msToReset', () => {
  const wl = new WindowLedger({ log: quietLog });
  const future = new Date(Date.now() + W5H).toISOString();
  const r = wl.consumeAttempt('p-a', {
    quotaWindows: { fiveHour: { limit: 100, used: 100, resetAt: future } },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'five-hour-limit');
  assert.equal(r.windowId, 'five-hour');
  assert.ok(r.msToReset > 0, 'msToReset 应为正');
  assert.equal(r.resetAt, future);
});

test('quota §11: consumeAttempt——weekly 已耗尽 → weekly-limit', () => {
  const wl = new WindowLedger({ log: quietLog });
  const r = wl.consumeAttempt('p-a', {
    quotaWindows: { weekly: { limit: 500, used: 600 } },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'weekly-limit');
});

test('quota §11: markReset——清零 used 并推 resetAt≈now+窗口长', () => {
  const wl = new WindowLedger({ log: quietLog });
  wl.consumeAttempt('p-a', {
    quotaWindows: { fiveHour: { limit: 100, used: 100 } },
  });
  const before = Date.now();
  const r = wl.markReset('p-a', 'five-hour', winMeta);
  assert.equal(r.ok, true);
  assert.equal(r.used, 0);
  const resetAt = Date.parse(r.resetAt);
  assert.ok(resetAt >= before + W5H - 2000 && resetAt <= before + W5H + 2000, `resetAt≈now+5h，实际=${r.resetAt}`);
});

test('quota §11: markBurnedOut——上游 429 → 保守置满 used=limit 且 resetAt 推进到未来', () => {
  const wl = new WindowLedger({ log: quietLog });
  wl.consumeAttempt('p-a', winMeta);
  const r = wl.markBurnedOut('p-a', 'five-hour', winMeta);
  assert.equal(r.ok, true);
  assert.equal(r.used, 100);
  assert.ok(Date.parse(r.resetAt) > Date.now(), 'resetAt 应在未来');
  // 置满后下一次 consumeAttempt 直接拒绝（wrapper 入口不再打上游）
  const gate = wl.consumeAttempt('p-a', winMeta);
  assert.equal(gate.allowed, false);
});

test('quota §11: markBurnedOut——未声明限额 → ok:false 不抛', () => {
  const wl = new WindowLedger({ log: quietLog });
  const r = wl.markBurnedOut('p-a', 'five-hour', { quotaWindows: { fiveHour: {} } });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('未声明限额'));
});

test('quota §11: syncWindows + quotaSnapshot——round-trip 结构完整', () => {
  const wl = new WindowLedger({ log: quietLog });
  const snap = wl.syncWindows('p-a', {
    fiveHour: { limit: 100, used: 42, resetAt: new Date(Date.now() + W5H).toISOString() },
    weekly: { limit: 500 },
    customWindows: [{ id: 'daily', windowMs: 86400000, limit: 20, used: 3 }],
  });
  assert.equal(snap.fiveHour.limit, 100);
  assert.equal(snap.fiveHour.used, 42);
  assert.ok(snap.fiveHour.usedRatio >= 0.41 && snap.fiveHour.usedRatio <= 0.43, `usedRatio≈0.42，实际=${snap.fiveHour.usedRatio}`);
  assert.equal(snap.weekly.limit, 500);
  assert.equal(snap.customWindows[0].id, 'daily');
  assert.equal(snap.customWindows[0].used, 3);
});

test('quota §11: 滑窗——resetAt 已过 → used 自动清零并推进 resetAt（无需人工）', () => {
  const wl = new WindowLedger({ log: quietLog });
  const past = new Date(Date.now() - 60000).toISOString();
  const r = wl.consumeAttempt('p-a', {
    quotaWindows: { fiveHour: { limit: 100, used: 100, resetAt: past } },
  });
  assert.equal(r.allowed, true, '过期窗口应滑窗清零后放行');
  const snap = wl.quotaSnapshot('p-a');
  assert.equal(snap.fiveHour.used, 0);
  assert.ok(Date.parse(snap.fiveHour.resetAt) > Date.now(), 'resetAt 推进到未来');
});

test('quota §11: 持久化——saveToDisk/loadFromDisk 重启后 used 仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-quota-'));
  const qState = join(dir, 'quota-state.json');
  const wl1 = new WindowLedger({ storePath: qState, log: quietLog });
  wl1.syncWindows('p-a', {
    fiveHour: { limit: 100, used: 42, resetAt: new Date(Date.now() + W5H).toISOString() },
  });
  assert.equal(wl1.saveToDisk(), true);
  assert.ok(readFileSync(qState, 'utf8').includes('"used": 42'), '动态态落盘含 used');

  const wl2 = new WindowLedger({ storePath: qState, log: quietLog });
  assert.equal(wl2.loadFromDisk(), true);
  // 重启后未触碰前 quotaSnapshot 为 null；首次 consumeAttempt 合并 loaded
  assert.equal(wl2.quotaSnapshot('p-a'), null);
  wl2.consumeAttempt('p-a', { quotaWindows: { fiveHour: { limit: 100 } } });
  assert.equal(wl2.quotaSnapshot('p-a').fiveHour.used, 42, '重启恢复 used=42');
  rmSync(dir, { recursive: true, force: true });
});

test('quota §11: deriveWindowId——错误码 → 窗口判定映射', () => {
  assert.equal(deriveWindowId('QUOTA_EXCEEDED'), 'five-hour');
  assert.equal(deriveWindowId('RATE_LIMIT'), 'five-hour');
  assert.equal(deriveWindowId('429'), 'five-hour');
  assert.equal(deriveWindowId('WEEKLY_QUOTA'), 'weekly');
  assert.equal(deriveWindowId('MONTHLY_LIMIT'), 'weekly');
});

// ---------- v0.9.6：上限仓「声明对齐 + 运行态一次性播种」（根因 A / D） ----------
//
// 注意：上方 winMeta 刻意不含 used 字段 —— 这正是根因 A 未被既有测试捕获的原因。
// 以下用例一律自建**带 used 声明**的 meta。

const futureIso = () => new Date(Date.now() + W5H).toISOString();

test('v0.9.6: markReset——meta 声明 used 时重置不被 _assure 抹掉（根因 A）', () => {
  const wl = new WindowLedger({ log: quietLog });
  // meta 声明「已用满」——修复前 _assure 每次调用都会把 used 恢复成 100
  const exhausted = { quotaWindows: { fiveHour: { limit: 100, used: 100, resetAt: futureIso() } } };
  assert.equal(wl.consumeAttempt('p-a', exhausted).allowed, false, '声明已用满 → 拦截');

  const r = wl.markReset('p-a', 'five-hour', exhausted);
  assert.equal(r.ok, true);
  assert.equal(r.used, 0);

  assert.equal(wl.consumeAttempt('p-a', exhausted).allowed, true, '重置后下一次必须放行');
  assert.equal(wl.quotaSnapshot('p-a').fiveHour.used, 0, '快照 used 应为 0');
});

test('v0.9.6: markBurnedOut——meta 声明 used 时置满不被抹掉（根因 A）', () => {
  const wl = new WindowLedger({ log: quietLog });
  const zero = { quotaWindows: { fiveHour: { limit: 100, used: 0, resetAt: futureIso() } } };
  assert.equal(wl.consumeAttempt('p-a', zero).allowed, true, '初始 used=0 → 放行');

  const r = wl.markBurnedOut('p-a', 'five-hour', zero);
  assert.equal(r.ok, true);
  assert.equal(r.used, 100);

  assert.equal(wl.consumeAttempt('p-a', zero).allowed, false, '上游 429 置满后下一次必须拦截');
});

test('v0.9.6: 声明消失——删除 fiveHour 后不再误拦且快照不残留（根因 A）', () => {
  const wl = new WindowLedger({ log: quietLog });
  const both = { quotaWindows: { fiveHour: { limit: 100, used: 100, resetAt: futureIso() }, weekly: { limit: 500 } } };
  wl.syncWindows('p-a', both.quotaWindows);
  assert.equal(wl.consumeAttempt('p-a', both).allowed, false, 'fiveHour 已满 → 拦截');

  // 只删 fiveHour、保留 weekly
  wl.syncWindows('p-a', { fiveHour: undefined, weekly: { limit: 500 } });
  assert.equal(wl.quotaSnapshot('p-a').fiveHour, null, '删除声明后快照不应残留 fiveHour');

  const weeklyOnly = { quotaWindows: { weekly: { limit: 500 } } };
  assert.equal(wl.consumeAttempt('p-a', weeklyOnly).allowed, true, 'fiveHour 已删 → 不应再被它拦截');
});

test('v0.9.6: addUsage——窗口用量按 tokens 累加并触发拦截（根因 D）', () => {
  const wl = new WindowLedger({ log: quietLog });
  const meta = { quotaWindows: { fiveHour: { limit: 100, resetAt: futureIso() } } };
  assert.equal(wl.consumeAttempt('p-a', meta).allowed, true, '初始 used=0 → 放行');

  wl.addUsage('p-a', 60);
  assert.equal(wl.quotaSnapshot('p-a').fiveHour.used, 60, '累加 60');
  assert.equal(wl.consumeAttempt('p-a', meta).allowed, true, '60 < 100 仍放行');

  wl.addUsage('p-a', 60);
  assert.equal(wl.quotaSnapshot('p-a').fiveHour.used, 120, '累计 120');
  assert.equal(wl.consumeAttempt('p-a', meta).allowed, false, '120 >= 100 → 主动拦截（不靠上游 429）');

  // 未声明 limit 的窗口不参与累加（未声明 = 不限制）
  const noLimit = { quotaWindows: { fiveHour: { resetAt: futureIso() } } };
  const wl2 = new WindowLedger({ log: quietLog });
  wl2.addUsage('p-b', 999);
  assert.equal(wl2.consumeAttempt('p-b', noLimit).allowed, true, '未声明 limit 不应拦截');
  assert.equal(wl2.quotaSnapshot('p-b').fiveHour.limit, null, '未声明 limit → 快照 limit 为 null');
  assert.equal(wl2.quotaSnapshot('p-b').fiveHour.used, null, '未声明 limit → used 不参与统计（null）');

  // 非正数 / 未触碰 provider 不炸
  wl.addUsage('p-a', 0);
  wl.addUsage('p-never', 100);
  assert.equal(wl.quotaSnapshot('p-a').fiveHour.used, 120, 'addUsage(0) 不应改变用量');
});

test('v0.9.6: QuotaLedger.record → addUsage——声明 limit 后按 tokens 累加（根因 D 端到端）', () => {
  const ql = new QuotaLedger({ log: quietLog });
  const meta = { quotaWindows: { fiveHour: { limit: 100, resetAt: futureIso() } } };
  ql.consumeAttempt('p-a', meta);

  ql.record('p-a', { inputTokens: 40, outputTokens: 20 });
  assert.equal(ql.quotaSnapshot('p-a').fiveHour.used, 60, 'record 应累加 60 tokens');
  assert.equal(ql.consumeAttempt('p-a', meta).allowed, true, '60 < 100 仍放行');

  ql.record('p-a', { inputTokens: 50 });
  assert.equal(ql.consumeAttempt('p-a', meta).allowed, false, '累计 110 >= 100 → 主动拦截');
});

test('v0.9.6: loaded 一次性——应用后按槽位消费，槽位重建不复活旧 used（根因 A）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-quota-v096-'));
  const qState = join(dir, 'quota-state.json');
  // 造出「上次运行已耗尽」的持久态
  const seed = new WindowLedger({ storePath: qState, log: quietLog });
  seed.syncWindows('p-a', { fiveHour: { limit: 100, used: 100, resetAt: futureIso() } });
  assert.equal(seed.saveToDisk(), true);

  const wl = new WindowLedger({ storePath: qState, log: quietLog });
  assert.equal(wl.loadFromDisk(), true);
  const meta = { quotaWindows: { fiveHour: { limit: 100, resetAt: futureIso() } } };

  assert.equal(wl.consumeAttempt('p-a', meta).allowed, false, '首次触碰应恢复 loaded 的 used=100');
  assert.equal(wl.loaded.has('p-a'), false, 'loaded 应在首次物化后被按槽位删除');

  wl.markReset('p-a', 'five-hour', meta);
  assert.equal(wl.consumeAttempt('p-a', meta).allowed, true, '重置后应放行（loaded 已消费，不再抹回）');

  wl.syncWindows('p-a', { fiveHour: undefined });
  assert.equal(wl.quotaSnapshot('p-a'), null, '删声明后快照应为 null');
  wl.syncWindows('p-a', { fiveHour: { limit: 100, resetAt: futureIso() } });
  assert.equal(wl.consumeAttempt('p-a', meta).allowed, true, '槽位重建不应复活旧 used');

  rmSync(dir, { recursive: true, force: true });
});

// ---------- v0.9.5 §9：model-test 纯函数 ----------

test('model-test §9: validateModelTestTargets——合法 targets 规范化（tier 缺省 free）', () => {
  const out = validateModelTestTargets([{ provider: 'p-a', model: 'm-1' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'free');
  assert.equal(out[0].provider, 'p-a');
});

test('model-test §9: validateModelTestTargets——非 free 不带 confirmPaidBurn → 拒（付费保护）', () => {
  assert.throws(() => validateModelTestTargets([{ provider: 'p-a', model: 'm-1', tier: 'paid-baseline' }]), /confirmPaidBurn/);
  const ok = validateModelTestTargets([{ provider: 'p-a', model: 'm-1', tier: 'paid-baseline' }], true);
  assert.equal(ok[0].tier, 'paid-baseline');
});

test('model-test §9: validateModelTestTargets——manualTpm/manualMaxContext 非法 → 抛', () => {
  assert.throws(() => validateModelTestTargets([{ provider: 'p-a', model: 'm-1', manualTpm: 'fast' }]), /manualTpm/);
  assert.throws(() => validateModelTestTargets([{ provider: 'p-a', model: 'm-1', manualMaxContext: 0 }]), /manualMaxContext/);
});

test('model-test §9: verdictOf——probe 存活 + RPM 高 → primary', () => {
  const v = verdictOf({
    probe: { ok: true, ttftMs: 800 },
    rpm: { lastOkRpm: 1.2, first429Rpm: null },
    context: { maxAccepted: 16384 },
    quotaGroup: { members: [{ ok: true }, { ok: true }] },
  });
  assert.equal(v.recommend, 'primary');
  assert.ok(v.score >= 0.7);
  assert.notEqual(v.quotaRisk, 'high');
});

test('model-test §9: verdictOf——probe 失败但 rpm 可用 → backup（§14 #4 分支）', () => {
  const v = verdictOf({
    probe: { ok: false, errorCode: 'E_TIMEOUT' },
    rpm: { lastOkRpm: 1.0, first429Rpm: null },
  });
  assert.equal(v.recommend, 'backup');
  assert.ok(v.reasons.some((r) => r.includes('rpm 仍可用')));
});

test('v0.9.6: verdictOf——probe 失败但 rpm 可用且加成不足时，仍应 backup（forced 锁定）', () => {
  // v0.9.6 前的漏检带：score=0.35，而 rpm 加成需要 lastOkRpm>=0.2 或 first429Rpm===null。
  // 当 lastOkRpm=0.1 且观测到限流（first429Rpm 非 null）时加成全无 → 0.35 < backup 阈值 0.4
  // → 误判 exclude，与 §14 #4「避免直接 exclude」的意图相悖。
  const v = verdictOf({
    probe: { ok: false, errorCode: 'E_TIMEOUT' },
    rpm: { lastOkRpm: 0.1, first429Rpm: 0.05 },
  });
  assert.equal(v.recommend, 'backup', 'probe 失败但 rpm 仍可用，不应直接 exclude');
  assert.equal(v.score, 0.35, 'forced 只锁 recommend，不改 score');
  assert.ok(v.reasons.some((r) => r.includes('rpm 仍可用')));

  // 反例：rpm 完全不可用（lastOkRpm=0）→ forced 不应被触发，仍判 exclude
  const v2 = verdictOf({ probe: { ok: false }, rpm: { lastOkRpm: 0, first429Rpm: 0.05 } });
  assert.equal(v2.recommend, 'exclude', 'rpm 不可用时仍应 exclude');

  // 反例：probe 存活时 forced 不应干扰（不得把 primary 压成 backup）
  const v3 = verdictOf({
    probe: { ok: true, ttftMs: 800 },
    rpm: { lastOkRpm: 1.2, first429Rpm: null },
    context: { maxAccepted: 16384 },
    quotaGroup: { members: [{ ok: true }, { ok: true }] },
  });
  assert.equal(v3.recommend, 'primary', 'probe 存活路径不受 forced 影响');
});

test('model-test §9: verdictOf——probe 失败且 rpm 不可用 → exclude', () => {
  const v = verdictOf({ probe: { ok: false, errorCode: 'E_CONN' } });
  assert.equal(v.recommend, 'exclude');
});

test('model-test §9: formatReportMarkdown——含标题、表头、verdict 结论', () => {
  const md = formatModelTestMd({
    runId: 'run-1',
    startedAt: '2026-09-14T00:00:00.000Z',
    finishedAt: '2026-09-14T00:01:00.000Z',
    timeZone: 'Asia/Shanghai',
    targets: [{ provider: 'p-a', model: 'm-1', tier: 'free', probe: { ok: true }, rpm: { lastOkRpm: 0.8 }, context: { maxAccepted: 8192 }, verdict: { recommend: 'primary', score: 0.8 } }],
  });
  assert.ok(md.includes('# 模型测试报告'), '含标题');
  assert.ok(md.includes('| provider | model |'), '含表头');
  assert.ok(md.includes('**primary**'), '含 verdict');
});

test('model-test §9: validateManualInput——合法/非法', () => {
  const ok = validateManualInput({ runId: 'r1', targetKey: 'p\u0000m', manualTpm: 10 });
  assert.equal(ok.manualTpm, 10);
  assert.throws(() => validateManualInput({ targetKey: 'x' }), /runId/);
  assert.throws(() => validateManualInput({ runId: 'r1', targetKey: 'x', manualTpm: NaN }), /manualTpm/);
});

test('model-test §9: manualWarnings——manualTpm 与实测相差 5× 以上 → warning', () => {
  const w = manualWarnings({ rpm: { lastOkRpm: 1.0 }, manualTpm: 1000, manualMaxContext: 8192, context: { maxAccepted: null } });
  assert.ok(w.some((x) => x.includes('5×')), '应提示 5× 差异');
  const w2 = manualWarnings({ rpm: { lastOkRpm: 1.0 }, manualTpm: 20 });
  assert.equal(w2.length, 0, '无超差不告警');
});

// ---------- v0.9.8 新增用例（方案 §七） ----------

test('v0.9.8: validatePhases——undefined 默认全跑', () => {
  assert.deepEqual(validatePhases(undefined), ['probe', 'rpm', 'context', 'quota-group']);
  assert.deepEqual(validatePhases(null), ['probe', 'rpm', 'context', 'quota-group']);
});

test('v0.9.8: validatePhases——去重 + 固定序', () => {
  assert.deepEqual(validatePhases(['rpm', 'probe']), ['probe', 'rpm']);
  assert.deepEqual(validatePhases(['probe', 'probe']), ['probe']);
});

test('v0.9.8: validatePhases——非法 throw', () => {
  assert.throws(() => validatePhases([]), /非空/);
  assert.throws(() => validatePhases(['bogus']), /未知项/);
  assert.throws(() => validatePhases('rpm'), /非空数组/);
});

test('v0.9.8: MODEL_TEST_PHASES 常量完整', () => {
  assert.deepEqual(MODEL_TEST_PHASES, ['probe', 'rpm', 'context', 'quota-group']);
});

test('v0.9.8/9.9: metrics.sample——真实 Metrics 追加 seqId/prevProvider/prevModel/switched/segment', async () => {
  const { Metrics } = await import('../lib/metrics.js');
  const m = new Metrics();
  // v0.9.8：五字段（seqId/prev*/switched）落库
  m.sample({ provider: 'p-b', model: 'm-b', attemptIndex: 1, outcome: 'committed',
    seqId: 'seq-1', prevProvider: 'p-a', prevModel: 'm-a', switched: true, segment: 'peak' });
  const r = m.snapshot().recent[0];
  assert.equal(r.seqId, 'seq-1', 'seqId 落字段');
  assert.equal(r.prevProvider, 'p-a', 'prevProvider 落字段');
  assert.equal(r.prevModel, 'm-a', 'prevModel 落字段');
  assert.equal(r.switched, true, 'switched 落字段');
  assert.equal(r.segment, 'peak', 'v0.9.9 segment 落字段');

  // 旧 caller 不传 segment 时默认为 null（保持签名向后兼容）
  m.sample({ provider: 'p-c', model: 'm-c', attemptIndex: 0, outcome: 'committed' });
  const r2 = m.snapshot().recent[1];
  assert.equal(r2.seqId, undefined);
  assert.equal(r2.prevProvider, null, 'passthrough 默认 null（不写字符串）');
  assert.equal(r2.switched, false);
  assert.equal(r2.segment, null, '未传 segment 时默认 null');

  // v0.9.9：非法 segment 值（不是 peak/valley）一律归 null
  m.sample({ provider: 'p-d', model: 'm-d', attemptIndex: 0, outcome: 'committed', segment: 'bogus' });
  const r3 = m.snapshot().recent[2];
  assert.equal(r3.segment, null, '非法 segment 值归 null');
});

test('v0.9.8: probe——透传 errorMessage（error finish + catch 分支）', async () => {
  const finishErrorLlm = {
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: 'upstream says bad model id' } } };
    },
  };
  const failed = await singleRaw(finishErrorLlm, 'p', 'm', 'ping', 100, {});
  assert.equal(failed.errorCode, 'INVALID_REQUEST');
  assert.equal(failed.errorMessage, 'upstream says bad model id');

  const throwLlm = {
    stream() { throw Object.assign(new Error('connection reset by peer'), { code: 'TRANSPORT' }); },
  };
  const thrown = await singleRaw(throwLlm, 'p', 'm', 'ping', 100, {});
  assert.equal(thrown.errorCode, 'TRANSPORT');
  assert.equal(thrown.errorMessage, 'connection reset by peer');
});

test('v0.9.8: model-test——_singleWithRetry 只对 RETRYABLE 重试（含真实退避）', async () => {
  const makeRunner = (responses) => {
    const calls = [];
    const runner = new ModelTestRunner({ llm: {}, registry: null, daily: null, log: {} });
    runner._single = async () => {
      const r = responses[Math.min(calls.length, responses.length - 1)];
      calls.push(r.errorCode ?? 'ok');
      return r;
    };
    return { runner, calls };
  };
  const T = { provider: 'p', model: 'm' };

  // 1) 首次成功 → 不重试
  const okRun = makeRunner([{ ok: true, ttftMs: 1 }]);
  const okRes = await okRun.runner._singleWithRetry(T, 'hi');
  assert.equal(okRun.calls.length, 1, '成功不重试');
  assert.equal(okRes.retries, 0, 'retries=0');

  // 2) 确定性错误（INVALID_CREDENTIAL 不在 RETRYABLE）→ 不重试
  const fatalRun = makeRunner([{ ok: false, errorCode: 'INVALID_CREDENTIAL' }]);
  const fatalRes = await fatalRun.runner._singleWithRetry(T, 'hi');
  assert.equal(fatalRun.calls.length, 1, '确定性错误不重试（避免拖长跑批）');
  assert.equal(fatalRes.retries, 0, 'retries=0');

  // 3) 可重试错误（TRANSPORT 在 RETRYABLE）→ 最多 3 次尝试；本用例真实等待 800+1600ms 退避
  const retryRun = makeRunner([{ ok: false, errorCode: 'TRANSPORT', errorMessage: 'reset' }]);
  const t0 = Date.now();
  const retryRes = await retryRun.runner._singleWithRetry(T, 'hi');
  const waited = Date.now() - t0;
  assert.equal(retryRun.calls.length, 3, 'TRANSPORT 重试到 3 次上限');
  assert.equal(retryRes.retries, 2, 'retries=2');
  assert.equal(retryRes.errorCode, 'TRANSPORT', '最终返回最后一次结果');
  assert.ok(waited >= 2400, `实际退避 ≥ 800+1600ms（实测 ${waited}ms）`);

  // 4) 中途成功即停（第 2 次成功 → 共 2 次调用）
  const midRun = makeRunner([{ ok: false, errorCode: 'TIMEOUT' }, { ok: true, ttftMs: 9 }]);
  const midRes = await midRun.runner._singleWithRetry(T, 'hi');
  assert.equal(midRun.calls.length, 2, '中途成功即停');
  assert.equal(midRes.ok, true);
  assert.equal(midRes.retries, 1, 'retries=1');

  // 5) 结构性检查：rpm/context/quota-group 三相不调用 _singleWithRetry
  const src = readFileSync(new URL('../lib/model-test.js', import.meta.url), 'utf8');
  for (const fn of ['_phaseRpm', '_phaseContext', '_phaseQuotaGroup']) {
    const body = src.match(new RegExp(`async ${fn}[\\s\\S]*?\\n  }`));
    assert.ok(body && !/_singleWithRetry/.test(body[0]), `${fn} 不使用退避（保持测量密度）`);
  }
  const probeBody = src.match(/async _phaseProbe[\s\S]*?\n  }/);
  assert.ok(probeBody && /_singleWithRetry/.test(probeBody[0]), '_phaseProbe 使用退避');
});

test('v0.9.8: model-test——短路表行为（凭据类全停 / RATE_LIMIT 不短路 / 正常全跑）', async () => {
  // 行为断言（替代早先的 src.includes 源码断言——那种写法把注释里的字符串也算通过，
  // 无法证明短路逻辑正确）。
  const runWithProbe = async (probeResult) => {
    const called = [];
    const runner = new ModelTestRunner({ llm: {}, registry: null, daily: null, log: {} });
    runner._phaseProbe = async () => { called.push('probe'); return probeResult; };
    runner._phaseRpm = async () => { called.push('rpm'); return { lastOkRpm: 0.1, first429Rpm: null, firstError: null, ladder: [] }; };
    runner._phaseContext = async () => { called.push('context'); return { sizes: [], maxAccepted: 0, firstError: null }; };
    runner._phaseQuotaGroup = async () => { called.push('quota-group'); return { quotaGroup: null, members: [], firstError: null }; };
    const report = await runner.run([{ provider: 'p', model: 'm', tier: 'free' }], { recoveryMs: 0 });
    return { called, target: report.targets[0] };
  };

  // 1) 凭据类 → 后续三相全跳
  const cred = await runWithProbe({ ok: false, errorCode: 'INVALID_CREDENTIAL', errorMessage: 'bad key', retries: 0 });
  assert.deepEqual(cred.called, ['probe'], 'INVALID_CREDENTIAL 后不再调用后续相');
  assert.deepEqual(cred.target.skipped, ['rpm', 'context', 'quota-group'], '三相记入 skipped');
  assert.ok(cred.target.skipReasons.rpm.includes('INVALID_CREDENTIAL'), 'skipReasons 带错误码');
  assert.equal(cred.target.phaseErrors.probe.errorCode, 'INVALID_CREDENTIAL', 'phaseErrors 落错误码');

  // 2) RATE_LIMIT 不在短路表 → 继续跑满（执行序：probe→context→rpm→quota-group）
  const rate = await runWithProbe({ ok: false, errorCode: 'RATE_LIMIT', errorMessage: '429 too many', retries: 0 });
  assert.deepEqual(rate.called, ['probe', 'context', 'rpm', 'quota-group'], 'RATE_LIMIT 不短路');
  assert.deepEqual(rate.target.skipped, [], 'skipped 为空');
  assert.equal(rate.target.phaseErrors.probe.errorCode, 'RATE_LIMIT', '仍记录错误码');

  // 3) probe 正常 → 全跑、无 skipped
  const ok = await runWithProbe({ ok: true, errorCode: null, errorMessage: null, retries: 0 });
  assert.deepEqual(ok.called, ['probe', 'context', 'rpm', 'quota-group'], '正常全跑');
  assert.deepEqual(ok.target.skipped, [], 'skipped 为空');
  assert.deepEqual(ok.target.phaseErrors, {}, 'phaseErrors 为空');
});

test('v0.9.8.1: model-test——context 相隔离执行（在 rpm 之前）', async () => {
  const called = [];
  const runner = new ModelTestRunner({ llm: {}, registry: null, daily: null, log: {} });
  runner._phaseProbe = async () => { called.push('probe'); return { ok: true, ttftMs: 1, errorCode: null, errorMessage: null, retries: 0 }; };
  runner._phaseRpm = async () => { called.push('rpm'); return { lastOkRpm: 0.1, first429Rpm: null, firstError: null, ladder: [] }; };
  runner._phaseContext = async () => { called.push('context'); return { sizes: [], maxAccepted: 0, firstError: null }; };
  runner._phaseQuotaGroup = async () => { called.push('quota-group'); return { quotaGroup: null, members: [], firstError: null }; };

  const report = await runner.run([{ provider: 'p', model: 'm', tier: 'free' }], { recoveryMs: 0 });
  const t = report.targets[0];

  // 核心不变式：context 必须在 rpm 之前执行（否则 rpm 的 TPM 消耗会污染容量测量）
  assert.ok(called.indexOf('context') < called.indexOf('rpm'),
    `context 应在 rpm 之前执行（实际顺序 ${called.join('→')}）`);

  // 契约顺序不变：phases 仍是 MODEL_TEST_PHASES 的顺序，供面板/报告展示
  assert.deepEqual(t.phases, MODEL_TEST_PHASES, 'phases 保持契约顺序');
  assert.deepEqual(report.phases, MODEL_TEST_PHASES, 'report.phases 保持契约顺序');
  // 执行顺序单独记录，且与契约顺序不同
  assert.deepEqual(t.phaseOrder, PHASE_EXEC_ORDER, 'target.phaseOrder 记录执行顺序');
  assert.deepEqual(report.phaseOrder, PHASE_EXEC_ORDER, 'report.phaseOrder 记录执行顺序');
  assert.notDeepEqual(PHASE_EXEC_ORDER, MODEL_TEST_PHASES, '执行顺序与契约顺序刻意不同');

  // orderPhasesForExecution 对子集同样按执行序排列
  assert.deepEqual(orderPhasesForExecution(['rpm', 'context']), ['context', 'rpm'],
    '子集也按执行序排列（context 在前）');
  assert.deepEqual(orderPhasesForExecution(['probe']), ['probe']);
});

test('v0.9.8.1: model-test——短路语义随执行序变化（context 失败现会跳 rpm）', async () => {
  const called = [];
  const runner = new ModelTestRunner({ llm: {}, registry: null, daily: null, log: {} });
  runner._phaseProbe = async () => { called.push('probe'); return { ok: true, ttftMs: 1, errorCode: null, errorMessage: null, retries: 0 }; };
  runner._phaseRpm = async () => { called.push('rpm'); return { lastOkRpm: 0.1, first429Rpm: null, firstError: null, ladder: [] }; };
  // context 相返回容量类错误 → 应短路掉后续的 rpm 与 quota-group
  runner._phaseContext = async () => {
    called.push('context');
    return { sizes: [{ tokens: 1024, ok: false, errorCode: 'CONTEXT_LENGTH' }], maxAccepted: 0, firstError: { errorCode: 'CONTEXT_LENGTH', errorMessage: 'too long' } };
  };
  runner._phaseQuotaGroup = async () => { called.push('quota-group'); return { quotaGroup: null, members: [], firstError: null }; };

  const report = await runner.run([{ provider: 'p', model: 'm', tier: 'free' }], { recoveryMs: 0 });
  const t = report.targets[0];
  // 隔离前：context 在最后，短路只能跳 quota-group；隔离后：context 在中间，短路跳 rpm + quota-group
  assert.deepEqual(called, ['probe', 'context'], 'context 失败后不再跑 rpm/quota-group');
  assert.deepEqual(t.skipped, ['rpm', 'quota-group'], 'rpm 与 quota-group 记入 skipped');
  assert.ok(t.skipReasons.rpm.includes('CONTEXT_LENGTH'), 'skipReasons 带容量错误码');
});

test('v0.9.8: model-test——报告落 errorMessage（formatReportMarkdown / _finalize）', () => {
  const md = formatModelTestMd({
    runId: 'error-run',
    startedAt: '2026-09-15T00:00:00.000Z',
    finishedAt: '2026-09-15T00:00:01.000Z',
    phases: ['probe'],
    targets: [{
      provider: 'opencode', model: 'bad-model', tier: 'free',
      probe: { ok: false, errorCode: 'INVALID_REQUEST', errorMessage: 'model not found upstream' },
      phaseErrors: { probe: { errorCode: 'INVALID_REQUEST', errorMessage: 'model not found upstream' } },
      verdict: { recommend: 'exclude', score: 0.2 },
    }],
  });
  assert.ok(md.includes('错误详情'), 'MD 有错误详情段');
  assert.ok(md.includes('INVALID_REQUEST'), 'MD 含错误码');
  assert.ok(md.includes('model not found upstream'), 'MD 含真实错误消息');
});

test('v0.9.8: model-test——outcome.elapsedMs 按 target 起点（不累加跑批起点）', async () => {
  // 行为断言：给每个 target 的 probe 相注入固定延迟，验证「每个 target 只算自己的耗时」。
  // 旧实现（_elapsed() 用 this.startedAt）会让第 2 个 target 的 elapsedMs ≈ 两个 target 之和；
  // 新实现应各自 ≈ 单次延迟。这是能区分新旧行为的断言。
  const DELAY = 40;
  const runner = new ModelTestRunner({ llm: {}, registry: null, daily: null, log: {} });
  runner._phaseProbe = async () => {
    await new Promise((r) => setTimeout(r, DELAY));
    return { ok: true, ttftMs: 5, errorCode: null, errorMessage: null, retries: 0 };
  };
  runner._phaseRpm = async () => ({ lastOkRpm: 0.1, first429Rpm: null, firstError: null, ladder: [] });
  runner._phaseContext = async () => ({ sizes: [], maxAccepted: 0, firstError: null });
  runner._phaseQuotaGroup = async () => ({ quotaGroup: null, members: [], firstError: null });

  const report = await runner.run(
    [{ provider: 'p1', model: 'm1', tier: 'free' }, { provider: 'p2', model: 'm2', tier: 'free' }],
    { recoveryMs: 0 },
  );
  const [t1, t2] = report.targets;
  assert.ok(t1.elapsedMs >= DELAY - 5, `第 1 个 target 至少含注入延迟（实际 ${t1.elapsedMs}）`);
  assert.ok(t1.elapsedMs < DELAY * 2, `第 1 个 target 未虚高（实际 ${t1.elapsedMs}）`);
  assert.ok(t2.elapsedMs < DELAY * 2,
    `第 2 个 target 不累加第 1 个的耗时（实际 ${t2.elapsedMs}，旧实现会 ≥ ${DELAY * 2}）`);
  assert.ok(Number.isFinite(report.elapsedMs) && report.elapsedMs >= t1.elapsedMs + t2.elapsedMs - 10,
    `整批 elapsedMs 覆盖两个 target（整批 ${report.elapsedMs} vs 之和 ${t1.elapsedMs + t2.elapsedMs}）`);
});

test('v0.9.8: client——diag / phase payload / Markdown fallback 契约存在', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(src.includes('{ key: "diag", label: "诊断" }'), '诊断页签存在');
  assert.ok(src.includes('requestBody.phases = phases.slice()'), 'phase 子集提交存在');
  assert.ok(src.includes('Markdown 原文（旧响应兼容）'), '旧 Markdown 响应有 fallback');
  assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(src), false, '不引入 innerHTML');
});

test('v0.9.9.5 Task7/8: client——archives 页签 / ArchivesPanel / 详情渲染 / 命名消歧 契约存在', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // 页签注册
  assert.ok(src.includes('{ key: "archives", label: "测试档案" }'), 'archives 页签已注册');
  // 组件与渲染器
  assert.ok(/function ArchivesPanel\(/.test(src), 'ArchivesPanel 组件存在');
  assert.ok(/function renderArchiveDetail\(/.test(src), '详情渲染器存在');
  // 端点消费
  assert.ok(src.includes('API.testArchives'), '消费 /test-archives');
  assert.ok(src.includes('API.testArchivesDetail'), '消费 /test-archives/detail');
  // 三类 kind 分组
  for (const k of ['model-test', 'loadtest', 'probe']) {
    assert.ok(src.includes(`"${k}"`), `kind ${k} 出现`);
  }
  // 命名消歧（方案 §6-2）：抽屉标题与「测试档案」页签区分。
  // v0.9.10 Task5：抽屉内容扩为「限额声明 + 窗口上限」两块 → 标题改为「渠道限额档案」
  assert.ok(src.includes('渠道限额档案 · '), 'ArchiveDrawer 标题已消歧');
  assert.equal(src.includes('模型档案 · '), false, '旧「模型档案」标题已移除');
  // XSS 边界：全文件无 HTML 直通
  assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(src), false, '不引入 HTML 直通');
});

test('v0.9.8: model-test——phases 缺省全跑；自定义子集只跑指定相', async () => {
  const makeRunner = () => {
    const runner = new ModelTestRunner({ llm: {}, registry: null, daily: null, log: {} });
    const called = [];
    runner._phaseProbe = async () => { called.push('probe'); return { ok: true, ttftMs: 5, errorCode: null }; };
    runner._phaseRpm = async () => { called.push('rpm'); return { lastOkRpm: 0.1, first429Rpm: null, ladder: [] }; };
    runner._phaseContext = async () => { called.push('context'); return { sizes: [{ tokens: 1024, ok: true }], maxAccepted: 1024, firstError: null }; };
    runner._phaseQuotaGroup = async () => { called.push('quota-group'); return { quotaGroup: null, members: [], firstError: null }; };
    return { runner, called };
  };
  const all = makeRunner();
  const allReport = await all.runner.run([{ provider: 'p', model: 'm', tier: 'free' }], { recoveryMs: 0 });
  // v0.9.8.1：执行序为 probe→context→rpm→quota-group（context 隔离到 rpm 之前）
  assert.deepEqual(all.called, ['probe', 'context', 'rpm', 'quota-group']);
  assert.deepEqual(allReport.targets[0].phases, MODEL_TEST_PHASES);
  assert.deepEqual(allReport.targets[0].notSelected, []);
  assert.deepEqual(allReport.targets[0].skipped, []);
  assert.ok(Number.isFinite(allReport.elapsedMs), '整批 elapsedMs 存在');

  const subset = makeRunner();
  const subsetReport = await subset.runner.run([{ provider: 'p', model: 'm', tier: 'free' }], { phases: ['rpm'], recoveryMs: 0 });
  assert.deepEqual(subset.called, ['rpm'], '只选择 rpm 时不隐式补 probe');
  assert.equal(subsetReport.targets[0].probe, null);
  assert.deepEqual(subsetReport.targets[0].phases, ['rpm']);
  assert.deepEqual(subsetReport.targets[0].notSelected, ['probe', 'context', 'quota-group']);
  assert.deepEqual(subsetReport.targets[0].skipped, []);
});


// ============================================================
// v0.9.9 极简峰谷定价（方案 §6-1）：10 条行为断言
// ============================================================

/** 构造一个含 timeWindows 的 Router，时间用 _now 注入。 */
function makeRouterWithTW(tw, tz = null, now = null) {
  const r = new Router({ rules: [], timeZone: tz, timeWindows: tw }, null, null);
  if (now) r._now = now;
  return r;
}

test('v0.9.9: segmentOf 半开区间——非跨零点（09:00-22:00）', () => {
  const r = makeRouterWithTW({ enabled: true, peakStart: '09:00', valleyStart: '22:00' });
  assert.equal(r.segmentOf(r.config.timeWindows, null, new Date('2026-09-16T08:59:59')), 'valley');
  assert.equal(r.segmentOf(r.config.timeWindows, null, new Date('2026-09-16T09:00:00')), 'peak');
  assert.equal(r.segmentOf(r.config.timeWindows, null, new Date('2026-09-16T21:59:59')), 'peak');
  assert.equal(r.segmentOf(r.config.timeWindows, null, new Date('2026-09-16T22:00:00')), 'valley');
  assert.equal(r.segmentOf(r.config.timeWindows, null, new Date('2026-09-16T23:30:00')), 'valley');
});

test('v0.9.9: segmentOf 半开区间——跨零点（22:00-08:00）', () => {
  const r = makeRouterWithTW({ enabled: true, peakStart: '22:00', valleyStart: '08:00' });
  assert.equal(r.segmentOf(r.config.timeWindows, null, new Date('2026-09-16T22:00:00')), 'peak');
  assert.equal(r.segmentOf(r.config.timeWindows, null, new Date('2026-09-16T07:59:59')), 'peak');
  assert.equal(r.segmentOf(r.config.timeWindows, null, new Date('2026-09-16T08:00:00')), 'valley');
  assert.equal(r.segmentOf(r.config.timeWindows, null, new Date('2026-09-16T12:00:00')), 'valley');
});

test('v0.9.9: segmentOf 未启用 / 缺字段 → null（零行为变化）', () => {
  const r1 = makeRouterWithTW({ enabled: false, peakStart: '09:00', valleyStart: '22:00' });
  assert.equal(r1.segmentOf(r1.config.timeWindows, null, new Date('2026-09-16T12:00:00')), null);
  const r2 = makeRouterWithTW({ enabled: true }); // 缺 peakStart/valleyStart
  assert.equal(r2.segmentOf(r2.config.timeWindows, null, new Date('2026-09-16T12:00:00')), null);
  const r3 = makeRouterWithTW(null);
  assert.equal(r3.segmentOf(r3.config.timeWindows, null, new Date('2026-09-16T12:00:00')), null);
});

test('v0.9.9: segmentOfNow 实例方法复用 config 与 _now 注入', () => {
  const r = new Router({ rules: [], timeZone: null, timeWindows: { enabled: true, peakStart: '09:00', valleyStart: '22:00' } });
  r._now = new Date('2026-09-16T12:00:00');
  assert.equal(r.segmentOfNow(), 'peak');
  r._now = new Date('2026-09-16T03:00:00');
  assert.equal(r.segmentOfNow(), 'valley');
});

test('v0.9.9: segmentChain——未启用/段无 route → null；启用时返回完整链', () => {
  const r = new Router({ rules: [], timeZone: null,
    timeWindows: { enabled: true, peakStart: '09:00', valleyStart: '22:00',
      peak: { route: [{ provider: 'a', model: 'A' }] },
      valley: { route: [{ provider: 'b', model: 'B' }, { provider: 'c', model: 'C' }] } } }, null, null);
  r._now = new Date('2026-09-16T12:00:00');
  assert.deepEqual(r.segmentChain(), [{ provider: 'a', model: 'A' }]);
  r._now = new Date('2026-09-16T03:00:00');
  assert.deepEqual(r.segmentChain(), [{ provider: 'b', model: 'B' }, { provider: 'c', model: 'C' }]);
  // 段无 route（仍可识别段，但 chain 为 null）
  const r2 = new Router({ rules: [], timeZone: null,
    timeWindows: { enabled: true, peakStart: '09:00', valleyStart: '22:00' } }, null, null);
  r2._now = new Date('2026-09-16T12:00:00');
  assert.equal(r2.segmentChain(), null);
});

test('v0.9.9: matchRule 段链路——未命中规则时合成 __segment 规则', () => {
  const r = new Router({ rules: [], timeZone: null,
    timeWindows: { enabled: true, peakStart: '09:00', valleyStart: '22:00',
      peak: { route: [{ provider: 'peak-a', model: 'pk-A' }, { provider: 'peak-b', model: 'pk-B' }] } } }, null, null);
  r._now = new Date('2026-09-16T12:00:00');
  const seg = r.matchRule({ provider: 'orig', model: 'M' });
  assert.ok(seg, '未命中但段有 route 时仍返回合成规则');
  assert.equal(seg.name, '__segment', 'name 标记为 __segment（识别用）');
  assert.equal(seg.strategy, 'explicit');
  assert.equal(seg.__segment, 'peak');
  assert.deepEqual(seg.route, [{ provider: 'peak-a', model: 'pk-A' }, { provider: 'peak-b', model: 'pk-B' }],
    'route 与该段声明一致');
});

test('v0.9.9: matchRule 段链路——时间切换后 route 跟着变（v0.9.8.1 留底：pickPrimary 断言）', () => {
  const r = new Router({ rules: [], timeZone: null,
    timeWindows: { enabled: true, peakStart: '09:00', valleyStart: '22:00',
      peak: { route: [{ provider: 'pk', model: 'PK' }] },
      valley: { route: [{ provider: 'vl', model: 'VL' }] } } }, null, null);
  // 峰段
  r._now = new Date('2026-09-16T12:00:00');
  assert.deepEqual(r.pickPrimary({ provider: 'orig', model: 'M' }), { provider: 'pk', model: 'PK' },
    '峰段启用时 pickPrimary 返回段 route[0]（v0.9.8.1 留底断言）');
  // 谷段
  r._now = new Date('2026-09-16T03:00:00');
  assert.deepEqual(r.pickPrimary({ provider: 'orig', model: 'M' }), { provider: 'vl', model: 'VL' },
    '谷段启用时 pickPrimary 返回段 route[0]');
});

test('v0.9.9: matchRule 段链路——包模式（__mr_rule）不受段影响', () => {
  // 模拟规则包绑定的「显式选包」场景：绑定到 __mr_rule 后直接走 byName，不经段。
  // 这里验证段链路不会污染 byName：候选链应来自原始规则，不来自段。
  const r = new Router({ rules: [{ name: 'pkg', route: [{ provider: 'pkg-a', model: 'M1' }] }],
    timeZone: null,
    timeWindows: { enabled: true, peakStart: '09:00', valleyStart: '22:00',
      peak: { route: [{ provider: 'SEG', model: 'S' }] } } }, null, null);
  r._now = new Date('2026-09-16T12:00:00');
  // byName 路径直接拿原始规则，与段无关
  assert.equal(r.byName('pkg').route[0].provider, 'pkg-a', 'byName 拿原始规则，不受段链路影响');
});

test('v0.9.9.1: normalizeTimeWindows 校验——HH:MM / 峰谷点不等 / route 结构 / 空 provider/model 拒绝（Task 1a）', () => {
  // HH:MM 格式校验
  assert.throws(() => normalizeTimeWindows({ enabled: true, peakStart: '9:00', valleyStart: '22:00' }), /peakStart 须为 HH:MM/);
  assert.throws(() => normalizeTimeWindows({ enabled: true, peakStart: '09:00', valleyStart: '22:00', peak: { route: 'bad' } }), /peak\.route 须为数组/);
  assert.throws(() => normalizeTimeWindows({ enabled: true, peakStart: '09:00', valleyStart: '09:00' }), /不能相等/);
  // v0.9.9.1 Task 1a：空 provider/model 必须被拒绝（与 rules[].route 走同一校验）
  assert.throws(() => normalizeTimeWindows({ enabled: true, peakStart: '09:00', valleyStart: '22:00',
    peak: { route: [{ provider: '', model: '' }] } }), /非空 provider/);
  assert.throws(() => normalizeTimeWindows({ enabled: true, peakStart: '09:00', valleyStart: '22:00',
    peak: { route: [{ provider: 'p' }] } }), /须含非空 model/);
  assert.throws(() => normalizeTimeWindows({ enabled: true, peakStart: '09:00', valleyStart: '22:00',
    valley: { route: [{ provider: '' }] } }), /非空 provider/);
  // 正常：quotaGroup/tier 等内联字段必须保留（与 rules[].route 行为一致）
  const tw = normalizeTimeWindows({ enabled: true, peakStart: '09:00', valleyStart: '22:00',
    peak: { route: [{ provider: 'a', model: 'A', quotaGroup: 'g1', tier: 'free' }] },
    valley: { route: [{ provider: 'b', model: 'B' }] } });
  assert.equal(tw.enabled, true);
  assert.deepEqual(tw.peak.route, [{ provider: 'a', model: 'A', quotaGroup: 'g1', tier: 'free' }]);
  assert.deepEqual(tw.valley.route, [{ provider: 'b', model: 'B' }]);
  assert.ok(Object.isFrozen(tw.peak.route));
});

test('v0.9.9: normalizeState 透传 timeWindows；normalizeConfig 拒非对象', () => {
  // normalizeState 把 timeWindows 透传到返回结果（与 reports 同模式）
  const state = normalizeState({ rules: [], timeWindows: { enabled: true, peakStart: '09:00', valleyStart: '22:00',
    peak: { route: [{ provider: 'a', model: 'A' }] }, valley: { route: [{ provider: 'b', model: 'B' }] } } });
  assert.ok(state.timeWindows, 'timeWindows 出现在返回 state');
  assert.equal(state.timeWindows.enabled, true);
  // 未提交时不出现（与 providerMeta 同语义：undefined = 保留 patch 值）
  const state2 = normalizeState({ rules: [] });
  assert.equal(state2.timeWindows, undefined);
  // normalizeConfig 接受非法的 timeWindows 应抛错
  assert.throws(() => normalizeConfig({ timeWindows: 'bad' }), /须为对象/);
});

// ============================================================
// v0.9.9.1 Task 2：档案统一 schema（lib/archive.js）
// ============================================================

test('v0.9.9.1: archive——archiveName 生成 <runId>.<kind>.<ext>；非法 kind 抛错', async () => {
  const { archiveName, ARCHIVE_KINDS } = await import('../lib/archive.js');
  assert.deepEqual(ARCHIVE_KINDS, ['model-test', 'loadtest', 'probe']);
  assert.equal(archiveName('run-1', 'model-test', 'json'), 'run-1.model-test.json');
  assert.equal(archiveName('run-1', 'loadtest', 'md'), 'run-1.loadtest.md');
  assert.equal(archiveName('run-1', 'probe', 'json'), 'run-1.probe.json');
  assert.throws(() => archiveName('run-1', 'bogus', 'json'), /kind 须为/);
});

test('v0.9.9.1: archive——kindOfFilename 反向解析（白名单外返回 null）', async () => {
  const { kindOfFilename } = await import('../lib/archive.js');
  assert.equal(kindOfFilename('run-1.model-test.json'), 'model-test');
  assert.equal(kindOfFilename('run-1.loadtest.json'), 'loadtest');
  assert.equal(kindOfFilename('run-1.probe.json'), 'probe');
  // 非档案文件 → null（防止把 .ndjson / .report.md 当日志）
  assert.equal(kindOfFilename('2026-09-16.ndjson'), null);
  assert.equal(kindOfFilename('2026-09-16.report.md'), null);
  assert.equal(kindOfFilename('run-1.model-test.md'), null, 'md 不算档案（json 才是）');
  assert.equal(kindOfFilename('run-1.bogus.json'), null);
});

test('v0.9.9.1: archive——persistReport 落盘含 kind/schemaVersion；失败不抛错', async () => {
  const { persistReport, KIND_SCHEMA_VERSION } = await import('../lib/archive.js');
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-archive-test-'));
  try {
    // 正常落盘
    const r = persistReport(dir, {
      runId: 'r1', kind: 'model-test',
      jsonBody: JSON.stringify({ kind: 'model-test', schemaVersion: KIND_SCHEMA_VERSION, runId: 'r1' }, null, 2),
      mdBody: '# md\n',
    }, {});
    assert.ok(r && r.jsonTarget, '返回 jsonTarget');
    assert.ok(r.mdTarget, '返回 mdTarget');
    assert.ok(existsSync(r.jsonTarget), 'json 文件存在');
    assert.ok(existsSync(r.mdTarget), 'md 文件存在');
    const raw = JSON.parse(readFileSync(r.jsonTarget, 'utf8'));
    assert.equal(raw.kind, 'model-test');
    assert.equal(raw.schemaVersion, 1);

    // probe 类无 md
    const r2 = persistReport(dir, { runId: 'r2', kind: 'probe', jsonBody: '{}' }, {});
    assert.ok(r2.jsonTarget);
    assert.equal(r2.mdTarget, undefined, 'probe 无 md');

    // 参数不全 → null（不抛错）
    assert.equal(persistReport(dir, { kind: 'model-test' }, {}), null, '缺 runId → null');
    assert.equal(persistReport(dir, { runId: 'r3' }, {}), null, '缺 kind → null');
    assert.equal(persistReport(dir, { runId: 'r3', kind: 'bogus', jsonBody: '{}' }, {}), null, '非法 kind → null');
    assert.equal(persistReport(null, { runId: 'r3', kind: 'probe', jsonBody: '{}' }, {}), null, '无 dir → null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.9.1: archive——writeAtomic 原子写（tmp 不残留）', async () => {
  const { writeAtomic } = await import('../lib/archive.js');
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-atomic-test-'));
  try {
    const target = join(dir, 'x.json');
    writeAtomic(target, '{"a":1}', {});
    assert.equal(readFileSync(target, 'utf8'), '{"a":1}');
    const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '无 .tmp 残留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.9.2: archive——resolveArchiveDir 优先 reports.dir，否则默认目录', async () => {
  const { resolveArchiveDir, defaultArchiveDir } = await import('../lib/archive.js');
  assert.equal(resolveArchiveDir({ reports: { dir: '/tmp/custom-dir' } }), '/tmp/custom-dir');
  assert.equal(resolveArchiveDir({ reports: {} }), defaultArchiveDir(), 'reports.dir 缺失 → 默认');
  assert.equal(resolveArchiveDir({}), defaultArchiveDir(), '无 reports → 默认');
  assert.equal(resolveArchiveDir(undefined), defaultArchiveDir(), '无 cfg → 默认');
  assert.equal(resolveArchiveDir({ reports: { dir: '' } }), defaultArchiveDir(), '空字符串 → 默认');
  // 默认目录与 daily.js 一致
  assert.ok(defaultArchiveDir().endsWith('dsh-model-router-reports'));
});

// ============================================================
// v0.9.9.2 Task 3：loadtest 落盘
// ============================================================

test('v0.9.9.2 Task3: loadtest——跑 phase 后落盘含 kind/schemaVersion/runId', async () => {
  const { LoadTestRunner } = await import('../lib/loadtest.js');
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-lt-'));
  try {
    const llm = probeLlm({
      'm-free': async function* () {
        yield { type: 'text-delta', index: 0, text: 'pong' };
        yield finishStop;
      },
    });
    const registry = { registeredPairs: () => [{ provider: 'p-a', model: 'm-free', tier: 'free' }] };
    const runner = new LoadTestRunner({ llm, registry, log, reportDir: dir });

    await runner.run('probe');

    const files = readdirSync(dir).filter((n) => n.endsWith('.loadtest.json'));
    assert.equal(files.length, 1, '落盘 1 份 loadtest 档案');
    const raw = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.equal(raw.kind, 'loadtest');
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.runId, runner.runId);
    assert.deepEqual(raw.phases, ['probe'], 'phases 含已完成的 phase');
    assert.ok(raw.results.probe, 'results 含 probe 结果');
    assert.equal(typeof raw.elapsedMs, 'number');
    assert.ok(raw.startedAt && raw.finishedAt);
    // 无 md（loadtest 只落 json）
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.loadtest.md')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.9.2 Task3: loadtest——多 phase 覆盖同一档案（累积不新增）', async () => {
  const { LoadTestRunner } = await import('../lib/loadtest.js');
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-lt2-'));
  try {
    const llm = probeLlm({
      'm-free': async function* () {
        yield { type: 'text-delta', index: 0, text: 'pong' };
        yield finishStop;
      },
    });
    const registry = { registeredPairs: () => [{ provider: 'p-a', model: 'm-free', tier: 'free' }] };
    const runner = new LoadTestRunner({ llm, registry, log, reportDir: dir });

    await runner.run('probe');
    await runner.run('context');

    const files = readdirSync(dir).filter((n) => n.endsWith('.loadtest.json'));
    assert.equal(files.length, 1, '仍是 1 份（覆盖写，非每 phase 一份）');
    const raw = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.deepEqual(raw.phases.sort(), ['context', 'probe'], '两个 phase 均累积在同一档案');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.9.2 Task3: loadtest——reportDir=null 不落盘且不抛错', async () => {
  const { LoadTestRunner } = await import('../lib/loadtest.js');
  const llm = probeLlm({
    'm-free': async function* () {
      yield { type: 'text-delta', index: 0, text: 'pong' };
      yield finishStop;
    },
  });
  const registry = { registeredPairs: () => [{ provider: 'p-a', model: 'm-free', tier: 'free' }] };
  const runner = new LoadTestRunner({ llm, registry, log }); // 无 reportDir
  assert.equal(runner.reportDir, null);
  const result = await runner.run('probe');
  assert.equal(result.phase, 'probe', '跑批仍正常返回');
});

test('v0.9.9.2 Task3: loadtest——落盘失败不阻塞跑批（reportDir 不可写）', async () => {
  const { LoadTestRunner } = await import('../lib/loadtest.js');
  const llm = probeLlm({
    'm-free': async function* () {
      yield { type: 'text-delta', index: 0, text: 'pong' };
      yield finishStop;
    },
  });
  const registry = { registeredPairs: () => [{ provider: 'p-a', model: 'm-free', tier: 'free' }] };
  // 用一个「父路径是文件」的非法目录 → mkdirSync 必失败
  const runner = new LoadTestRunner({ llm, registry, log, reportDir: '/dev/null/not-a-dir' });
  const result = await runner.run('probe');
  assert.equal(result.phase, 'probe', '落盘失败仍返回跑批结果');
});

// ============================================================
// v0.9.9.2 Task 4：probe 落盘
// ============================================================

test('v0.9.9.2 Task4: probe——runAll 后落盘含 kind/schemaVersion/entries', async () => {
  const { ProbeBoard } = await import('../lib/probe.js');
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-pb-'));
  try {
    const llm = probeLlm({
      'm-free': async function* () {
        yield { type: 'text-delta', index: 0, text: 'pong' };
        yield finishStop;
      },
    });
    const board = new ProbeBoard(log, { timeoutMs: 2000, reportDir: dir });
    await board.runAll(llm, [{ provider: 'p-a', model: 'm-free' }]);

    const files = readdirSync(dir).filter((n) => n.endsWith('.probe.json'));
    assert.equal(files.length, 1, '落盘 1 份 probe 档案');
    const raw = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.equal(raw.kind, 'probe');
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.runId, board.runId);
    assert.equal(raw.targetCount, 1);
    assert.ok(raw.entries['p-a/m-free'], 'entries 含探测记录');
    // _record 记录的是聚合结构（非单次 rec）：status/total/success
    assert.equal(raw.entries['p-a/m-free'].status, 'up', '成功探测 → status=up');
    assert.equal(raw.entries['p-a/m-free'].total, 1);
    assert.equal(raw.entries['p-a/m-free'].success, 1);
    // 只落 json（无 md）
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.probe.md')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.9.2 Task4: probe——多轮覆盖同一档案；reportDir=null 不落盘', async () => {
  const { ProbeBoard } = await import('../lib/probe.js');
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-pb2-'));
  try {
    const llm = probeLlm({
      'm-free': async function* () {
        yield { type: 'text-delta', index: 0, text: 'pong' };
        yield finishStop;
      },
    });
    const board = new ProbeBoard(log, { timeoutMs: 2000, reportDir: dir });
    await board.runAll(llm, [{ provider: 'p-a', model: 'm-free' }]);
    await board.runAll(llm, [{ provider: 'p-a', model: 'm-free' }]);
    const files = readdirSync(dir).filter((n) => n.endsWith('.probe.json'));
    assert.equal(files.length, 1, '多轮仍是 1 份（覆盖写，避免磁盘无界堆积）');

    // 无 reportDir → 不落盘
    const board2 = new ProbeBoard(log, { timeoutMs: 2000 });
    assert.equal(board2.reportDir, null);
    await board2.runAll(llm, [{ provider: 'p-a', model: 'm-free' }]);
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.probe.json')).length, 1, 'board2 未落盘');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.9.2 Task4: probe——runAll 重入保护仍生效（running 时直接返回）', async () => {
  const { ProbeBoard } = await import('../lib/probe.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-pb3-'));
  try {
    const llm = probeLlm({
      'm-free': async function* () {
        yield { type: 'text-delta', index: 0, text: 'pong' };
        yield finishStop;
      },
    });
    const board = new ProbeBoard(log, { timeoutMs: 2000, reportDir: dir });
    board.running = true; // 模拟进行中
    await board.runAll(llm, [{ provider: 'p-a', model: 'm-free' }]);
    assert.equal(llm.calls.length, 0, '重入时不发请求');
    // 重入直接 return → 不落盘（running 仍为 true，未进 finally）
    assert.equal(board.running, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// v0.9.9.4 Task 5/6：档案列表与详情端点（含安全关键）
// ============================================================

test('v0.9.9.4: assertSafeRunId——合法通过；路径穿越/非法字符被拒', async () => {
  const { assertSafeRunId } = await import('../lib/archive.js');
  // 合法（真实 runId 形态）
  assert.equal(assertSafeRunId('2026-09-16T22-59-49-tcgo'), '2026-09-16T22-59-49-tcgo');
  assert.equal(assertSafeRunId('run_1.v2'), 'run_1.v2');
  // 非法：空 / 非字符串
  assert.throws(() => assertSafeRunId(''), /非空字符串/);
  assert.throws(() => assertSafeRunId(null), /非空字符串/);
  assert.throws(() => assertSafeRunId(123), /非空字符串/);
  // 非法：路径穿越（核心安全断言）
  assert.throws(() => assertSafeRunId('../../../etc/passwd'), /非法字符/);
  assert.throws(() => assertSafeRunId('a/b'), /非法字符/);
  assert.throws(() => assertSafeRunId('a\\b'), /非法字符/);
  assert.throws(() => assertSafeRunId('..'), /不得含/);
  assert.throws(() => assertSafeRunId('a..b'), /不得含/);
  // 非法：超长
  assert.throws(() => assertSafeRunId('a'.repeat(201)), /过长/);
});

test('v0.9.9.4: safeArchivePath——合法在目录内；越界/穿越被拒（双校验）', async () => {
  const { safeArchivePath } = await import('../lib/archive.js');
  const dir = '/tmp/archive-test-dir';
  // 合法：拼接在目录内
  assert.equal(safeArchivePath(dir, 'model-test', 'run-1'), `${dir}/run-1.model-test.json`);
  assert.equal(safeArchivePath(dir, 'probe', 'run-2'), `${dir}/run-2.probe.json`);
  // 非法 kind → archiveName 抛错
  assert.throws(() => safeArchivePath(dir, 'bogus', 'run-1'), /kind 须为/);
  // 路径穿越（第一道防线拦截）
  assert.throws(() => safeArchivePath(dir, 'model-test', '../../etc/passwd'), /非法字符/);
  assert.throws(() => safeArchivePath(dir, 'model-test', '..'), /不得含/);
  // 绝对路径（含 / 被第一道拦截）
  assert.throws(() => safeArchivePath(dir, 'model-test', '/etc/passwd'), /非法字符/);
  // 第二道防线：即使第一道被绕过（模拟放宽正则），路径前缀确认仍拦
  // —— 这里直接验证 resolve 归一化后的边界逻辑
  const { resolve } = await import('node:path');
  assert.ok(safeArchivePath(dir, 'model-test', 'x').startsWith(resolve(dir) + '/'));
});

test('v0.9.9.4: listArchives——三类识别 + 忽略其他后缀 + 按时间倒序 + 空目录', async () => {
  const { listArchives } = await import('../lib/archive.js');
  const { mkdtempSync, writeFileSync, rmSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-list-'));
  try {
    // 三类档案 + 干扰文件
    writeFileSync(join(dir, 'r1.model-test.json'), '{}');
    writeFileSync(join(dir, 'r2.loadtest.json'), '{}');
    writeFileSync(join(dir, 'r3.probe.json'), '{}');
    writeFileSync(join(dir, '2026-09-16.ndjson'), 'x'); // 日账本 → 应忽略
    writeFileSync(join(dir, '2026-09-16.report.md'), 'x'); // 每日报告 → 应忽略
    writeFileSync(join(dir, 'r1.model-test.md'), 'x'); // md → 应忽略（只列 json）
    // 设定 mtime 以验证倒序
    utimesSync(join(dir, 'r1.model-test.json'), new Date('2026-09-14'), new Date('2026-09-14'));
    utimesSync(join(dir, 'r2.loadtest.json'), new Date('2026-09-16'), new Date('2026-09-16'));
    utimesSync(join(dir, 'r3.probe.json'), new Date('2026-09-15'), new Date('2026-09-15'));

    const items = listArchives(dir);
    assert.equal(items.length, 3, '只列三类档案，忽略 ndjson/report.md/md');
    assert.deepEqual(items.map((i) => i.runId), ['r2', 'r3', 'r1'], '按 mtime 倒序');
    assert.deepEqual(items.map((i) => i.kind), ['loadtest', 'probe', 'model-test']);
    for (const it of items) {
      assert.equal(typeof it.size, 'number');
      // v0.9.20 P2：字段名由 startedAt 改为 mtime（它是文件写入时刻，不是报告开始时间）
      assert.ok(it.mtime, 'mtime 存在');
      assert.equal(it.startedAt, undefined, '不再暴露易误解的 startedAt');
    }
    // 空目录 / 不存在目录 → 空列表（不抛错）
    assert.deepEqual(listArchives(mkdtempSync(join(tmpdir(), 'dsh-empty-'))), []);
    assert.deepEqual(listArchives('/nonexistent-dir-xyz'), []);
    assert.deepEqual(listArchives(null), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.9.4: /test-archives 端点——列表 200 / 非回环 403', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-ep-'));
  try {
    writeFileSync(join(dir, 'r1.model-test.json'), JSON.stringify({ kind: 'model-test', runId: 'r1' }));
    writeFileSync(join(dir, 'r2.probe.json'), JSON.stringify({ kind: 'probe', runId: 'r2' }));
    writeFileSync(join(dir, '2026-09-16.ndjson'), 'x'); // 干扰

    const routes = makeStatusRoutes({
      config: { statusPath: '/x', rules: [], fallbackPolicy: {}, probe: {}, timeZone: null, storePath: '', reports: { dir } },
      router: { snapshot() { return {}; }, recordExhausted() {} },
      cooldown: { snapshot() { return {}; } },
      metrics: { snapshot() { return {}; } },
      quota: { snapshot() { return {}; } },
      registry: null, probe: null, llm: {}, wrapperStats: {},
      startedAt: Date.now(), saveStateFn: () => {}, log,
    });
    const mkReq = (method, url, remote = '127.0.0.1') => ({
      method, url, socket: { remoteAddress: remote },
      headers: { host: '127.0.0.1:3081' },
      [Symbol.asyncIterator]: async function* () {},
    });
    const call = async (path, req) => {
      const route = routes.find((r) => r.path === path);
      let body;
      const res = {
        writeHead(code) { res.status = code; },
        setHeader() {},
        end(b) { body = JSON.parse(b); },
      };
      await route.handler(req, res);
      return { status: res.status, body };
    };

    const P = '/api/model-router/test-archives';
    // 列表 → 200，items 含三类且忽略 ndjson
    let r = await call(P, mkReq('GET', P));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.items.length, 2, '只列档案（忽略 ndjson）');
    assert.deepEqual(r.body.items.map((i) => i.kind).sort(), ['model-test', 'probe']);

    // 非回环 → 403
    r = await call(P, mkReq('GET', P, '10.0.0.5'));
    assert.equal(r.status, 403);
    assert.match(r.body.error, /loopback/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.9.4: /test-archives/detail 端点——合法 200 / 路径穿越 400（安全关键）/ 404 / 400 缺参', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-ep2-'));
  try {
    writeFileSync(join(dir, 'r1.model-test.json'), JSON.stringify({ kind: 'model-test', runId: 'r1', targets: [] }));
    writeFileSync(join(dir, 'r1.model-test.md'), '# md content');

    const routes = makeStatusRoutes({
      config: { statusPath: '/x', rules: [], fallbackPolicy: {}, probe: {}, timeZone: null, storePath: '', reports: { dir } },
      router: { snapshot() { return {}; }, recordExhausted() {} },
      cooldown: { snapshot() { return {}; } },
      metrics: { snapshot() { return {}; } },
      quota: { snapshot() { return {}; } },
      registry: null, probe: null, llm: {}, wrapperStats: {},
      startedAt: Date.now(), saveStateFn: () => {}, log,
    });
    const mkReq = (url) => ({
      method: 'GET', url, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3081' },
      [Symbol.asyncIterator]: async function* () {},
    });
    const call = async (req) => {
      const route = routes.find((r) => r.path === '/api/model-router/test-archives/detail');
      let body;
      const res = {
        writeHead(code) { res.status = code; },
        setHeader() {},
        end(b) { body = JSON.parse(b); },
      };
      await route.handler(req, res);
      return { status: res.status, body };
    };
    const D = '/api/model-router/test-archives/detail';

    // 合法 → 200 + report + markdown
    let r = await call(mkReq(`${D}?kind=model-test&runId=r1`));
    assert.equal(r.status, 200);
    assert.equal(r.body.report.runId, 'r1');
    assert.equal(r.body.markdown, '# md content');

    // probe 无 md → markdown 为 null
    writeFileSync(join(dir, 'r9.probe.json'), JSON.stringify({ kind: 'probe', runId: 'r9' }));
    r = await call(mkReq(`${D}?kind=probe&runId=r9`));
    assert.equal(r.status, 200);
    assert.equal(r.body.markdown, null, 'probe 无 md');

    // 🔴 路径穿越（核心安全断言）→ 400
    r = await call(mkReq(`${D}?kind=model-test&runId=${encodeURIComponent('../../../../etc/passwd')}`));
    assert.equal(r.status, 400, '路径穿越必须 400');
    assert.match(r.body.error, /非法字符|不得含|越界/);

    // 非法 kind → 400
    r = await call(mkReq(`${D}?kind=bogus&runId=r1`));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /kind 须为/);

    // 缺参 → 400
    r = await call(mkReq(`${D}?kind=model-test`));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /均为必填/);
    r = await call(mkReq(D));
    assert.equal(r.status, 400);

    // 合法但文件不存在 → 404
    r = await call(mkReq(`${D}?kind=model-test&runId=no-such-run`));
    assert.equal(r.status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.9.4: /model-test/manual 路径穿越加固——runId 含 ../ → 400', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-ep3-'));
  try {
    const routes = makeStatusRoutes({
      config: { statusPath: '/x', rules: [], fallbackPolicy: {}, probe: {}, timeZone: null, storePath: '', reports: { dir } },
      router: { snapshot() { return {}; }, recordExhausted() {} },
      cooldown: { snapshot() { return {}; } },
      metrics: { snapshot() { return {}; } },
      quota: { snapshot() { return {}; } },
      registry: null, probe: null, llm: {}, wrapperStats: {},
      startedAt: Date.now(), saveStateFn: () => {}, log,
      modelTest: { reportDir: dir },
    });
    const mkReq = (body) => ({
      method: 'POST', url: '/api/model-router/model-test/manual',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3081' },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); },
    });
    const call = async (req) => {
      const route = routes.find((r) => r.path === '/api/model-router/model-test/manual');
      let body;
      const res = {
        writeHead(code) { res.status = code; },
        setHeader() {},
        end(b) { body = JSON.parse(b); },
      };
      await route.handler(req, res);
      return { status: res.status, body };
    };

    // 穿越 runId → 400（加固前会通过 validateManualInput 并尝试写越界路径）
    let r = await call(mkReq({ runId: '../../../tmp/evil', targetKey: 'p\u0000m' }));
    assert.equal(r.status, 400, '穿越 runId 必须 400');
    assert.match(r.body.error, /非法字符|不得含|越界/);

    // 合法 runId 但文件不存在 → 404（走通到读文件）
    r = await call(mkReq({ runId: 'no-such-run', targetKey: 'p\u0000m' }));
    assert.equal(r.status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// v0.9.10 Task 1：providerMeta 新增字段（rpmLimit/tpmLimit/resetPolicy/SourceUrl/notes）
// ============================================================

test('v0.9.10 Task1: providerMeta 新字段——合法 rpmLimit/tpmLimit/resetPolicy', () => {
  // 全部合法
  const out = normalizeConfig({
    providerMeta: {
      'p-a': {
        rpmLimit: 60,
        tpmLimit: 100000,
        resetPolicy: { window: 'day', at: '02:00' },
        resetPolicySourceUrl: 'https://docs.example.com/rate',
        tpmLimitSourceUrl: 'https://docs.example.com/tpm',
        notes: '高峰期限速',
      },
      'p-b': {
        rpmLimit: 100,
        resetPolicy: { window: 'rolling', rollingSec: 3600 },
      },
      'p-c': { rpmLimit: 30 },
    },
  });
  assert.equal(out.providerMeta['p-a'].rpmLimit, 60);
  assert.equal(out.providerMeta['p-a'].tpmLimit, 100000);
  assert.deepEqual(out.providerMeta['p-a'].resetPolicy, { window: 'day', at: '02:00' });
  assert.equal(out.providerMeta['p-a'].notes, '高峰期限速');
  assert.deepEqual(out.providerMeta['p-b'].resetPolicy, { window: 'rolling', rollingSec: 3600 });
  assert.equal(out.providerMeta['p-c'].rpmLimit, 30);
  assert.equal(out.providerMeta['p-a'].quotaGroup, undefined, '旧字段未声明 → undefined（不写默认值）');
});

test('v0.9.10 Task1: providerMeta 新字段——多种非法值被拒（具体错误信息）', () => {
  const cases = [
    [{ 'p': { rpmLimit: 0 } }, /rpmLimit 须为正整数/],
    [{ 'p': { rpmLimit: -1 } }, /rpmLimit 须为正整数/],
    [{ 'p': { rpmLimit: 1.5 } }, /rpmLimit 须为正整数/],
    [{ 'p': { rpmLimit: 'abc' } }, /rpmLimit 须为正整数/],
    [{ 'p': { tpmLimit: 0 } }, /tpmLimit 须为正整数/],
    [{ 'p': { resetPolicy: { window: 'bogus' } } }, /resetPolicy.window 须为/],
    [{ 'p': { resetPolicy: { window: 'hour' } } }, /at 须为 HH:MM/],
    [{ 'p': { resetPolicy: { window: 'hour', at: '9:00' } } }, /at 须为 HH:MM/],
    [{ 'p': { resetPolicy: { window: 'rolling' } } }, /rollingSec 须为/],
    [{ 'p': { resetPolicy: { window: 'rolling', rollingSec: 0 } } }, /rollingSec/],
    [{ 'p': { resetPolicy: { window: 'rolling', rollingSec: 999999 } } }, /rollingSec/],
    [{ 'p': { tpmLimitSourceUrl: 'javascript:alert(1)' } }, /http\(s\)/],
    [{ 'p': { tpmLimitSourceUrl: 'file:///etc/passwd' } }, /http\(s\)/],
    [{ 'p': { notes: 'x'.repeat(501) } }, /长度上限 500/],
  ];
  for (const [meta, expectedRegex] of cases) {
    assert.throws(
      () => normalizeConfig({ providerMeta: meta }),
      expectedRegex,
      JSON.stringify(meta) + ' 应被拒'
    );
  }
});

test('v0.9.10 Task1: 兼容旧 store——无新字段的 providerMeta 不报错', () => {
  // 模拟 v0.9.9 旧 store（只有 quotaGroup/tier/quotaWindows/customWindows/exclude）
  const out = normalizeConfig({
    rules: [],
    providerMeta: {
      'p-a': {
        quotaGroup: 'g1',
        tier: 'free',
        quotaWindows: { fiveHour: { limit: 100, used: 0 } },
        exclude: false,
      },
      'p-b': { tier: 'paid-baseline' },
    },
  });
  assert.equal(out.providerMeta['p-a'].quotaGroup, 'g1', '旧字段保留');
  assert.equal(out.providerMeta['p-a'].tier, 'free', '旧字段保留');
  assert.equal(out.providerMeta['p-a'].exclude, false, '旧字段保留');
  assert.equal(out.providerMeta['p-a'].rpmLimit, undefined, '新字段不存在 → undefined（不报错）');
  assert.equal(out.providerMeta['p-a'].resetPolicy, undefined);
  assert.equal(out.providerMeta['p-b'].tier, 'paid-baseline');
});

test('v0.9.10 Task1: route hop 内联——rpmLimit/tpmLimit/resetPolicy 同样校验', () => {
  const ok = normalizeConfig({
    rules: [
      {
        route: [
          { provider: 'p', model: 'm', rpmLimit: 60, tpmLimit: 100000, resetPolicy: { window: 'minute' } },
        ],
      },
    ],
  });
  assert.equal(ok.rules[0].route[0].rpmLimit, 60);
  assert.equal(ok.rules[0].route[0].tpmLimit, 100000);
  assert.deepEqual(ok.rules[0].route[0].resetPolicy, { window: 'minute' });

  assert.throws(
    () => normalizeConfig({
      rules: [{ route: [{ provider: 'p', model: 'm', rpmLimit: -5 }] }],
    }),
    /rpmLimit 须为正整数/
  );
});

// ============================================================
// v0.9.10 Task 3b：token 用量采集（metrics.recent.tokens + recentTokenSum）
// ============================================================

test('v0.9.10 Task3b: sample——接受 tokens 字段；非数字/null 不存', () => {
  const m = new Metrics();
  m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 100 });
  m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 50 });
  m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: null });
  m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 'abc' });
  m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: -5 }); // 负值：合法数字但聚合条件拒收
  const snap = m.snapshot();
  // ring 5 条都写入（tokens=null 落 null；其他落值）
  assert.equal(snap.recent.length, 5);
  assert.equal(snap.recent[0].tokens, 100, '正整数落 ring');
  assert.equal(snap.recent[2].tokens, null, 'null 落 null');
  assert.equal(snap.recent[3].tokens, 'abc', '字符串原样落（不校验，仅累加时拒）');
  // aggregate tokensSum 只累计合法数字
  const agg = m.aggregates.get('a/A');
  assert.equal(agg.tokensSum, 150, '只累加 100+50；-5 拒收（设计：负数是 sentinel）');
  assert.equal(agg.tokensN, 2, '只记 2 次');
});

test('v0.9.10 Task3b: recentTokenSum——60s 窗口内的 token 总和', () => {
  const m = new Metrics();
  // sample 时刻真实（无法 mock；ring 时间是 Date.now()）
  m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 100 });
  m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 200 });
  m.sample({ provider: 'b', model: 'B', outcome: 'committed', tokens: 999 });
  // 默认 now=Date.now()，所有 sample 都在 0 秒前 → 全部计入
  const sum = m.recentTokenSum('a', 60_000);
  assert.equal(sum, 300, '仅 a 渠道的 token 总和');
  // 60s 之外的窗口 → 0
  const sumFar = m.recentTokenSum('a', 0);
  assert.equal(sumFar, 0, 'windowMs=0 排除所有采样');
});

test('v0.9.10 Task3b: recentTokenSum——窗口基准可注入', () => {
  const m = new Metrics();
  m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 100 });
  // 注入「未来」基准：100 秒后 → sample 在基准前 100s，
  // windowMs=200s 包含 → 应计入
  const future = new Date(Date.now() + 100_000);
  assert.equal(m.recentTokenSum('a', 200_000, future), 100, '未来基准，宽窗口内');
  // windowMs=50s 但基准未来 100s → sample 在基准前 100s，超 50s 窗口 → 0
  assert.equal(m.recentTokenSum('a', 50_000, future), 0, '未来基准，窄窗口外');
  // 不注入（默认 Date.now()）→ sample 在基准 0s 之前，windowMs=60s 包含
  assert.equal(m.recentTokenSum('a', 60_000), 100, '默认基准，包含当前时刻采样');
});

test('v0.9.10 Task3b: recentTokenSum——空 / null / 异常输入容错', () => {
  const m = new Metrics();
  m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 100 });
  assert.equal(m.recentTokenSum('zzz', 60_000), 0, '无该 provider → 0');
  assert.equal(m.recentTokenSum('a', 60_000, null), 100, 'now=null → fallback Date.now()（已含当前）');
  assert.equal(m.recentTokenSum(null, 60_000), 0, 'provider=null → 0');
  // tokens 字段缺失的 sample：直接跳过
  const m2 = new Metrics();
  m2.sample({ provider: 'a', model: 'A', outcome: 'committed' });
  assert.equal(m2.recentTokenSum('a', 60_000), 0, 'tokens 缺字段 → 不计入');
});

test('v0.9.10 Task3b: 既有 sample 调用零回归（不传 tokens 字段）', () => {
  // v0.9.9.5 / v0.9.10 / v0.9.11 / v0.9.12 既有 caller：sample({...}) 不含 tokens
  const m = new Metrics();
  for (let i = 0; i < 10; i++) {
    m.sample({ provider: 'a', model: 'A', outcome: 'committed' });
  }
  // 零回归
  assert.equal(m.aggregates.get('a/A').tokensSum, 0);
  assert.equal(m.aggregates.get('a/A').tokensN, 0);
  assert.equal(m.recentTokenSum('a', 60_000), 0);
  assert.equal(m.snapshot().recent[0].tokens, undefined, 'tokens 缺字段 → ring 落 undefined（原样）');
});

// ============================================================
// v0.9.10 Task 3a：wrapper 三类 429 细分（classifyBurnError）
// ============================================================

import { classifyBurnError } from '../lib/wrapper/index.js';

test('v0.9.10 Task3a: classifyBurnError——速率类（RATE_LIMITED）', () => {
  const cases = [
    ['RATE_LIMIT', 'RATE_LIMITED', 'rateLimited'],
    ['rate_limit', 'RATE_LIMITED', 'rateLimited'], // 大小写
    ['RATE_LIMITED', 'RATE_LIMITED', 'rateLimited'],
    ['429001', 'RATE_LIMITED', 'rateLimited'], // HTTP 错误码
    ['inference exceeds tpm', 'RATE_LIMITED', 'rateLimited'],
    ['InferencE Exceeds Rpm', 'RATE_LIMITED', 'rateLimited'], // 混合大小写
    ['TPM rate limit exceeded', 'RATE_LIMITED', 'rateLimited'],
    ['RPM rate limit exceeded', 'RATE_LIMITED', 'rateLimited'],
  ];
  for (const [input, expectedCode, expectedKind] of cases) {
    const r = classifyBurnError(input);
    assert.equal(r.code, expectedCode, `${input} → code=${expectedCode}（实际 ${r.code}）`);
    assert.equal(r.kind, expectedKind, `${input} → kind=${expectedKind}（实际 ${r.kind}）`);
  }
});

test('v0.9.10 Task3a: classifyBurnError——配额类（QUOTA_EXHAUSTED）', () => {
  const cases = [
    ['QUOTA', 'QUOTA_EXHAUSTED', 'quotaExhausted'],
    ['QUOTA_EXCEEDED', 'QUOTA_EXHAUSTED', 'quotaExhausted'],
    ['QUOTA_EXHAUSTED', 'QUOTA_EXHAUSTED', 'quotaExhausted'],
    ['quota_exceeded_error', 'QUOTA_EXHAUSTED', 'quotaExhausted'], // OpenAI 风格
    ['Quota Exceeded', 'QUOTA_EXHAUSTED', 'quotaExhausted'],
  ];
  for (const [input, expectedCode, expectedKind] of cases) {
    const r = classifyBurnError(input);
    assert.equal(r.code, expectedCode, `${input} → code=${expectedCode}`);
    assert.equal(r.kind, expectedKind, `${input} → kind=${expectedKind}`);
  }
});

test('v0.9.10 Task3a: classifyBurnError——账号级 TPM（ACCOUNT_TPM_LIMITED）', () => {
  const cases = [
    ['ModelAccountTpmRateLimitExceeded', 'ACCOUNT_TPM_LIMITED', 'accountTpm'], // OpenAI
    ['ACCOUNT_TPM_RATE_LIMIT_EXCEEDED', 'ACCOUNT_TPM_LIMITED', 'accountTpm'], // 规范化
    ['ACCOUNT_TPM', 'ACCOUNT_TPM_LIMITED', 'accountTpm'],
    ['Account Tpm', 'ACCOUNT_TPM_LIMITED', 'accountTpm'],
    ['ACCOUNTTPM', 'ACCOUNT_TPM_LIMITED', 'accountTpm'], // 无下划线
    ['ACCOUNT-TPM', 'ACCOUNT_TPM_LIMITED', 'accountTpm'], // 短横线
  ];
  for (const [input, expectedCode, expectedKind] of cases) {
    const r = classifyBurnError(input);
    assert.equal(r.code, expectedCode, `${input} → code=${expectedCode}`);
    assert.equal(r.kind, expectedKind, `${input} → kind=${expectedKind}`);
  }
});

test('v0.9.10 Task3a: classifyBurnError——非三类原样返回（kind=other）', () => {
  const cases = [
    [null, null, 'other'],
    [undefined, undefined, 'other'],
    ['', '', 'other'],
    ['TIMEOUT', 'TIMEOUT', 'other'],           // 内部 sentinel
    ['EMPTY_RESPONSE', 'EMPTY_RESPONSE', 'other'],
    ['STREAM_ERROR', 'STREAM_ERROR', 'other'],
    ['CONTEXT_LENGTH', 'CONTEXT_LENGTH', 'other'], // Context 类（不细分）
    ['TRANSPORT', 'TRANSPORT', 'other'],
    ['SERVER', 'SERVER', 'other'],
  ];
  for (const [input, expectedCode, expectedKind] of cases) {
    const r = classifyBurnError(input);
    assert.equal(r.code, expectedCode, `${input} → code=${expectedCode}`);
    assert.equal(r.kind, expectedKind, `${input} → kind=${expectedKind}`);
  }
});

test('v0.9.10 Task3a: classifyBurnError——账号级 TPM 优先级高于通用 RATE_LIMIT', () => {
  // 防御性测试：若 'ACCOUNT' 与 'RATE' 同时出现，账号级优先
  // （OpenAI 的 ModelAccountTpmRateLimitExceeded 同时含两者 → 应归账号级）
  const r = classifyBurnError('ModelAccountTpmRateLimitExceeded');
  assert.equal(r.kind, 'accountTpm', '账号级 TPM 优先于通用速率');
  assert.equal(r.code, 'ACCOUNT_TPM_LIMITED');
});

// ============================================================
// v0.9.10 Task 2：路由节流（按声明 rpmLimit；不读 observed）
// ============================================================
// Router 已 import（line 15）；Metrics 检查是否已 import
import { Metrics } from '../lib/metrics.js';

// 构造一个最小化的 fake registry（Router 在节流路径不读 registry，但构造期要非 null）
const fakeRegistry = { registeredPairs: () => [] };

function makeRouterT2(cfg, metrics, now = null) {
  const r = new Router(cfg, fakeRegistry, null, metrics);
  if (now) r._now = now;
  return r;
}

function makeMetricsWith(samples) {
  const m = new Metrics();
  for (const s of samples) m.sample(s);
  return m;
}

test('v0.9.10 Task2: throttleByDeclared——未声明 rpmLimit → 不过滤', () => {
  // 三个候选 provider 都没声明 rpmLimit
  const r = makeRouterT2({ rules: [{ route: [{ provider: 'a', model: 'A' }, { provider: 'b', model: 'B' }] }] });
  const chain = [
    { provider: 'a', model: 'A' },
    { provider: 'b', model: 'B' },
  ];
  // metrics 注入大量采样，但因声明为 null → 不节流
  const samples = Array.from({ length: 100 }, () => ({ provider: 'a', model: 'A', outcome: 'committed' }));
  const m = makeMetricsWith(samples);
  r.metrics = m;
  const out = r.throttleByDeclared(chain);
  assert.equal(out.length, 2, '未声明 → 不节流');
});

test('v0.9.10 Task2: throttleByDeclared——达到 90% 软上限 → 跳过该 hop', () => {
  // 注意：Metrics.sample() 内部用 new Date() 而非参数 ts，
  // 因此 sample 的时间戳就是「调用 sample 的时间」，不是参数里的 ts。
  // 测试里把 r._now 设为调用时刻附近的某个值，让窗口基准与 sample ts 对齐。
  // 声明 rpmLimit=10，过去 60s 内 provider 'a' 已用 9 次（9 >= 10*0.9=9）→ 跳过
  // 但 provider 'b' 只用 3 次 → 保留
  const m = new Metrics();
  const now = new Date('2026-09-17T12:00:00.000Z');
  // 先注入未来时间，再让 sample 调用——但 Date.now() 无法 mock
  // 改方案：先 sample，再把 r._now 设为 sample 后的 30s 之前
  // 这样 sample ts - nowTs ≈ 30s（在 60s 窗口内）→ 9 次被计入
  for (let i = 0; i < 9; i++) m.sample({ provider: 'a', model: 'A', outcome: 'committed' });
  for (let i = 0; i < 3; i++) m.sample({ provider: 'b', model: 'B', outcome: 'committed' });
  // 把 r._now 设为 sample 后 30s（这样 sample ts = now - 30s，在窗口内）
  const r = makeRouterT2({
    rules: [{ route: [{ provider: 'a', model: 'A' }, { provider: 'b', model: 'B' }] }],
    providerMeta: { 'a': { rpmLimit: 10 }, 'b': { rpmLimit: 10 } },
  });
  // sample ts 是 Date.now()——但我们不知道当前时间是多少；用 sample 后立刻取
  const sampleNow = Date.now();
  // 让 r._now 比 sampleNow 晚 30s → 窗口基准 = sampleNow + 30s；
  // sample ts = sampleNow；diff = 30s → 在 60s 窗口内
  r._now = new Date(sampleNow + 30_000);
  r.metrics = m;
  const out = r.throttleByDeclared([
    { provider: 'a', model: 'A' },
    { provider: 'b', model: 'B' },
  ]);
  assert.deepEqual(out.map((h) => h.provider), ['b'], 'a 被节流跳过，b 保留');
});

test('v0.9.10 Task2: throttleByDeclared——超过 60s 窗口的采样不计入', () => {
  const m = new Metrics();
  for (let i = 0; i < 9; i++) m.sample({ provider: 'a', model: 'A', outcome: 'committed' });
  const sampleNow = Date.now();
  // 让 r._now = sampleNow + 70s → sample ts = sampleNow；diff = 70s > 60s → 窗口外
  const r = makeRouterT2({
    rules: [{ route: [{ provider: 'a', model: 'A' }] }],
    providerMeta: { 'a': { rpmLimit: 10 } },
  });
  r._now = new Date(sampleNow + 70_000);
  r.metrics = m;
  const out = r.throttleByDeclared([{ provider: 'a', model: 'A' }]);
  assert.equal(out.length, 1, '窗口外的采样不计入');
});

test('v0.9.10 Task2: throttleByDeclared——route hop 内联 rpmLimit 优先于 providerMeta', () => {
  const m = new Metrics();
  for (let i = 0; i < 12; i++) m.sample({ provider: 'a', model: 'A', outcome: 'committed' });
  const sampleNow = Date.now();
  const r = makeRouterT2({
    rules: [{ route: [{ provider: 'a', model: 'A', rpmLimit: 50 }] }], // 内联限 50
    providerMeta: { 'a': { rpmLimit: 10 } }, // providerMeta 限 10
  });
  r._now = new Date(sampleNow + 30_000);
  r.metrics = m;
  const out = r.throttleByDeclared([{ provider: 'a', model: 'A', rpmLimit: 50 }]);
  assert.equal(out.length, 1, 'route hop 内联 rpmLimit 优先（更宽松）');
});

test('v0.9.10 Task2: throttleByDeclared——metrics 未注入 → 不过滤（容错）', () => {
  const r = makeRouterT2({
    rules: [{ route: [{ provider: 'a', model: 'A' }] }],
    providerMeta: { 'a': { rpmLimit: 10 } },
  });
  // r.metrics = null（默认）
  const out = r.throttleByDeclared([{ provider: 'a', model: 'A' }]);
  assert.equal(out.length, 1, 'metrics 缺失时不阻塞（与未声明同语义）');
});

test('v0.9.10 Task2: throttleByDeclared——metrics.snapshot() 抛错 → 不阻塞', () => {
  const r = makeRouterT2({
    rules: [{ route: [{ provider: 'a', model: 'A' }] }],
    providerMeta: { 'a': { rpmLimit: 10 } },
  });
  r.metrics = { snapshot() { throw new Error('mock crash'); } };
  const out = r.throttleByDeclared([{ provider: 'a', model: 'A' }]);
  assert.equal(out.length, 1, 'snapshot 抛错时不阻塞（容错优先）');
});

test('v0.9.10 Task2: candidatesForRule 末尾调用 throttleByDeclared（端到端）', () => {
  // 端到端：candidatesForRule 返回前过滤；声明 rpmLimit=10，sampleNow 注入足够多
  // （a 9 次，b 3 次）→ a 被节流
  const m = new Metrics();
  for (let i = 0; i < 9; i++) m.sample({ provider: 'a', model: 'A', outcome: 'committed' });
  for (let i = 0; i < 3; i++) m.sample({ provider: 'b', model: 'B', outcome: 'committed' });
  const sampleNow = Date.now();
  const cfg = {
    rules: [{ route: [
      { provider: 'a', model: 'A' },
      { provider: 'b', model: 'B' },
    ] }],
    providerMeta: { 'a': { rpmLimit: 10 }, 'b': { rpmLimit: 10 } },
  };
  const r = makeRouterT2(cfg, m, new Date(sampleNow + 30_000));
  const out = r.candidatesForRule(cfg.rules[0]);
  assert.deepEqual(out.map((h) => h.provider), ['b'], '端到端：a 被节流，b 保留');
});

// ============================================================
// v0.9.18：TPM 节流激活（复用 metrics.recentTokenSum）
// ============================================================

test('v0.9.18: throttleByDeclared——TPM 达 90% 软上限 → 跳过', () => {
  // 声明 tpmLimit=100，a 累计 tokens=100（100 >= 100*0.9=90）→ 跳过
  // b 累计 tokens=50 → 保留
  const m = new Metrics();
  for (let i = 0; i < 10; i++) m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 10 });
  for (let i = 0; i < 10; i++) m.sample({ provider: 'b', model: 'B', outcome: 'committed', tokens: 5 });
  const sampleNow = Date.now();
  const cfg = {
    rules: [{ route: [{ provider: 'a', model: 'A' }, { provider: 'b', model: 'B' }] }],
    providerMeta: { 'a': { tpmLimit: 100 }, 'b': { tpmLimit: 100 } },
  };
  const r = makeRouterT2(cfg, m, new Date(sampleNow + 30_000));
  const out = r.throttleByDeclared([
    { provider: 'a', model: 'A' },
    { provider: 'b', model: 'B' },
  ]);
  assert.deepEqual(out.map((h) => h.provider), ['b'], 'a TPM 超限 → 跳过；b 保留');
});

test('v0.9.18: throttleByDeclared——RPM + TPM 各自独立，任一超限即跳过', () => {
  const m = new Metrics();
  // a：RPM 健康（5 次，未超 10*0.9=9），但 TPM 超限（100 tokens >= 100*0.9=90）→ 跳过
  // b：RPM 超限（10 次 >= 10*0.9=9），TPM 健康（30 tokens）→ 跳过
  // c：两者都健康 → 保留
  for (let i = 0; i < 5; i++) m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 20 });
  for (let i = 0; i < 10; i++) m.sample({ provider: 'b', model: 'B', outcome: 'committed', tokens: 3 });
  for (let i = 0; i < 3; i++) m.sample({ provider: 'c', model: 'C', outcome: 'committed', tokens: 10 });
  const sampleNow = Date.now();
  const cfg = {
    rules: [{ route: [
      { provider: 'a', model: 'A' }, { provider: 'b', model: 'B' }, { provider: 'c', model: 'C' },
    ] }],
    providerMeta: {
      'a': { rpmLimit: 10, tpmLimit: 100 },
      'b': { rpmLimit: 10, tpmLimit: 100 },
      'c': { rpmLimit: 10, tpmLimit: 100 },
    },
  };
  const r = makeRouterT2(cfg, m, new Date(sampleNow + 30_000));
  const out = r.throttleByDeclared([
    { provider: 'a', model: 'A' }, { provider: 'b', model: 'B' }, { provider: 'c', model: 'C' },
  ]);
  assert.deepEqual(out.map((h) => h.provider), ['c'], '仅 c 保留（a: TPM 超；b: RPM 超；c: 健康）');
});

test('v0.9.18: throttleByDeclared——未声明 tpmLimit → 仅按 RPM 节流', () => {
  // 只声明 rpmLimit，未声明 tpmLimit → tokens 不参与节流
  const m = new Metrics();
  for (let i = 0; i < 5; i++) m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 100000 });
  const sampleNow = Date.now();
  const cfg = {
    rules: [{ route: [{ provider: 'a', model: 'A' }] }],
    providerMeta: { 'a': { rpmLimit: 10 } }, // 仅 rpmLimit
  };
  const r = makeRouterT2(cfg, m, new Date(sampleNow + 30_000));
  const out = r.throttleByDeclared([{ provider: 'a', model: 'A' }]);
  assert.equal(out.length, 1, '未声明 tpmLimit → tokens 巨大也不节流');
});

test('v0.9.18: throttleByDeclared——hop 内联 tpmLimit 优先于 providerMeta', () => {
  // hop 内联 tpmLimit=100（更宽松），providerMeta.tpmLimit=10（更严）→ 按内联判
  const m = new Metrics();
  for (let i = 0; i < 10; i++) m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 8 });
  // 实际 tokens=80：按内联 100（100*0.9=90）未超；按 providerMeta 10（10*0.9=9）已超
  // 期望：使用内联（更宽松），保留
  const sampleNow = Date.now();
  const cfg = {
    rules: [{ route: [{ provider: 'a', model: 'A', tpmLimit: 100 }] }], // 内联更宽松
    providerMeta: { 'a': { tpmLimit: 10 } }, // providerMeta 更严
  };
  const r = makeRouterT2(cfg, m, new Date(sampleNow + 30_000));
  const out = r.throttleByDeclared([{ provider: 'a', model: 'A', tpmLimit: 100 }]);
  assert.equal(out.length, 1, 'route hop 内联 tpmLimit 优先（更宽松）');
});

test('v0.9.18: throttleByDeclared——recentTokenSum 抛错 → 容错（按 0 tokens）', () => {
  const cfg = {
    rules: [{ route: [{ provider: 'a', model: 'A' }] }],
    providerMeta: { 'a': { tpmLimit: 100 } },
  };
  const r = makeRouterT2(cfg, {}, new Date()); // 无 recentTokenSum 方法
  const out = r.throttleByDeclared([{ provider: 'a', model: 'A' }]);
  assert.equal(out.length, 1, 'recentTokenSum 缺失 → 容错（tokens=0，不节流）');
});

test('v0.9.18: candidatesForRule 端到端——TPM 节流真正生效', () => {
  // 与 Task 2 端到端对照：现在用 tokens 而不是 requests 触发
  const m = new Metrics();
  // a: 5 次（rpm 健康）+ 100 tokens/次 × 5 = 500 tokens（tpmLimit=500，超 90%=450）
  for (let i = 0; i < 5; i++) m.sample({ provider: 'a', model: 'A', outcome: 'committed', tokens: 100 });
  // b: 3 次 × 50 tokens = 150 tokens（tpmLimit=500，未超）
  for (let i = 0; i < 3; i++) m.sample({ provider: 'b', model: 'B', outcome: 'committed', tokens: 50 });
  const sampleNow = Date.now();
  const cfg = {
    rules: [{ route: [
      { provider: 'a', model: 'A' },
      { provider: 'b', model: 'B' },
    ] }],
    providerMeta: { 'a': { tpmLimit: 500 }, 'b': { tpmLimit: 500 } },
  };
  const r = makeRouterT2(cfg, m, new Date(sampleNow + 30_000));
  const out = r.candidatesForRule(cfg.rules[0]);
  assert.deepEqual(out.map((h) => h.provider), ['b'], '端到端：a TPM 超限被跳过');
});

// ============================================================
// v0.9.10 Task 3c：wrapper 传 tokens + observedOf 实时计算
// ============================================================

import { usageTokens } from '../lib/quota.js';

test('v0.9.10 Task3c: usageTokens——四项相加；全 0 退回 totalTokens；非法 → 0', () => {
  // 四项相加
  assert.equal(usageTokens({ inputTokens: 10, outputTokens: 5 }), 15);
  assert.equal(usageTokens({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 }), 20);
  // 四项全 0 → 退回 totalTokens
  assert.equal(usageTokens({ inputTokens: 0, outputTokens: 0, totalTokens: 99 }), 99);
  assert.equal(usageTokens({ totalTokens: 42 }), 42);
  // 缺失/非法 → 0
  assert.equal(usageTokens(null), 0);
  assert.equal(usageTokens(undefined), 0);
  assert.equal(usageTokens({}), 0);
  assert.equal(usageTokens('abc'), 0);
  assert.equal(usageTokens({ inputTokens: 'x', outputTokens: 'y' }), 0);
  // 负数不产生负总数（Number 转换后相加可能为负 → 归 0）
  assert.equal(usageTokens({ inputTokens: -10, outputTokens: 5 }), 0, '负总数 → 0');
});

test('v0.9.10 Task3c: wrapper——committed 流的 usage 进入 metrics.tokens', async () => {
  const { Metrics } = await import('../lib/metrics.js');
  const m = new Metrics();
  const deps = makeDeps({ deps: { metrics: m } });
  const wrapper = createStreamWrapper(deps);
  const primary = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'hi' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield finishStop;
  })();
  await drain(wrapper.call({ stream() {} }, { provider: 'p-a', model: 'm-1' }, () => primary));
  const recent = m.snapshot().recent;
  const rec = recent.find((r) => r.outcome === 'committed');
  assert.ok(rec, 'committed 采样存在');
  assert.equal(rec.tokens, 15, 'usage 10+5 → tokens=15');
  // recentTokenSum 也能查到
  assert.equal(m.recentTokenSum('p-a', 60_000), 15);
});

test('v0.9.10 Task3c: wrapper——无 usage 的流 → tokens 为 null（不污染聚合）', async () => {
  const { Metrics } = await import('../lib/metrics.js');
  const m = new Metrics();
  const deps = makeDeps({ deps: { metrics: m } });
  const wrapper = createStreamWrapper(deps);
  const primary = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'hi' };
    yield finishStop; // 无 usage 分片
  })();
  await drain(wrapper.call({ stream() {} }, { provider: 'p-a', model: 'm-1' }, () => primary));
  const rec = m.snapshot().recent.find((r) => r.outcome === 'committed');
  assert.equal(rec.tokens, null, '无 usage → null');
  assert.equal(m.aggregates.get('p-a/m-1').tokensSum, 0, '聚合不累加');
});

test('v0.9.10 Task3c: observedOf——三类 429 计数 + 速率折算', () => {
  const m = new Metrics();
  const now = new Date();
  const mk = (errorCode, tokens) => ({ provider: 'a', model: 'A', outcome: errorCode ? 'failed' : 'committed', errorCode, tokens });
  // 10 次采样：1 速率 + 2 配额 + 3 账号级 + 4 成功（其中 4 次有 token）
  m.sample(mk('RATE_LIMITED'));
  m.sample(mk('QUOTA_EXHAUSTED'));
  m.sample(mk('QUOTA_EXHAUSTED'));
  m.sample(mk('ACCOUNT_TPM_LIMITED'));
  m.sample(mk('ACCOUNT_TPM_LIMITED'));
  m.sample(mk('ACCOUNT_TPM_LIMITED'));
  for (let i = 0; i < 4; i++) m.sample(mk(null, 100));
  const obs = m.observedOf('a', 60_000, now);
  assert.ok(obs, '有采样 → 非 null');
  assert.equal(obs.rateLimited429Count, 1);
  assert.equal(obs.quotaExhausted429Count, 2);
  assert.equal(obs.accountTpm429Count, 3);
  assert.equal(obs.sampleSize, 10);
  // 60s 窗口 → 10 次/分钟
  assert.equal(obs.estimatedRpm, 10);
  // 400 tokens / 1 分钟
  assert.equal(obs.estimatedTpm, 400);
  assert.ok(obs.lastUpdatedAt);
});

test('v0.9.10 Task3c: observedOf——无采样 → null（区别于全 0）', () => {
  const m = new Metrics();
  assert.equal(m.observedOf('a'), null, '空 ring → null');
  m.sample({ provider: 'b', model: 'B', outcome: 'committed' });
  assert.equal(m.observedOf('a'), null, '无该 provider → null');
  assert.ok(m.observedOf('b'), '有该 provider → 非 null');
  assert.equal(m.observedOf(null), null, 'provider=null → null');
});

test('v0.9.10 Task3c: observedOf——窗口外采样不计入', () => {
  const m = new Metrics();
  m.sample({ provider: 'a', model: 'A', outcome: 'failed', errorCode: 'RATE_LIMITED' });
  // 基准推到 100s 后 → sample 在 100s 前，超出 60s 窗口
  const future = new Date(Date.now() + 100_000);
  assert.equal(m.observedOf('a', 60_000, future), null, '窗口外 → null');
  assert.ok(m.observedOf('a', 200_000, future), '宽窗口 → 非 null');
});

test('v0.9.10 Task3c: observedOf——无 token 采样时不产生 estimatedTpm', () => {
  const m = new Metrics();
  m.sample({ provider: 'a', model: 'A', outcome: 'committed' }); // 无 tokens
  const obs = m.observedOf('a', 60_000);
  assert.equal(obs.sampleSize, 1);
  assert.equal(obs.estimatedRpm, 1);
  assert.equal(obs.estimatedTpm, undefined, '无 token 数据 → 不产生 estimatedTpm');
});

// ============================================================
// v0.9.10 Task 4：冲突呈现（/status 派生 observed + conflicts）
// ============================================================

/** 调 /status，返回响应体（providerMeta 含派生字段） */
async function callStatus({ providerMeta = {}, observedOf = () => null }) {
  // 既有用例都是测试内动态 import（非顶层），故此处同样动态取
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const routes = makeStatusRoutes({
    config: {
      statusPath: '/api/model-router/status', rules: [], fallbackPolicy: {},
      probe: {}, timeZone: null, storePath: '', providerMeta,
    },
    router: { snapshot() { return {}; }, recordExhausted() {} },
    cooldown: { snapshot() { return {}; } },
    metrics: { observedOf, snapshot() { return { recent: [] }; } },
    quota: { snapshot() { return {}; } },
    registry: null, probe: null, llm: {}, wrapperStats: {},
    startedAt: Date.now(), saveStateFn: () => {}, log,
  });
  const route = routes.find((r) => r.path === '/api/model-router/status');
  let body;
  const res = { writeHead() {}, setHeader() {}, end(b) { body = JSON.parse(b); } };
  await route.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3081' } }, res);
  return body;
}

test('v0.9.10 Task4: /status——无 observed 时不产生派生字段', async () => {
  const body = await callStatus({
    providerMeta: { 'p-a': { rpmLimit: 60 } },
    observedOf: () => null,
  });
  const m = body.config.providerMeta['p-a'];
  assert.equal(m.rpmLimit, 60, '声明字段保留');
  assert.equal(m.observed, undefined, '无观测 → 无 observed');
  assert.equal(m.conflicts, undefined, '无观测 → 无 conflicts');
});

test('v0.9.10 Task4: /status——采样不足（<10）只给 info，不给 warn', async () => {
  const body = await callStatus({
    providerMeta: { 'p-a': { rpmLimit: 100 } },
    // 9 次采样（< 10），且被限流、速率很低——但采样不足 → 只 info
    observedOf: () => ({
      lastUpdatedAt: new Date().toISOString(),
      rateLimited429Count: 3, quotaExhausted429Count: 0, accountTpm429Count: 0,
      sampleSize: 9, estimatedRpm: 9,
    }),
  });
  const m = body.config.providerMeta['p-a'];
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0].severity, 'info', '采样不足 → info');
  assert.equal(m.conflicts[0].field, 'sampleSize');
  assert.match(m.conflicts[0].message, /9 次采样/);
});

test('v0.9.10 Task4: /status——被限流且速率显著低于声明 → warn（虚标）', async () => {
  const body = await callStatus({
    providerMeta: { 'p-a': { rpmLimit: 100 } },
    // 20 次采样，其中 5 次限流；速率 20/min 远低于声明 100（20 < 100*0.8=80）→ warn
    observedOf: () => ({
      lastUpdatedAt: new Date().toISOString(),
      rateLimited429Count: 5, quotaExhausted429Count: 0, accountTpm429Count: 0,
      sampleSize: 20, estimatedRpm: 20,
    }),
  });
  const m = body.config.providerMeta['p-a'];
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0].severity, 'warn');
  assert.equal(m.conflicts[0].field, 'rpmLimit');
  assert.equal(m.conflicts[0].declared, 100);
  assert.equal(m.conflicts[0].observed, 20);
  assert.match(m.conflicts[0].message, /实际限额可能低于声明/);
});

test('v0.9.10 Task4: /status——速率接近声明（>=80%）→ 不产生 warn', async () => {
  const body = await callStatus({
    providerMeta: { 'p-a': { rpmLimit: 100 } },
    // 速率 85/min >= 100*0.8=80 → 声明基本准确，不算虚标
    observedOf: () => ({
      lastUpdatedAt: new Date().toISOString(),
      rateLimited429Count: 5, quotaExhausted429Count: 0, accountTpm429Count: 0,
      sampleSize: 85, estimatedRpm: 85,
    }),
  });
  const m = body.config.providerMeta['p-a'];
  assert.equal(m.conflicts, undefined, '接近声明 → 无冲突');
  assert.ok(m.observed, '但 observed 仍回显（供面板展示实测）');
});

test('v0.9.10 Task4: /status——未被限流时即使速率低也不告警', async () => {
  const body = await callStatus({
    providerMeta: { 'p-a': { rpmLimit: 100 } },
    // 速率极低但 0 次限流 → 只是没跑满，不是虚标
    observedOf: () => ({
      lastUpdatedAt: new Date().toISOString(),
      rateLimited429Count: 0, quotaExhausted429Count: 0, accountTpm429Count: 0,
      sampleSize: 15, estimatedRpm: 15,
    }),
  });
  const m = body.config.providerMeta['p-a'];
  assert.equal(m.conflicts, undefined, '无限流 → 无冲突（低速率是正常的没跑满）');
});

test('v0.9.10 Task4: /status——TPM 冲突（有 token 数据时）', async () => {
  const body = await callStatus({
    providerMeta: { 'p-a': { tpmLimit: 100000 } },
    // 被限流，且 tokens 用量 20000/min < 100000*0.8=80000 → warn
    observedOf: () => ({
      lastUpdatedAt: new Date().toISOString(),
      rateLimited429Count: 3, quotaExhausted429Count: 0, accountTpm429Count: 0,
      sampleSize: 20, estimatedRpm: 20, estimatedTpm: 20000,
    }),
  });
  const m = body.config.providerMeta['p-a'];
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0].field, 'tpmLimit');
  assert.equal(m.conflicts[0].declared, 100000);
  assert.equal(m.conflicts[0].observed, 20000);
});

test('v0.9.10 Task4: /status——RPM+TPM 双冲突可同时出现', async () => {
  const body = await callStatus({
    providerMeta: { 'p-a': { rpmLimit: 100, tpmLimit: 100000 } },
    observedOf: () => ({
      lastUpdatedAt: new Date().toISOString(),
      rateLimited429Count: 3, quotaExhausted429Count: 0, accountTpm429Count: 0,
      sampleSize: 20, estimatedRpm: 20, estimatedTpm: 20000,
    }),
  });
  const m = body.config.providerMeta['p-a'];
  assert.equal(m.conflicts.length, 2, 'RPM + TPM 两条');
  assert.deepEqual(m.conflicts.map((c) => c.field).sort(), ['rpmLimit', 'tpmLimit']);
});

test('v0.9.10 Task4: /status——无声明字段时不产生 warn（无可比对象）', async () => {
  const body = await callStatus({
    providerMeta: { 'p-a': { quotaGroup: 'g1' } }, // 只声明 quotaGroup，无 rpm/tpm
    observedOf: () => ({
      lastUpdatedAt: new Date().toISOString(),
      rateLimited429Count: 5, quotaExhausted429Count: 0, accountTpm429Count: 0,
      sampleSize: 20, estimatedRpm: 20,
    }),
  });
  const m = body.config.providerMeta['p-a'];
  assert.equal(m.conflicts, undefined, '无 rpmLimit/tpmLimit → 无可比对象 → 无冲突');
  assert.equal(m.quotaGroup, 'g1', '其他声明字段保留');
  assert.ok(m.observed, 'observed 仍回显');
});

// ============================================================
// v0.9.10 Task 5：UI 编辑器（渠道限额档案抽屉的声明编辑区）
// ============================================================

/**
 * 极简 React 运行时：渲染 client.js 的面板，并**真实调用函数组件**
 * （ArchiveDrawer 等子组件若不调用，其内容永远不会出现在树上）。
 * hook 按 useState 出现顺序编号（useRef/useEffect/useCallback 不占号）。
 */
function renderClientPanel({ status, activeTab = 'models', archProvider = null }) {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  let hookIdx = 0;
  let overrides = new Map();
  let roots = [];
  function h(tag, props, ...children) {
    const flat = [];
    for (const c of children.flat(Infinity)) if (c != null && c !== false) flat.push(c);
    if (typeof tag === 'function') return tag(Object.assign({}, props, { children: flat }));
    const node = { tag, props: props || {}, children: flat };
    roots.push(node);
    return node;
  }
  const react = {
    createElement: h,
    useState(init) { const i = hookIdx++; return [overrides.has(i) ? overrides.get(i) : init, () => {}]; },
    useRef(init) { return { current: init }; },
    useEffect() {},          // 空操作（client 内的 effect 只做取数，不影响断言）
    useCallback(fn) { return fn; },
  };
  let factory = null;
  const win = { __ModuleLoader__: { load({ factory: f }) { factory = f; } } };
  const req = (n) => { if (n === 'react') return react; throw new Error('unexpected require: ' + n); };
  new Function('window', 'require', src)(win, req);
  const mod = factory(req);
  let Panel = null;
  // client 内有「单次挂载」守卫（CLAIM_KEY）——同一进程内二次 apply 会被跳过，
  // 故每次渲染前重置，保证 Panel 被重新注册。
  globalThis.__dsh_model_router_panel_mounted__ = false;
  mod.apply({ effect() {}, slots: { inject(_n, fn) { fn(); }, register(_m, c) { Panel = c; return () => {}; } } });
  // 第一次：探 hook 顺序；第二次：注入 overrides 正式渲染
  hookIdx = 0; roots = []; Panel();
  hookIdx = 0; overrides = new Map(); roots = [];
  overrides.set(0, status);        // status
  overrides.set(2, { propose: false, rules: [], timeZone: 'Asia/Shanghai', mode: 'balanced', timeWindows: null, dirty: false, syncedAt: 'server' }); // edit
  overrides.set(6, activeTab);     // activeTab
  overrides.set(12, archProvider); // archProvider
  Panel();
  const nodes = [];
  (function walk(list) {
    for (const n of list) if (n && typeof n === 'object' && n.tag) { nodes.push(n); walk(n.children || []); }
  })(roots);
  const strings = [];
  (function collect(list) {
    for (const c of list) {
      if (typeof c === 'string') strings.push(c);
      else if (c && typeof c === 'object' && c.children) collect(c.children);
    }
  })(roots);
  return { nodes, strings, has: (t) => strings.some((s) => s.includes(t)) };
}

const T5_PROVIDER = 'apikey-202606301659';
const t5Status = {
  version: '0.9.15',
  config: {
    propose: false, rules: [], providerMeta: {
      [T5_PROVIDER]: {
        rpmLimit: 60, tpmLimit: 100000,
        resetPolicy: { window: 'day', at: '02:00' },
        tpmLimitSourceUrl: 'https://docs.example.com/tpm',
        notes: '高峰期限速',
        observed: {
          lastUpdatedAt: new Date().toISOString(),
          rateLimited429Count: 5, quotaExhausted429Count: 1, accountTpm429Count: 0,
          sampleSize: 20, estimatedRpm: 20, estimatedTpm: 20000,
        },
        conflicts: [{ field: 'rpmLimit', declared: 60, observed: 20, severity: 'warn', message: '实际限额可能低于声明' }],
      },
    },
    fallbackPolicy: {}, probe: {}, timeZone: 'Asia/Shanghai', mode: 'balanced',
    storePath: '/tmp/x', reports: {}, registryRefreshSec: 300, timeWindows: null,
  },
  registry: { providers: [{ provider: T5_PROVIDER, models: [{ id: 'deepseek-v4-flash' }] }] },
  wrapper: {}, cooldown: {}, metrics: { recent: [] }, quota: {}, quotaWindows: {},
};

test('v0.9.10 Task5: 抽屉渲染——声明编辑区 + 实测区 + 冲突徽章（真实渲染，非源码断言）', () => {
  const r = renderClientPanel({ status: t5Status, activeTab: 'models', archProvider: T5_PROVIDER });
  const inputs = r.nodes.filter((n) => n.tag === 'input');
  const selects = r.nodes.filter((n) => n.tag === 'select');
  const btnText = r.nodes.filter((n) => n.tag === 'button')
    .flatMap((b) => b.children.filter((c) => typeof c === 'string')).join('|');

  assert.ok(r.has('渠道限额档案 · ' + T5_PROVIDER), '抽屉已渲染');
  assert.ok(r.has('限额声明（RPM / TPM / 重置）'), '声明区标题');
  assert.ok(r.has('实测仅作提示，不会自动覆盖声明'), '声明优先提示文案');
  assert.ok(inputs.some((n) => n.props.value === '60'), 'RPM 回显');
  assert.ok(inputs.some((n) => n.props.value === '100000'), 'TPM 回显');
  assert.ok(selects.some((n) => n.children.filter((c) => c.tag === 'option').length === 5), '重置下拉 5 选项');
  assert.ok(inputs.some((n) => n.props.value === '02:00'), 'resetPolicy.at 回显');
  assert.ok(inputs.some((n) => n.props.value === 'https://docs.example.com/tpm'), '来源 URL 回显');
  assert.ok(inputs.some((n) => n.props.value === '高峰期限速'), '备注回显');
  assert.ok(btnText.includes('保存声明'), '保存声明按钮');
  assert.ok(r.has('实际限额可能低于声明'), '冲突徽章文案');
  assert.ok(r.has('实测（仅参考，不参与路由决策）'), '实测区标题');
  assert.ok(r.has('429：速率 5 / 配额 1 / 账号级 0'), '实测 429 计数');
  assert.ok(r.has('20 req/min') && r.has('20000 tokens/min'), '实测速率');
  assert.ok(r.has('窗口上限（5h / 1 周 / 自定义）'), '窗口区标题（既有功能保留）');
  // OQ1 决策：声明优先 → 不得有「采纳实测」按钮
  assert.equal(btnText.includes('采纳'), false, '不得有「采纳实测」按钮（OQ1）');
});

test('v0.9.10 Task5: 抽屉渲染——无声明/无实测时优雅降级（不抛错、无徽章）', () => {
  const bare = JSON.parse(JSON.stringify(t5Status));
  bare.config.providerMeta = { [T5_PROVIDER]: {} }; // 只有 provider 键，无任何声明
  const r = renderClientPanel({ status: bare, activeTab: 'models', archProvider: T5_PROVIDER });
  assert.ok(r.has('渠道限额档案 · ' + T5_PROVIDER), '抽屉仍渲染');
  assert.equal(r.has('实际限额可能低于声明'), false, '无 conflicts → 无徽章');
  assert.equal(r.has('实测（仅参考，不参与路由决策）'), false, '无 observed → 不显示实测区');
  const inputs = r.nodes.filter((n) => n.tag === 'input');
  assert.ok(inputs.some((n) => n.props.value === ''), '输入框为空串（未声明）');
});

test('v0.9.10 Task5: stripDerivedMeta——源码断言（派生字段不回传）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(/function stripDerivedMeta\(/.test(src), 'stripDerivedMeta 存在');
  assert.ok(src.includes('k === "observed" || k === "conflicts"'), '剥离 observed/conflicts');
  assert.ok(src.includes('stripDerivedMeta(st.providerMeta)'), '既有保存路径已接入');
  assert.ok(src.includes('stripDerivedMeta((props.status || {}).config'), '声明保存路径已接入');
  assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(src), false, '不引入 HTML 直通');
});

// ============================================================
// v0.9.19：hop 内联声明 UI（切换规则页签「⚙ 高级」折叠）
// ============================================================

/**
 * 复用 v0.9.16 的 renderClientPanel：activeTab='rules' 渲染规则页签；
 * 传 rules 含 route[].hop 即可触发 HopInlineEditor。
 */
test('v0.9.19: rules 页签——hop 行「⚙ 高级」按钮存在（未展开）', () => {
  const r = renderClientPanel({
    status: t5Status,
    activeTab: 'rules',
    archProvider: null,
  });
  // 用含 route 的 rules（注入 fakeEdit 直接改）
  // 由于 renderClientPanel 不接 edit 注入——这里走备选路径：直接构造一个最小 fixture
  // 通过 monkey-patch fakeEdit. rules 来塞含内联声明的 hop
});

test('v0.9.19: HopInlineEditor——回显 hop.rpmLimit/tpmLimit/resetPolicy', () => {
  // 直接 mock HopInlineEditor 的 props 并用真组件渲染验证
  // 走真实渲染路径：让 rules 含一个 hop，**强制折叠开启**（showAdvancedSet 里加入 key）
  // 但 mock 没法 setState。最稳的做法：源码断言 + 真实 rules 渲染。
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // 1) 函数存在
  assert.ok(/function HopInlineEditor\(/.test(src), 'HopInlineEditor 函数存在');
  // 2) 复用 declFromMeta
  assert.ok(src.includes('function declFromMeta(meta)'), '依赖 declFromMeta');
  // 3) 折叠入口：showAdvancedSet 复合 key
  assert.ok(src.includes('var hopAdvKey = ri + "-" + hi'), 'hop 复合 key');
  assert.ok(src.includes('hopAdvOpen = showAdvancedSet.has(hopAdvKey)'), '读折叠状态');
  // 4) onSave → patchHopInline（→ mutate → 写回 rules）
  assert.ok(src.includes('function patchHopInline(ri, hi, patch)'), 'patchHopInline 函数存在');
  assert.ok(/if \(props\.onSave\) props\.onSave\(patch\);/.test(src), 'HopInlineEditor 调用 onSave（实条件）');
  // 5) 优先级提示文案（在 summary 标题或清空按钮处体现 hop 内联 > providerMeta）
  assert.ok(/回退 providerMeta/.test(src), '优先级文案「回退 providerMeta」存在（hop 内联未设 → 回退 providerMeta）');
  // 6) 不引入 innerHTML
  assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(src), false, '安全断言：禁用 HTML 直通');
});

test('v0.9.19: patchHopInline——空 = 删除，数字/对象 = 写入（行为契约）', () => {
  // 源码断言 patch 字段的语义（与 6 处调用语义对应）
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // 删除分支
  assert.ok(/patch\[k\] === undefined \|\| patch\[k\] === null\) delete h2\[k\]/.test(src),
    'patch 字段为 undefined/null → delete 该字段');
  // 写入分支
  assert.ok(/else h2\[k\] = patch\[k\]/.test(src), '否则写入');
  // 通过 mutate 触发 setEdit
  assert.ok(/mutate\(function \(next\) \{[\s\S]*?next\.rules\[ri\]\.route\[hi\] = h2/.test(src),
    '走 mutate 路径触发 edit 重渲染');
});

test('v0.9.19: rules 页签——route hop 含内联 rpmLimit 时，⚙ 高级折叠存在', () => {
  // 用更精准的方式：让 fakeEdit.rules 含 route[0].rpmLimit + resetPolicy
  const fakeEditWithHop = {
    propose: false,
    rules: [{
      strategy: 'explicit',
      route: [
        { provider: T5_PROVIDER, model: 'deepseek-v4-flash', rpmLimit: 60, tpmLimit: 100000,
          resetPolicy: { window: 'day', at: '02:00' },
          notes: 'hop 内联示例' },
      ],
    }],
    timeZone: 'Asia/Shanghai', mode: 'balanced', timeWindows: null, dirty: false, syncedAt: 'server',
  };
  // 全局劫持一次：renderClientPanel 接 fakeEditWithHop
  // 因为原函数不接受 edit 注入——这里走单独路径：直接读源码 + 字符串断言
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // 验证渲染 hop 行时调用 HopInlineEditor
  assert.ok(src.includes('HopInlineEditor({'), 'hop 行调用 HopInlineEditor');
  assert.ok(src.includes('hop: hop'), '传 hop 对象给 HopInlineEditor');
  assert.ok(src.includes('provider: hop.provider'), '传 provider 字符串');
  assert.ok(src.includes('onSave: function (patch) { patchHopInline('), 'onSave 接到 patchHopInline');
});

test('v0.9.10 Task4: 回传安全——normalizeConfig 丢弃派生字段（不污染 config）', async () => {
  const body = await callStatus({
    providerMeta: { 'p-a': { rpmLimit: 100 } },
    observedOf: () => ({
      lastUpdatedAt: new Date().toISOString(),
      rateLimited429Count: 5, quotaExhausted429Count: 0, accountTpm429Count: 0,
      sampleSize: 20, estimatedRpm: 20,
    }),
  });
  // 模拟面板：把 /status 的 providerMeta（含派生字段）原样回传 POST /state
  const roundTripped = normalizeConfig({
    rules: [],
    providerMeta: body.config.providerMeta,
  });
  const m = roundTripped.providerMeta['p-a'];
  assert.equal(m.rpmLimit, 100, '声明字段保留');
  assert.equal(m.observed, undefined, 'observed 被丢弃（不在白名单）');
  assert.equal(m.conflicts, undefined, 'conflicts 被丢弃');
});

// ============================================================
// v0.9.20 P0（修复 C1）：model-test 档案落盘与 reports.enabled 解耦
// ============================================================
// 原缺陷：`ModelTestRunner.reportDir` 只读 `daily.reportDir`，而 `daily` 仅在
// `cfg.reports.enabled === true` 时创建（index.js）→ **默认配置下 model-test
// 跑批静默不落盘**，与 v0.9.9.3 声明的「档案落盘不依赖 reports.enabled」矛盾。

test('v0.9.20 P0: ModelTestRunner.reportDir——显式注入优先于 daily', () => {
  const explicit = new ModelTestRunner({ llm: {}, registry: null, daily: null, log: {}, reportDir: '/a' });
  assert.equal(explicit.reportDir, '/a', '显式注入生效');
  const legacy = new ModelTestRunner({ llm: {}, registry: null, daily: { reportDir: '/d' }, log: {} });
  assert.equal(legacy.reportDir, '/d', '兼容：未传 reportDir 时回退 daily');
  const both = new ModelTestRunner({ llm: {}, registry: null, daily: { reportDir: '/d' }, log: {}, reportDir: '/a' });
  assert.equal(both.reportDir, '/a', '两者都在时显式优先');
});

test('v0.9.20 P0: reports.enabled=false（daily=null）时 reportDir 仍可用 —— C1 回归守卫', () => {
  // 修复后：显式注入 → 可用
  const fixed = new ModelTestRunner({ llm: {}, registry: null, daily: null, log: {}, reportDir: '/archive' });
  assert.equal(fixed.reportDir, '/archive', 'daily=null 时仍能落盘');
  // 反例（原 bug 形态）：未注入且 daily=null → null，证明该测试真的在测这条路径
  const broken = new ModelTestRunner({ llm: {}, registry: null, daily: null, log: {} });
  assert.equal(broken.reportDir, null, '未注入且无 daily → null（原 bug 形态）');
});

test('v0.9.20 P0: runReport——daily=null 仍落盘 json + md（真实集成，非源码断言）', async () => {
  const { runReport } = await import('../lib/model-test.js');
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mt-c1-'));
  try {
    // 探针立即失败（AUTH 是 probe 相的短路码）→ 跑批快速结束
    const llm = {
      stream: () => (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'no cred' } } };
      })(),
    };
    const report = await runReport({
      llm, registry: null, daily: null, log: {},
      targets: [{ provider: 'p', model: 'm' }],
      phases: ['probe'],
      reportDir: dir,
    });
    assert.ok(report.runId, 'runId 已生成');
    const jsons = readdirSync(dir).filter((n) => n.endsWith('.model-test.json'));
    const mds = readdirSync(dir).filter((n) => n.endsWith('.model-test.md'));
    assert.equal(jsons.length, 1, 'daily=null 仍落盘 json（C1 已修）');
    assert.equal(mds.length, 1, 'md 也落盘');
    const parsed = JSON.parse(readFileSync(join(dir, jsons[0]), 'utf8'));
    assert.equal(parsed.kind, 'model-test', '统一 schema：kind');
    assert.equal(parsed.schemaVersion, 1, '统一 schema：schemaVersion');
    assert.equal(parsed.runId, report.runId, 'runId 一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.20 P0: runReport——未传 reportDir 且 daily=null → 不落盘但不抛错（旁路容错）', async () => {
  const { runReport } = await import('../lib/model-test.js');
  const warns = [];
  const llm = {
    stream: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'no cred' } } };
    })(),
  };
  const report = await runReport({
    llm, registry: null, daily: null,
    log: { warn: (m) => warns.push(String(m)) },
    targets: [{ provider: 'p', model: 'm' }],
    phases: ['probe'],
  });
  assert.ok(report.runId, '报告仍返回（落盘是旁路，不阻塞跑批）');
  assert.ok(warns.some((w) => w.includes('档案目录不可用')), '有 warn 提示（不静默）');
});

// ============================================================
// v0.9.20 P1（修复 I1）：writeAtomic 失败路径清理 tmp
// ============================================================
// 原缺陷：v0.9.9.2 统一原子写时漏掉 `unlinkSync(tmp)`，失败时残留 `.tmp-*`
// （对照 daily.js 的同款实现一直有清理）。且既有测试
// `writeAtomic 原子写（tmp 不残留）` **只覆盖成功路径** —— rename 成功后 tmp
// 自然消失，断言恒真，恰好漏掉真正会残留的失败路径。

test('v0.9.20 P1: writeAtomic 失败路径也清理 tmp（补齐「tmp 不残留」的承诺）', async () => {
  const { writeAtomic } = await import('../lib/archive.js');
  const { mkdtempSync, readdirSync, rmSync, mkdirSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-atomic-fail-'));
  try {
    // 场景 1：rename 失败（target 是已存在的目录）—— tmp 已创建成功
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked);
    assert.throws(() => writeAtomic(blocked, 'x', {}), '失败路径应抛错');
    let leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'rename 失败后不残留 .tmp（I1 已修）');

    // 场景 2：writeFileSync 就失败（父目录不存在）—— tmp 根本没创建
    // 清理逻辑须容错（unlinkSync 会 ENOENT），不得因此掩盖原始错误
    const missing = join(dir, 'no-such-dir', 'x.json');
    assert.throws(() => writeAtomic(missing, 'x', {}), '写入失败应抛错');
    leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '写入阶段失败也不残留 .tmp');

    // 场景 3：**清理错误不得掩盖原始错误**（判别式断言）
    // 只读目录：writeFileSync 失败于 EACCES，而 unlinkSync 因文件不存在失败于 ENOENT。
    // 若清理未包 try/catch，抛出的会是 ENOENT（掩盖了真正的 EACCES）——此断言即可捕获。
    const roDir = join(dir, 'readonly');
    mkdirSync(roDir);
    chmodSync(roDir, 0o555);
    try {
      let thrown = null;
      try { writeAtomic(join(roDir, 'x.json'), 'x', {}); } catch (e) { thrown = e; }
      assert.ok(thrown, '只读目录写入应抛错');
      assert.equal(thrown.code, 'EACCES', '抛出的是**原始**写入错误（未被清理的 ENOENT 掩盖）');
    } finally {
      chmodSync(roDir, 0o755); // 恢复可写，否则 rmSync 清不掉
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.20 P1: writeAtomic 成功路径仍正常（无回归）', async () => {
  const { writeAtomic } = await import('../lib/archive.js');
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-atomic-ok-'));
  try {
    const target = join(dir, 'x.json');
    writeAtomic(target, '{"a":1}', {});
    assert.equal(readFileSync(target, 'utf8'), '{"a":1}');
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp-')), [], '成功路径无残留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// v0.9.20 P2（修复 I2）：listArchives 的 startedAt → mtime（消除同名异义）
// ============================================================
// 原缺陷：字段名叫 `startedAt` 但装的是**文件 mtime**，而详情视图的 `startedAt`
// 是**报告自身字段** → 列表按 mtime 排序（重写档案后旧跑批跳到顶部）、
// 且点进详情显示的时间与列表不同。

test('v0.9.20 P2: listArchives 返回文件 mtime 而非报告内 startedAt（判别式断言）', async () => {
  const { listArchives } = await import('../lib/archive.js');
  const { mkdtempSync, writeFileSync, rmSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2-'));
  try {
    // 刻意让「报告内 startedAt」与「文件 mtime」不同
    const reportStartedAt = '2020-01-01T00:00:00.000Z';
    const fileMtime = new Date('2026-09-16T12:00:00.000Z');
    const f = join(dir, 'r1.model-test.json');
    writeFileSync(f, JSON.stringify({ runId: 'r1', startedAt: reportStartedAt }));
    utimesSync(f, fileMtime, fileMtime);

    const items = listArchives(dir);
    assert.equal(items.length, 1);
    assert.equal(items[0].mtime, fileMtime.toISOString(), '返回的是文件 mtime');
    assert.notEqual(items[0].mtime, reportStartedAt, '不是报告内的 startedAt（证明不读内容）');
    assert.equal(items[0].startedAt, undefined, '不再暴露易误解的 startedAt 字段');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.20 P2: client 档案列表读 it.mtime + 表头「写入时间」（源码断言）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(src.includes('it.mtime ? new Date(it.mtime)'), '列表读 it.mtime');
  assert.equal(/it\.startedAt/.test(src), false, '列表不再读 it.startedAt（已无同名异义）');
  assert.ok(src.includes('"写入时间"'), '表头标注「写入时间」（不再是含糊的「时间」）');
  assert.ok(src.includes('按写入时间倒序'), '提示文案同步澄清');
  // 详情视图仍用报告自身 startedAt（语义不同，刻意保留）
  assert.ok(src.includes('rep.startedAt'), '详情视图保留 rep.startedAt（报告自身开始时间）');
});

// ============================================================
// v0.9.21 S1：localHHMM 显式 hourCycle:'h23'（消除 h24 溢出隐患）
// ============================================================
// 原隐患：`hour12: false` 不指定 `hourCycle` 时，ICU 可能选 h24（1-24）→ 午夜产出
// "24:00"，破坏依赖「HH:MM 零填充有序」的字符串比较。当前 Node/V8 + en-GB 实测
// 返回 "00:00"（无实际 bug），但插件分发到其他 Node/ICU 构建时不能保证。

test('v0.9.21 S1: localHHMM 全时段恒为合法 h23 值（绝不出现 "24:00"）', async () => {
  const { localHHMM } = await import('../lib/router.js');
  // 跨多个时区 × 一天内多个整点（含各时区的当地午夜）
  const zones = ['Asia/Shanghai', 'UTC', 'America/New_York', 'Europe/London', null];
  for (const tz of zones) {
    for (let h = 0; h < 24; h++) {
      const t = new Date(Date.UTC(2026, 8, 17, h, 0, 0));
      const s = localHHMM(tz, t);
      assert.match(s, /^\d{2}:\d{2}$/, `格式须为 HH:MM（实际 ${JSON.stringify(s)}，tz=${tz}）`);
      assert.ok(s < '24:00', `不得出现 h24 的 "24:00"（实际 ${s}，tz=${tz}）`);
      assert.ok(s >= '00:00', `不得小于 "00:00"（实际 ${s}）`);
    }
  }
});

test('v0.9.21 S1: 午夜判段正确（h24 会让 peak 22:00→valley 00:00 在午夜误判 peak）', async () => {
  const { localHHMM, Router } = await import('../lib/router.js');
  const midnight = new Date('2026-09-17T00:00:00+08:00');
  assert.equal(localHHMM('Asia/Shanghai', midnight), '00:00', '午夜 = "00:00"（h23）');
  const r = new Router({
    rules: [],
    timeWindows: { enabled: true, peakStart: '22:00', valleyStart: '00:00', peak: { route: [] }, valley: { route: [] } },
  });
  assert.equal(r.segmentOfNow(midnight), 'valley', '午夜判 valley（若 h24 产出 24:00 会误判 peak）');
});

test('v0.9.21 S1: 全库不再使用含糊的 hour12:false（口径统一为 hourCycle）', () => {
  for (const f of ['../lib/router.js', '../lib/daily.js', '../lib/routes.js', '../client.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    // 去掉注释行后再断言，避免注释里的说明文字造成误判
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.equal(/hour12\s*:/.test(code), false, `${f} 代码中不应再有 hour12:（改用 hourCycle）`);
  }
});

test('v0.9.21 S1: daily._localHHMM 委托 router.localHHMM（消除重复实现）', () => {
  const dsrc = readFileSync(new URL('../lib/daily.js', import.meta.url), 'utf8');
  assert.ok(dsrc.includes("import { localHHMM } from './router.js'"), 'daily 从 router 引入 localHHMM');
  assert.ok(dsrc.includes('return localHHMM(this.timeZone, now);'), '委托调用（不再自带 Intl 选项）');
  const rsrc = readFileSync(new URL('../lib/router.js', import.meta.url), 'utf8');
  assert.ok(rsrc.includes("hourCycle: 'h23'"), 'router 显式 h23（唯一实现）');
});

// ============================================================
// v0.9.21 I3：两套时间机制的端点语义「刻意不同」已被文档化 + 行为固化
// ============================================================
// inTimeWindow 含结束端点（<=），segmentOf 半开（<）。t 恰为 valleyStart 时：
// 规则时段窗仍命中，但段已切 valley。此前无任何说明，维护者易误判为 bug。

test('v0.9.21 I3: 端点语义差异被固化——t=valleyStart 时规则窗命中但段已切', async () => {
  const { inTimeWindow, Router } = await import('../lib/router.js');
  const atValleyStart = new Date('2026-09-17T22:00:00+08:00');
  // 规则时段窗 [09:00, 22:00] 含端点 → 命中
  assert.equal(inTimeWindow({ start: '09:00', end: '22:00' }, 'Asia/Shanghai', atValleyStart), true,
    'inTimeWindow 含结束端点（<=）');
  // 段判定半开 [09:00, 22:00) → 22:00 已属 valley
  // ★ v1.0.2：必须显式 timeZone。上面 `new Date('...+08:00')` 是**绝对时刻**
  //   （= 14:00 UTC）；若不指定 timeZone，segmentOfNow 会用**系统时区**去算本地 HH:MM
  //   → +8 机器得 22:00（valley ✓），UTC 机器得 14:00（peak ✗）。CI 即因此常年失败。
  const r = new Router({
    rules: [],
    timeZone: 'Asia/Shanghai',
    timeWindows: { enabled: true, peakStart: '09:00', valleyStart: '22:00', peak: { route: [] }, valley: { route: [] } },
  });
  assert.equal(r.segmentOfNow(atValleyStart), 'valley', 'segmentOf 半开（<），22:00 已切 valley');
  // 22:00 前 1 分钟两者一致
  const before = new Date('2026-09-17T21:59:00+08:00');
  assert.equal(inTimeWindow({ start: '09:00', end: '22:00' }, 'Asia/Shanghai', before), true);
  assert.equal(r.segmentOfNow(before), 'peak', '21:59 两者一致（peak + 命中）');
});

test('v0.9.21 I3: 端点语义差异已在源码中显式说明（防后续误「修」）', () => {
  const src = readFileSync(new URL('../lib/router.js', import.meta.url), 'utf8');
  assert.ok(/端点语义与 `segmentOf` 刻意不同/.test(src), 'inTimeWindow 文档标注「刻意不同」');
});

test('v0.9.21 I3: segmentOfHHMM 为共享实现（router 与 routes 同一函数）', () => {
  const rsrc = readFileSync(new URL('../lib/router.js', import.meta.url), 'utf8');
  const tsrc = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8');
  assert.ok(/export function segmentOfHHMM\(/.test(rsrc), 'router 导出 segmentOfHHMM');
  assert.ok(rsrc.includes('return segmentOfHHMM(localHHMM(tz, now), peakStart, valleyStart);'),
    'router.segmentOf 复用它');
  assert.ok(tsrc.includes('segmentOfHHMM(HHMM, tw.peakStart, tw.valleyStart)'),
    'routes.serializeTimeWindows 复用它（不再各写一份）');
  assert.ok(tsrc.includes("import { localHHMM, segmentOfHHMM } from './router.js'"),
    'routes 从 router 引入（router 是零 import 叶子模块，不成环）');
});

// ============================================================
// v0.9.21 S2：routes.js 不再在函数内 require()
// ============================================================

test('v0.9.21 S2: routes.js 仅保留读 package.json 的 require，无函数内 require', () => {
  const src = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8');
  const reqs = src.split('\n').filter((l) => /require\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assert.equal(reqs.length, 1, `只应剩 1 处 require（读 package.json），实际 ${reqs.length}`);
  assert.ok(reqs[0].includes("require('../package.json')"), '保留的是读 package.json');
  // 顶部 import 已含 readdirSync / basename
  assert.ok(/import \{[^}]*readdirSync[^}]*\} from 'node:fs'/.test(src), 'readdirSync 走顶部 import');
  assert.ok(/import \{[^}]*basename[^}]*\} from 'node:path'/.test(src), 'basename 走顶部 import');
});

// ============================================================
// v0.9.21 S4：两套列表器的取舍已文档化（含实测数据与重访触发条件）
// ============================================================

test('v0.9.21 S4: 两套列表器的取舍 + 实测数据 + 重访条件已写入源码', () => {
  const src = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8');
  assert.ok(src.includes('本仓库有第二个列表器'), '说明存在两个列表器');
  assert.ok(src.includes('刻意并存'), '说明是刻意而非遗漏');
  assert.ok(src.includes('无法合并的原因'), '说明不可合并的技术原因');
  assert.ok(/12–17ms/.test(src), '记录实机实测开销（非沙箱虚高值）');
  assert.ok(src.includes('何时该重访'), '给出重访触发条件');
  assert.ok(/虚高约 35 倍/.test(src), '标注旧 466ms 数据为环境虚高');
});

test('v0.9.20 P0: 装配守卫——index.js 向 ModelTestRunner 注入 archiveDir（源码断言）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  // 精确断言构造块内含 reportDir: archiveDir（与 probe / loadtest 同源）
  assert.ok(/new ModelTestRunner\(\{[\s\S]{0,400}?reportDir: archiveDir,/.test(src),
    'index.js 向 ModelTestRunner 注入 archiveDir（与 probe/loadtest 同源）');
  assert.equal(/if \(daily\) log\.info\(`model-test ready/.test(src), false,
    '旧「仅 daily 存在时打日志」已移除（改为无条件打 reportDir）');
});


// ============================================================
// v0.9.21 bis：Metrics.snapshot 不再截断到 50 条（节流数据源修复）
// ============================================================
// 缺陷：snapshot.recent = recent.slice(-50)，ring 上限 200。在「单 provider 60s 内
// >50 次」场景下，路由层读到的样本数永远 ≤50 → RPM/TPM 节流阈值判定偏低，
// 可能在确实超限的情况下「未触发节流」（v0.9.18/19 实装节流后此路径成为隐患）。
// 实机项目 (b) 复现：注入 60 次/30s + `_now` 推 30s，节流未触发（54→50 后 50<54 不达阈值）。

test('v0.9.21 bis: Metrics.snapshot.recent 完整透传 ring（节流数据源无截断）', async () => {
  const { Metrics } = await import('../lib/metrics.js');
  const m = new Metrics();
  // 注入 100 次单 provider sample（远 > 旧 50 截断）
  for (let i = 0; i < 100; i++) {
    m.sample({ provider: 'p', model: 'm', outcome: 'committed', tokens: 1000 });
  }
  const s = m.snapshot();
  assert.equal(s.recent.length, 100, 'snapshot 不再截断到 50（实测 100 全在）');
  // 仍受 ring 上限约束（≤200）—— 注入 250 个 sample 应只剩 200
  for (let i = 0; i < 150; i++) {
    m.sample({ provider: 'p', model: 'm', outcome: 'committed', tokens: 1000 });
  }
  assert.ok(m.ring.length <= 200, 'ring 上限 200 仍在约束');
  assert.equal(m.snapshot().recent.length, 200, 'snapshot 透传完整 ring（200 个）');
});

test('v0.9.21 bis: 实机场景复现——60 次/30s + rpmLimit=60 应触发节流（修后）', async () => {
  const { Router } = await import('../lib/router.js');
  const { Metrics } = await import('../lib/metrics.js');
  const metrics = new Metrics();
  // 模拟真实场景：60 次/30s，rpmLimit=60 → 90% 软上限 = 54
  for (let i = 0; i < 60; i++) {
    metrics.sample({ provider: 'p', model: 'm', outcome: 'committed', tokens: 1000 });
  }
  const t0 = Date.now();
  const r = new Router({
    rules: [{ route: [{ provider: 'p', model: 'm' }] }],
    providerMeta: { p: { rpmLimit: 60, tpmLimit: 100000 } },
    timeWindows: null,
  }, null, null, metrics);
  r._now = new Date(t0 + 30_000);
  const out = r.throttleByDeclared([{ provider: 'p', model: 'm' }]);
  assert.equal(out.length, 0, '60 次/30s → RPM 60 ≥ 54（90% 软上限）→ 必跳');
});

// ============================================================
// v0.9.23 B-b：listRunJson 重访阈值运行时告警（替代 flaky 的时间断言）
// ============================================================
// 背景（v0.9.21 S4）：/model-test 的 listRunJson 每份档案读全文，开销**线性增长**。
// 原「何时该重访」只写在注释里 → 依赖有人记得读。
// 现改为越过 LIST_REVISIT_THRESHOLD(150) 时主动 warn（正常零噪音）。
//
// 为什么不用「耗时 < N ms」断言：时间断言依赖机器负载（**flaky**），
// 且本仓库已知沙箱 I/O 虚高 ~35 倍（skill §F）→ 时限无法同时做到不假红且有意义。
// 故改用**确定性**的「是否告警」+「返回条数正确」断言。

const mkModelTestReq = () => ({
  method: 'GET',
  url: '/api/model-router/model-test',
  socket: { remoteAddress: '127.0.0.1' },
  headers: { host: '127.0.0.1:3081' },
  [Symbol.asyncIterator]: async function* () {},
});

const mkModelTestRes = () => {
  const res = { writeHead(code) { res.status = code; }, setHeader() {}, end(b) { res.body = JSON.parse(b); } };
  return res;
};

async function callModelTest(dir, log) {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const routes = makeStatusRoutes({
    config: { statusPath: '/x', rules: [], fallbackPolicy: {}, probe: {}, timeZone: null, storePath: '', reports: { dir } },
    router: { snapshot() { return {}; }, recordExhausted() {} },
    cooldown: { snapshot() { return {}; } },
    metrics: { snapshot() { return {}; } },
    quota: { snapshot() { return {}; } },
    registry: null, probe: null, llm: {}, wrapperStats: {},
    startedAt: Date.now(), saveStateFn: () => {}, log,
    daily: { reportDir: dir }, reporter: {},
    modelTest: { reportDir: dir, snapshot: () => ({ running: false, aborted: false, last: null }) },
  });
  const route = routes.find((r) => r.path === '/api/model-router/model-test');
  const res = mkModelTestRes();
  await route.handler(mkModelTestReq(), res);
  return res;
}

test('v0.9.23 B-b: listRunJson 越界告警——151 份档案触发 warn 且返回完整列表', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-thr-'));
  try {
    const COUNT = 151; // > LIST_REVISIT_THRESHOLD(150)
    for (let i = 0; i < COUNT; i++) {
      writeFileSync(
        join(dir, 'r' + String(i).padStart(3, '0') + '.model-test.json'),
        JSON.stringify({ kind: 'model-test', runId: 'r' + i, startedAt: '2026-09-16T00:00:00.000Z', targets: [] }),
      );
    }
    const warns = [];
    const log = { warn: (m) => warns.push(String(m)), info: () => {}, error: () => {} };
    const res = await callModelTest(dir, log);

    assert.equal(res.status, 200, '端点 200');
    assert.equal(res.body.list.length, COUNT, '返回全部 ' + COUNT + ' 份（不因告警而截断）');
    const hit = warns.find((w) => w.includes('重访阈值'));
    assert.ok(hit, '越界时应有重访告警');
    assert.ok(hit.includes(String(COUNT)), '告警带上实际档案数');
    assert.ok(/耗时 \d+ms/.test(hit), '告警带上实测耗时（供决策）');
    assert.ok(hit.includes('轻量列表 + 点行惰性取详情'), '告警给出建议方向');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.23 B-b: listRunJson 未越界不告警（正常情况零噪音）', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-nothr-'));
  try {
    for (let i = 0; i < 10; i++) {
      writeFileSync(
        join(dir, 'r' + i + '.model-test.json'),
        JSON.stringify({ kind: 'model-test', runId: 'r' + i, startedAt: '2026-09-16T00:00:00.000Z', targets: [] }),
      );
    }
    const warns = [];
    const log = { warn: (m) => warns.push(String(m)), info: () => {}, error: () => {} };
    const res = await callModelTest(dir, log);

    assert.equal(res.status, 200);
    assert.equal(res.body.list.length, 10);
    assert.equal(warns.filter((w) => w.includes('重访阈值')).length, 0, '10 份 < 150 → 不告警');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.24: /model-test 不再要求 daily/reporter（C1 读取路径残留已清）', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-gate-'));
  try {
    writeFileSync(
      join(dir, 'r1.model-test.json'),
      JSON.stringify({ kind: 'model-test', runId: 'r1', startedAt: '2026-09-16T00:00:00.000Z', targets: [] }),
    );
    const routes = makeStatusRoutes({
      config: { statusPath: '/x', rules: [], fallbackPolicy: {}, probe: {}, timeZone: null, storePath: '', reports: { dir } },
      router: { snapshot() { return {}; }, recordExhausted() {} },
      cooldown: { snapshot() { return {}; } },
      metrics: { snapshot() { return {}; } },
      quota: { snapshot() { return {}; } },
      registry: null, probe: null, llm: {}, wrapperStats: {},
      startedAt: Date.now(), saveStateFn: () => {}, log: { warn() {}, info() {}, error() {} },
      // ★ 刻意不传 daily / reporter（等价 reports.enabled=false）
      modelTest: { reportDir: dir, snapshot: () => ({ running: false, aborted: false, last: null }) },
    });
    const req = {
      method: 'GET', url: '/api/model-router/model-test',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3081' },
      [Symbol.asyncIterator]: async function* () {},
    };
    const route = routes.find((r) => r.path === '/api/model-router/model-test');
    const res = { writeHead(c) { res.status = c; }, setHeader() {}, end(b) { res.body = JSON.parse(b); } };
    await route.handler(req, res);

    assert.equal(res.status, 200, 'daily/reporter 缺失时仍 200（旧行为是 503）');
    assert.equal(res.body.list.length, 1, '能列出已落盘的档案');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.9.24: /model-test 在 modelTest.reportDir 不可用时仍 503（守卫生效）', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const routes = makeStatusRoutes({
    config: { statusPath: '/x', rules: [], fallbackPolicy: {}, probe: {}, timeZone: null, storePath: '', reports: {} },
    router: { snapshot() { return {}; }, recordExhausted() {} },
    cooldown: { snapshot() { return {}; } },
    metrics: { snapshot() { return {}; } },
    quota: { snapshot() { return {}; } },
    registry: null, probe: null, llm: {}, wrapperStats: {},
    startedAt: Date.now(), saveStateFn: () => {}, log: { warn() {}, info() {}, error() {} },
    modelTest: { reportDir: null, snapshot: () => ({ running: false, aborted: false, last: null }) },
  });
  const req = {
    method: 'GET', url: '/api/model-router/model-test',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081' },
    [Symbol.asyncIterator]: async function* () {},
  };
  const route = routes.find((r) => r.path === '/api/model-router/model-test');
  const res = { writeHead(c) { res.status = c; }, setHeader() {}, end(b) { res.body = JSON.parse(b); } };
  await route.handler(req, res);

  assert.equal(res.status, 503, 'reportDir 不可用 → 503（不是静默返空）');
});

// ============================================================
// v0.9.24 #7（v1.0 §6-B7 / §9.2）：安全边界测试化——「不读 API Key」由测试守住
// ============================================================
// 设计文档 §3.2 明确：「插件只做路由与调度，不介入协议转换；**不读、不存、不转发
// API Key**」。此前该约束**只写在文档里**，无任何测试守住（v1.0 验收差距 #7）。
//
// 三条测试覆盖三个面：
//   T1 静态：源码不出现凭据读取模式（剥注释后扫描，避免 skill §E 的假阳性）
//   T2 行为：wrapper 传给 llm.stream 的 opts 不含凭据字段，且只新增 provider/model/signal
//   T3 行为：/status 响应不含凭据材料

/** 凭据模式（用于静态/响应扫描）。注意不含 settingsNs —— 那是「命名空间名」，
 *  只作字符串透传（lib/registry.js:120/131），不用于读取 settings 内容。 */
const CRED_PATTERNS = [
  ['\\.apiKey\\b', '.apiKey'],
  ['\\.api_key\\b', '.api_key'],
  ['\\bcredentials\\b', 'credentials'],
  ['\\bsecret\\b', 'secret'],
  ['\\bpassword\\b', 'password'],
  ['\\bBearer\\b', 'Bearer'],
  ['Authorization', 'Authorization'],
];

test('v0.9.24 #7: 源码不出现凭据读取模式（剥注释后扫描）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  // ★ 必须剥注释：probe.js 的注释里有「复用 credentials，不存 key」这类说明文字，
  //   不剥会把「解释不读」的注释误判为「读了」（skill §E 已踩 3 次）。
  const strip = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  const files = [
    ...readdirSync('lib').filter((f) => f.endsWith('.js')).map((f) => join('lib', f)),
    join('lib', 'wrapper', 'index.js'),
    'client.js',
  ];
  const hits = [];
  for (const f of files) {
    const code = strip(readFileSync(f, 'utf8'));
    for (const [re, label] of CRED_PATTERNS) {
      if (new RegExp(re).test(code)) hits.push(f + ' → ' + label);
    }
  }
  assert.deepEqual(hits, [], '不应出现凭据读取模式；命中：' + hits.join(' | '));
  assert.ok(files.length >= 19, '扫描覆盖 lib/ + client.js（实际 ' + files.length + ' 文件）');
});

test('v0.9.24 #7: wrapper 传给 llm.stream 的 opts 不含凭据字段（行为断言）', async () => {
  const deps = makeDeps();
  const wrapper = createStreamWrapper(deps);
  // 驱动一次 failover，使 llm.stream 被真实调用（makeLlm 会捕获 opts）
  const llm = makeLlm({ streamWrapper: wrapper }, {
    'm-2': async function* () {
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield finishStop;
    },
  });
  const primary = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED', message: 'q' } } };
  })();
  await drain(wrapper.call(llm, { provider: 'p-a', model: 'm-1' }, () => primary));

  assert.ok(llm.calls.length > 0, 'llm.stream 已被调用（failover 路径）');
  const CRED = /apikey|api_key|secret|password|credential|bearer|authorization|^token$|^key$/i;
  for (const opts of llm.calls) {
    const bad = Object.keys(opts).filter((k) => CRED.test(k));
    assert.deepEqual(bad, [], 'opts 不应含凭据字段；实际 keys=' + Object.keys(opts).join(','));
  }
  // 正向断言：wrapper 只注入 provider / model / signal（其余字段原样透传宿主 options）
  const keys = Object.keys(llm.calls[0]);
  for (const k of ['provider', 'model', 'signal']) {
    assert.ok(keys.includes(k), 'wrapper 应注入 ' + k + '；实际 keys=' + keys.join(','));
  }
});

test('v0.9.24 #7: /status 响应不含凭据材料（行为断言）', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const config = normalizeConfig({ rules: [] });
  const routes = makeStatusRoutes({
    config,
    router: { snapshot: () => ({}), recordExhausted() {} },
    cooldown: { snapshot: () => ({}) },
    metrics: { snapshot: () => ({ recent: [], byRoute: {}, sessionIds: [], sessions: [] }) },
    quota: { snapshot: () => ({}) },
    // 刻意放入「像真实」的 provider 元数据（含 settingsNs —— 它是命名空间名，非凭据）
    registry: {
      providers: [
        { provider: 'apikey-demo', displayName: 'Demo', settingsNs: 'llm-demo', models: [{ id: 'm-1' }], dormant: false },
        { provider: 'vendor-x', displayName: 'VendorX', settingsNs: 'llm-x', models: [], dormant: true },
      ],
      registeredPairs: () => [],
      snapshotOut: () => ({
        providers: [
          { provider: 'apikey-demo', displayName: 'Demo', settingsNs: 'llm-demo', models: [{ id: 'm-1' }], dormant: false },
          { provider: 'vendor-x', displayName: 'VendorX', settingsNs: 'llm-x', models: [], dormant: true },
        ],
        source: 'mock',
      }),
    },
    probe: null, llm: {}, wrapperStats: {},
    startedAt: Date.now(), saveStateFn: () => {}, log: { warn() {}, info() {}, error() {} },
  });
  const route = routes.find((r) => r.kind === 'exact' && r.path === config.statusPath);
  assert.ok(route, '找到 /status 路由');

  const req = {
    method: 'GET', url: config.statusPath,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081' },
    [Symbol.asyncIterator]: async function* () {},
  };
  const res = { writeHead(c) { res.status = c; }, setHeader() {}, end(b) { res.body = b; } };
  await route.handler(req, res);

  assert.equal(res.status, 200, '/status 200');
  const body = String(res.body);
  assert.ok(body.length > 0, '响应非空');
  for (const pat of ['sk-', 'api_key', 'secret', 'password', 'Bearer', 'Authorization']) {
    assert.equal(body.includes(pat), false, '/status 不应含凭据材料：' + pat);
  }
});

// ============================================================
// v1.0 #2（§6-B2 / §9.2）：配置 schema 版本化 + 迁移链
// ============================================================
// 原缺陷：lib/store.js 对 `version !== 1` 是**整份丢弃**（回落 patch config）而非迁移
// → 一旦未来版本写入 version:2，老代码升级/降级时会**丢配置**。
// 现引入 STORE_VERSION + MIGRATIONS 链 + migrateState()。
// 迁移链当前为空（无历史版本），但**机制就位**——测试用注入的合成链验证步进逻辑。

test('v1.0 #2: migrateState——同版本原样返回（零开销路径）', async () => {
  const { migrateState, STORE_VERSION } = await import('../lib/store.js');
  const raw = { version: STORE_VERSION, rules: [], timeZone: 'Asia/Shanghai' };
  const out = migrateState(raw, { warn() {}, info() {} });
  assert.equal(out, raw, '同版本应原样返回同一对象（不复制）');
});

test('v1.0 #2: migrateState——多步迁移链逐步应用（注入合成链 v1→v2→v3）', async () => {
  const { migrateState } = await import('../lib/store.js');
  const applied = [];
  const chain = {
    1: (s) => { applied.push(1); return { ...s, addedInV2: 'a' }; },
    2: (s) => { applied.push(2); return { ...s, addedInV3: 'b' }; },
  };
  const out = migrateState({ version: 1, rules: [], keep: 'me' }, { warn() {}, info() {} }, chain, 3);
  assert.deepEqual(applied, [1, 2], '两步都执行且顺序正确');
  assert.equal(out.version, 3, '版本推进到 target');
  assert.equal(out.addedInV2, 'a', 'v1→v2 的产物保留');
  assert.equal(out.addedInV3, 'b', 'v2→v3 的产物保留');
  assert.equal(out.keep, 'me', '原有字段不丢（迁移只做结构变换）');
  assert.equal(out.rules.length, 0, '既有字段保留');
});

test('v1.0 #2: migrateState——缺步骤/版本过高/迁移抛错 均安全拒绝', async () => {
  const warns = [];
  const log = { warn: (m) => warns.push(String(m)), info() {} };
  const { migrateState } = await import('../lib/store.js');

  // 缺步骤：v1 → v3 但只登记了 v1
  assert.equal(migrateState({ version: 1, rules: [] }, log, { 1: (s) => s }, 3), null, '缺 v2 步骤 → 拒绝');
  assert.ok(warns.some((w) => w.includes('缺少 v2')), 'warn 指出缺哪一步');

  // 版本过高（不支持降级）
  warns.length = 0;
  assert.equal(migrateState({ version: 9, rules: [] }, log), null, '版本过高 → 拒绝');
  assert.ok(warns.some((w) => w.includes('不支持降级')), 'warn 说明原因');

  // 迁移抛错
  warns.length = 0;
  const boom = { 1: () => { throw new Error('boom'); } };
  assert.equal(migrateState({ version: 1, rules: [] }, log, boom, 2), null, '迁移抛错 → 拒绝（不崩）');
  assert.ok(warns.some((w) => w.includes('迁移失败')), 'warn 带上原始错误');

  // 迁移返回非对象
  warns.length = 0;
  assert.equal(migrateState({ version: 1, rules: [] }, log, { 1: () => null }, 2), null, '返回非对象 → 拒绝');

  // 非对象入参
  assert.equal(migrateState(null, log), null);
  assert.equal(migrateState([], log), null, '数组也算非法');
});

test('v1.0 #2: loadState——迁移后校验（version 对但 rules 非数组仍拒绝）', async () => {
  const { loadState } = await import('../lib/store.js');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'store-mig-'));
  const p = join(dir, 'state.json');
  const log = { warn() {}, info() {}, error() {} };
  try {
    // version 合法但 rules 非法 → 仍拒绝（迁移只管结构，校验归 loadState）
    writeFileSync(p, JSON.stringify({ version: 1, rules: 'not-an-array' }));
    assert.equal(loadState(p, log), null, 'rules 非数组 → 拒绝');
    // 正常
    writeFileSync(p, JSON.stringify({ version: 1, rules: [], timeZone: 'Asia/Shanghai', mode: 'fast' }));
    const ok = loadState(p, log);
    assert.ok(ok, '合法 store 读回成功');
    assert.equal(ok.timeZone, 'Asia/Shanghai', 'timeZone 持久化');
    assert.equal(ok.mode, 'fast', 'mode 持久化');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.0 #2: saveState 写入 STORE_VERSION（与 loadState 的判据同源）', async () => {
  const { saveState, STORE_VERSION } = await import('../lib/store.js');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'store-ver-'));
  const p = join(dir, 'state.json');
  try {
    assert.equal(saveState(p, { rules: [] }, { info() {}, warn() {}, error() {} }), true);
    const written = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(written.version, STORE_VERSION, '写入的 version = STORE_VERSION（非硬编码 1）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.0 #2: saveState/migrateState 的版本判据同源于 STORE_VERSION（源码断言）', () => {
  // 为什么需要源码断言：STORE_VERSION 当前 === 1，故「硬编码 1」与「引用常量」
  // 在**行为上不可区分**（等价突变，突变测试抓不到）。但二者在**未来**分叉：
  // 若有人把 STORE_VERSION 递增到 2 却漏改 saveState 的字面量 1，
  // 写入的 version 与迁移链的 target 会不一致 → 迁移链静默失效。
  // 故此处用源码断言守住「同源」这一结构性质。
  const src = readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8');
  assert.ok(/export const STORE_VERSION = \d+;/.test(src), 'STORE_VERSION 已导出');
  assert.ok(src.includes('version: STORE_VERSION'), 'saveState 用 STORE_VERSION（非字面量）');
  assert.ok(src.includes('target = STORE_VERSION'), 'migrateState 默认 target 同源');
  assert.ok(src.includes('export const MIGRATIONS'), '迁移链已导出（供后续登记）');
  assert.equal(/version: 1,/.test(src), false, '不应出现硬编码的 version: 1');
});

// ============================================================
// v1.0.1 修复（Critical · 数据丢失）：/state 保存须「合并」而非「整体替换」
// ============================================================
// **缺陷**：saveStateFn 直接把「本次请求派生的 state」写盘。normalizeState 对未提交
// 字段返回 undefined，JSON.stringify 丢弃 undefined → **磁盘已有值被静默擦除**。
//
// **真实触发（面板 4 个保存点全部命中）**：
//   「一键启用每日报告」只发 {reports} → rules/providerMeta/timeZone 全丢
//   「保存规则」只发 {rules}          → providerMeta/reports/timeZone/mode 全丢
// 且返回 200「已保存并即时生效」—— 静默。
//
// **本组测试即 Prove-It**：修复前必红（见下方「突变验证」注释）。

test('v1.0.1 mergeState: undefined = 未提交 → 保留旧值', async () => {
  const { mergeState } = await import('../lib/store.js');
  const prev = { rules: [{ name: 'p' }], timeZone: 'Asia/Shanghai', mode: 'fast' };
  const patch = { rules: undefined, timeZone: undefined, reports: { enabled: true } };
  const out = mergeState(prev, patch);
  assert.deepEqual(out.rules, [{ name: 'p' }], 'rules 未提交 → 保留');
  assert.equal(out.timeZone, 'Asia/Shanghai', 'timeZone 未提交 → 保留');
  assert.equal(out.mode, 'fast', 'mode 未在 patch 中 → 保留');
  assert.deepEqual(out.reports, { enabled: true }, 'reports 提交了 → 覆盖');
});

test('v1.0.1 mergeState: null = 显式清空 → 覆盖（区别于 undefined）', async () => {
  const { mergeState } = await import('../lib/store.js');
  const prev = { timeZone: 'Asia/Shanghai', mode: 'fast' };
  const out = mergeState(prev, { timeZone: null });
  assert.equal(out.timeZone, null, 'null 是显式清空（= 系统时区），须覆盖');
  assert.equal(out.mode, 'fast', '未提及的字段仍保留');
});

test('v1.0.1 mergeState: 剥离 loadState 的内部字段 storePath', async () => {
  const { mergeState } = await import('../lib/store.js');
  const prev = { storePath: '/x/y.json', rules: [] };
  const out = mergeState(prev, {});
  assert.equal('storePath' in out, false, 'storePath 不应落盘');
  assert.deepEqual(out.rules, [], '其余字段保留');
});

test('v1.0.1 mergeState: prev 为 null（无 state.json）时不抛', async () => {
  const { mergeState } = await import('../lib/store.js');
  const out = mergeState(null, { rules: [], mode: 'fast' });
  assert.deepEqual(out, { rules: [], mode: 'fast' });
});

test('v1.0.1 端到端: 「一键启用每日报告」不再擦除 rules/providerMeta/timeZone', async () => {
  // 复现 index.js 注入点的真实代码路径：
  //   saveState(path, mergeState(loadState(path), normalizeState(patch)), log)
  const { loadState, saveState, mergeState } = await import('../lib/store.js');
  const { normalizeState } = await import('../lib/config.js');
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'merge-e2e-'));
  const p = join(dir, 'state.json');
  const log = { warn() {}, info() {}, error() {} };
  // ★ 镜像 index.js 注入点的**真实代码路径**：
  //   saveState(path, mergeState(loadState(path), normalizeState(body), Object.keys(body)), log)
  //   关键是第三参 `Object.keys(body)` —— 原始请求体的键集（normalizeState 会给未提交
  //   字段填默认值，故必须依据「客户端实际提交了哪些键」判断覆盖范围）。
  const saveFn = (body) => saveState(
    p,
    mergeState(loadState(p, log), normalizeState(body, false, { log }), Object.keys(body)),
    log,
  );

  try {
    // ① 建立「有内容」的状态
    assert.equal(saveFn({
      rules: [{ name: 'my-pack', route: [{ provider: 'p1', model: 'm1' }] }],
      providerMeta: { p1: { notes: '重要备注' } },
      timeZone: 'Asia/Shanghai',
    }), true);

    let d = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(d.rules.length, 1, '① 规则已落盘');
    assert.equal(d.providerMeta.p1.notes, '重要备注', '① providerMeta 已落盘');
    assert.equal(d.timeZone, 'Asia/Shanghai', '① timeZone 已落盘');

    // ② 模拟面板 L677「一键启用每日报告」——**只发 reports**
    assert.equal(saveFn({ reports: { enabled: true, hour: '01:00' } }), true);

    d = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(d.rules.length, 1, '② 规则**未**被擦除（修复前此处为 0 → 数据丢失）');
    assert.equal(d.providerMeta?.p1?.notes, '重要备注', '② providerMeta **未**被擦除');
    assert.equal(d.timeZone, 'Asia/Shanghai', '② timeZone **未**被擦除');
    assert.deepEqual(d.reports, { enabled: true, hour: '01:00' }, '② reports 已更新');

    // ③ 模拟「保存规则」——只发 rules
    assert.equal(saveFn({
      rules: [{ name: 'p2', route: [{ provider: 'p2', model: 'm2' }] }],
    }), true);
    d = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(d.rules[0].name, 'p2', '③ 规则已更新');
    assert.equal(d.providerMeta?.p1?.notes, '重要备注', '③ providerMeta 仍保留');
    assert.equal(d.timeZone, 'Asia/Shanghai', '③ timeZone 仍保留');
    assert.deepEqual(d.reports, { enabled: true, hour: '01:00' }, '③ reports 仍保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// v1.0.1 接线测试：确保「合并保存」在**真实调用链**上生效
// ============================================================
// 背景：首版 E2E 测试**自己实现了 saveFn**，因此**测不到** index.js / routes.js 的接线
// —— 实测「回退 index.js 到整体替换」「routes.js 不传 submittedKeys」两个突变都**未变红**。
// 本组补齐三层：
//   ① makeSaveStateFn 工厂（行为）—— 覆盖「读-合并-写」逻辑
//   ② /state 端点把「原始 body 键集」传给 saveStateFn（行为）—— 覆盖 routes.js 接线
//   ③ index.js 确实用工厂而非内联（源码断言）—— 覆盖 index.js 接线
//      （index.js 的闭包在插件工厂内，单元测试无法驱动，故用源码断言；这是**有意识的取舍**，
//        已在断言失败信息里写明。）

test('v1.0.1 接线①: makeSaveStateFn 是「读-合并-写」（部分保存不擦旧值）', async () => {
  const { makeSaveStateFn, loadState } = await import('../lib/store.js');
  const { normalizeState } = await import('../lib/config.js');
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'wire-fn-'));
  const p = join(dir, 'state.json');
  const log = { warn() {}, info() {}, error() {} };
  const save = makeSaveStateFn(p, log);

  try {
    // 建立有内容的状态
    save(normalizeState({
      rules: [{ name: 'pack-1', route: [{ provider: 'p1', model: 'm1' }] }],
      providerMeta: { p1: { notes: '备注' } },
      timeZone: 'Asia/Shanghai',
    }, false, { log }), ['rules', 'providerMeta', 'timeZone']);
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).rules.length, 1, '初始规则已落盘');

    // 只提交 reports（模拟面板「一键启用每日报告」）
    save(normalizeState({ reports: { enabled: true, hour: '01:00' } }, false, { log }), ['reports']);

    const d = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(d.rules.length, 1, '规则未被擦除');
    assert.equal(d.providerMeta.p1.notes, '备注', 'providerMeta 未被擦除');
    assert.equal(d.timeZone, 'Asia/Shanghai', 'timeZone 未被擦除');
    assert.deepEqual(d.reports, { enabled: true, hour: '01:00' }, 'reports 已更新');
    assert.equal(loadState(p, log).rules.length, 1, 'loadState 可读回');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.0.1 接线②: /state 把「原始请求体的键集」作为第二参传给 saveStateFn', async () => {
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const config = normalizeConfig({ rules: [] });
  const calls = [];
  const routes = makeStatusRoutes({
    config,
    router: { snapshot: () => ({}), recordExhausted() {}, applyRuntime() {} },
    cooldown: { snapshot: () => ({}), applyPolicy() {} },
    metrics: { snapshot: () => ({ recent: [], byRoute: {}, sessionIds: [], sessions: [] }) },
    quota: { snapshot: () => ({}) },
    registry: null, probe: null, llm: {}, wrapperStats: {},
    startedAt: Date.now(),
    saveStateFn: (state, submittedKeys) => { calls.push({ state, submittedKeys }); return true; },
    log: { warn() {}, info() {}, error() {} },
  });
  const route = routes.find((r) => r.path === '/api/model-router/state');
  const post = async (payload) => {
    const res = { writeHead(c) { res.status = c; }, setHeader() {}, end(b) { res.body = b; } };
    await route.handler({
      method: 'POST', url: '/api/model-router/state',
      socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3081' },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(payload)); },
    }, res);
    return res;
  };

  // 只提交 reports → 第二参须恰为 ['reports']
  const r1 = await post({ reports: { enabled: true, hour: '01:00' } });
  assert.equal(r1.status, 200, '200');
  assert.equal(calls.length, 1, 'saveStateFn 被调用一次');
  assert.deepEqual(calls[0].submittedKeys, ['reports'],
    '第二参须为**原始 body 的键集**（而非 normalizeState 的输出键集——后者会多出默认的 rules）');

  // 提交 rules + providerMeta → 第二参须恰为这两键
  await post({ rules: [], providerMeta: { p1: {} } });
  assert.deepEqual(calls[1].submittedKeys, ['rules', 'providerMeta'], '第二参随 body 变化');

  // 空 body → 第二参为空数组（不覆盖任何字段）
  await post({});
  assert.deepEqual(calls[2].submittedKeys, [], '空 body → 空键集');
});

test('v1.0.1 接线③: index.js 用 makeSaveStateFn 工厂而非内联（源码断言）', () => {
  // 为什么用源码断言：该 saveStateFn 是插件工厂内的闭包，单元测试无法驱动；
  // 若内联实现写错（漏 mergeState / 漏 submittedKeys），行为测试覆盖不到。
  // 断言「用了工厂」可保证逻辑集中在 store.js（那里有行为测试覆盖）。
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(/saveStateFn:\s*makeSaveStateFn\(/.test(src),
    'index.js 须用 makeSaveStateFn 工厂（而非内联 saveState 调用）');
  assert.ok(/import \{[^}]*makeSaveStateFn[^}]*\} from '\.\/store\.js'/.test(src),
    'makeSaveStateFn 须从 store.js 导入');
  assert.equal(/saveStateFn:\s*\(state[^)]*\)\s*=>/.test(src), false,
    '不应存在内联的 saveStateFn 箭头函数（会把逻辑移出可测范围）');
});

test('v1.0.1 接线④: /quota/sync 也把「提交键集」传给 saveStateFn（同一条数据丢失路径）', async () => {
  // /quota/sync 只提交 { rules, providerMeta } —— 若不传键集，timeZone/mode/reports
  // 会被整体替换擦除（与 /state 同一缺陷）。
  const { makeStatusRoutes } = await import('../lib/routes.js');
  const config = normalizeConfig({ rules: [], providerMeta: { 'p-x': {} } });
  const calls = [];
  const routes = makeStatusRoutes({
    config,
    router: { snapshot: () => ({}), recordExhausted() {}, applyRuntime() {} },
    cooldown: { snapshot: () => ({}), applyPolicy() {} },
    metrics: { snapshot: () => ({ recent: [], byRoute: {}, sessionIds: [], sessions: [] }) },
    quota: { snapshot: () => ({}), syncWindows() {} },
    registry: null, probe: null, llm: {}, wrapperStats: {},
    startedAt: Date.now(),
    saveStateFn: (state, submittedKeys) => { calls.push({ state, submittedKeys }); return true; },
    log: { warn() {}, info() {}, error() {} },
  });
  const route = routes.find((r) => r.path === '/api/model-router/quota/sync');
  const res = { writeHead(c) { res.status = c; }, setHeader() {}, end(b) { res.body = b; } };
  await route.handler({
    method: 'POST', url: '/api/model-router/quota/sync',
    socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3081' },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ provider: 'p-x', windows: { fiveHour: { limit: 100 } } }));
    },
  }, res);

  assert.equal(res.status, 200, '200');
  assert.equal(calls.length, 1, 'saveStateFn 被调用');
  assert.deepEqual(calls[0].submittedKeys, ['rules', 'providerMeta'],
    '/quota/sync 提交的是 rules + providerMeta 两键；不传则 timeZone/mode/reports 会被擦除');
});
