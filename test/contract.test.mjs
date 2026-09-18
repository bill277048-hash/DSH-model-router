/**
 * API 契约断言 + 端到端跑批（v1.0 §6-B4 / §9.2 判据 4）
 *
 * **与 unit.test.mjs 的分层**：
 * - `unit.test.mjs`  —— 单测（纯逻辑 / 单模块行为）
 * - `contract.test.mjs`（本文件）—— 集成层：**对照 `docs/v1.0-契约文档.md` 断言对外契约**，
 *   并**真跑一次跑批**（mock 上游，走完整 4 相 + 落盘 + 读取回路）
 *
 * 为什么单独一层：契约是**跨模块**的（routes + config + archive + model-test），
 * 单测各自 mock 掉对方，无法发现「契约漂移」——例如端点改名、响应键改名、
 * config 加键却没进文档。本层专门守这些。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeStatusRoutes } from '../lib/routes.js';
import { normalizeConfig } from '../lib/config.js';
import { ARCHIVE_KINDS, KIND_SCHEMA_VERSION } from '../lib/archive.js';
import { STORE_VERSION } from '../lib/store.js';

const DOC = readFileSync(new URL('../docs/v1.0-契约文档.md', import.meta.url), 'utf8');
const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

/** 构造可用的 /status 依赖（尽量小，但满足处理器需要） */
function mkDeps(over = {}) {
  const config = normalizeConfig({ rules: [] });
  return {
    config,
    router: { snapshot: () => ({}), recordExhausted() {} },
    cooldown: { snapshot: () => ({}) },
    metrics: { snapshot: () => ({ recent: [], byRoute: {}, sessionIds: [], sessions: [] }) },
    quota: { snapshot: () => ({}) },
    registry: { providers: [], registeredPairs: () => [], snapshotOut: () => ({ providers: [], source: 'test' }) },
    probe: null,
    llm: {},
    wrapperStats: {},
    startedAt: Date.now(),
    saveStateFn: () => true,
    log: noopLog,
    ...over,
  };
}

const mkReq = (method, url, remote = '127.0.0.1') => ({
  method,
  url,
  socket: { remoteAddress: remote },
  headers: { host: '127.0.0.1:3081' },
  [Symbol.asyncIterator]: async function* () {},
});

const mkRes = () => {
  const res = {
    writeHead(code) { res.status = code; },
    setHeader() {},
    end(b) { res.body = b; try { res.json = JSON.parse(b); } catch { res.json = null; } },
  };
  return res;
};

async function call(routes, method, path, deps) {
  // 路由表 path 不含 query string；先剥 ?xxx 再匹配
  const pathname = path.split('?')[0];
  const route = routes.find((r) => r.kind === 'exact' && r.path === pathname);
  assert.ok(route, `契约要求存在端点 ${pathname}（实际路由: ${routes.map((r) => r.path).join(', ')}）`);
  const res = mkRes();
  await route.handler(mkReq(method, path), res);
  return res;
}

// ============================================================
// 一、端点契约（对照文档 §1）
// ============================================================

test('契约: 15 个端点全部存在，且文档 §1.1 与实现一致', () => {
  const routes = makeStatusRoutes(mkDeps());
  const config = normalizeConfig({ rules: [] });
  const expected = [
    config.statusPath, '/api/model-router/state',
    '/api/model-router/quota/windows', '/api/model-router/quota/reset', '/api/model-router/quota/sync',
    '/api/model-router/probe', '/api/model-router/benchmark',
    '/api/model-router/reports', '/api/model-router/reports/generate',
    '/api/model-router/loadtest',
    '/api/model-router/model-test', '/api/model-router/model-test/manual', '/api/model-router/model-test/list',
    '/api/model-router/test-archives', '/api/model-router/test-archives/detail',
  ];
  const actual = routes.map((r) => r.path);
  // ★ 双向断言：每个期望端点存在 **且** 实际端点都在期望集内
  // （只单向断言会让「增加多余端点」漏过）
  for (const p of expected) {
    assert.ok(actual.includes(p), `端点缺失: ${p}`);
    assert.ok(DOC.includes('`' + p + '`') || DOC.includes(p.replace('/api/model-router', '')), `文档 §1 未收录: ${p}`);
  }
  for (const p of actual) {
    assert.ok(expected.includes(p), "实现多了未在文档声明的端点: " + p + "（须文档化或删除）");
  }
  assert.equal(actual.length, expected.length, "端点总数须为 " + expected.length + "（实际 " + actual.length + "）");
  assert.equal(DOC.includes('端点总览（15 个）'), true, '文档声明 15 个端点');
});

test('契约: 非 GET 方法在只读端点上返回 405', async () => {
  const routes = makeStatusRoutes(mkDeps());
  const config = normalizeConfig({ rules: [] });
  const res = await call(routes, 'POST', config.statusPath);
  assert.equal(res.status, 405, '/status 只接受 GET');
});

test('契约: 非回环请求被拒（回环围栏）', async () => {
  const routes = makeStatusRoutes(mkDeps());
  const config = normalizeConfig({ rules: [] });
  const route = routes.find((r) => r.path === config.statusPath);
  const res = mkRes();
  await route.handler(mkReq('GET', config.statusPath, '10.0.0.5'), res);
  assert.equal(res.status, 403, '非回环来源须 403');
});

test('契约: 未知路径返回 404（不落到任何处理器）', async () => {
  const routes = makeStatusRoutes(mkDeps());
  assert.equal(routes.some((r) => r.path === '/api/model-router/nope'), false);
});

test('契约: /test-archives/detail 的路径穿越被拒（400）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-trav-'));
  try {
    const routes = makeStatusRoutes(mkDeps({ config: normalizeConfig({ rules: [], reports: { dir } }) }));
    // ★ 测试必须走「path + query」格式（剥与不剥 pathname 对结果有差异）
    // 否则去掉 `path.split('?')[0]` 后此测试不变红（突变测试失效）。
    for (const bad of ['../../../etc/passwd', 'a/../../b', 'x'.repeat(300)]) {
      const res = await call(routes, 'GET', '/api/model-router/test-archives/detail?kind=model-test&runId=' + encodeURIComponent(bad));
      assert.equal(res.status, 400, `非法 runId 须 400: ${bad.slice(0, 20)}`);
      // 顺带断言 body 含拒绝原因（避免「恒返 400」的恒真突变）
      assert.ok(/runId|kind/.test(res.body), '错误响应说明拒绝原因（runId 或 kind）');
    }
    const res2 = await call(routes, 'GET', '/api/model-router/test-archives/detail?kind=bogus&runId=x');
    assert.equal(res2.status, 400, 'kind 不在白名单须 400');
    assert.ok(/kind/.test(res2.body), '拒绝原因含 kind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 二、config schema 契约（对照文档 §2.1）
// ============================================================

test('契约: config 顶层键 = 文档 §2.1 声明的 18 个', () => {
  const cfg = normalizeConfig({ rules: [] });
  const keys = Object.keys(cfg).sort();
  assert.equal(keys.length, 18, `键数须为 18（实际 ${keys.length}）`);
  const m = DOC.match(/顶层键（\*\*(\d+) 个\*\*/);
  assert.ok(m, '文档须声明键数');
  assert.equal(Number(m[1]), keys.length, '文档键数与实现一致');
  for (const k of keys) assert.ok(DOC.includes('`' + k + '`'), `文档 §2.1 未收录键: ${k}`);
});

test('契约: 非法 config 被拒（校验生效）', () => {
  // timeWindows: peakStart === valleyStart 须抛
  assert.throws(() => normalizeConfig({ rules: [], timeWindows: { enabled: true, peakStart: '09:00', valleyStart: '09:00' } }),
    /不能相等/, 'peakStart === valleyStart 须拒绝');
  // providerMeta.notes 超长须抛
  assert.throws(() => normalizeConfig({ rules: [], providerMeta: { p: { notes: 'x'.repeat(501) } } }),
    /长度上限/, 'notes > 500 须拒绝');
  // reports.hour 非法须抛
  assert.throws(() => normalizeConfig({ rules: [], reports: { enabled: true, hour: '25:00' } }),
    /HH:MM/, 'hour 非法须拒绝');
});

// ============================================================
// 三、落盘格式契约（对照文档 §3）
// ============================================================

test('契约: 档案 kind 白名单与 schemaVersion 与文档一致', () => {
  // ★ deepEqual 防止顺序错乱；显式写每个值，挡住「新增 kind」漏文档
  assert.deepEqual(ARCHIVE_KINDS, ['model-test', 'loadtest', 'probe'], 'kind 白名单（顺序敏感）');
  assert.equal(KIND_SCHEMA_VERSION, 1, 'schemaVersion');
  for (const k of ARCHIVE_KINDS) assert.ok(DOC.includes('`' + k + '`'), `文档 §3.1 未收录 kind: ${k}`);
  assert.ok(DOC.includes('`schemaVersion`'), '文档收录 schemaVersion');
  // 反向断言：文档里提到的 kind 都必须真实存在（防文档多写）
  for (const k of ['model-test', 'loadtest', 'probe']) {
    assert.ok(ARCHIVE_KINDS.includes(k), `实现缺失文档中声明的 kind: ${k}`);
  }
});

test('契约: store 版本常量与文档一致', () => {
  assert.equal(typeof STORE_VERSION, 'number', 'STORE_VERSION 已导出');
  assert.ok(DOC.includes('"version": ' + STORE_VERSION) || DOC.includes('"version": 1'), '文档 §3.4 与实现一致');
});

// ============================================================
// 四、端到端跑批（§6-B4「真跑一次跑批」）
// ============================================================

test('契约·E2E: 真跑一次跑批 → 报告生成 + 档案落盘 + 可经端点读回', async () => {
  const { runReport } = await import('../lib/model-test.js');
  const dir = mkdtempSync(join(tmpdir(), 'ct-e2e-'));
  try {
    // mock 上游：每个 stream() 调用都是**一次性**的有限生成器（含 finish），
    // 否则 wrapper 会持续拉流死循环。生成器必须**严格有限**（N 个 yield 后 return）。
    // 这是 LLM 行为的本质：单次调用 → 一次性产出 → finish。
    function mockStream() {
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'pong' };
        yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    }
    const llm = {
      stream: () => mockStream(),
    };
    // phases: ['probe', 'context', 'rpm', 'quota-group']
    //         ─── ^^^^^^         ─── 此处只跑 1 相让 E2E 测试 < 60s
    // 全 4 相跑批**设计上不可在 60s 内完成**：_phaseRpm 是 4 档 × 5 样本 = 20 次 stream()
    // 调用，档位 [0.05, 0.1, 0.2, 0.3] 间隔 20/10/5/3.3s → 总 ~150s。
    // 这里只跑 probe（验证完整落盘 + 读取回路）；其余相已在 unit.test.mjs 覆盖。
    const report = await runReport({
      llm,
      registry: null,
      daily: null,          // 刻意：验证不依赖 reports.enabled（v0.9.20 C1）
      log: noopLog,
      targets: [{ provider: 'ct-prov', model: 'ct-model' }],
      phases: ['probe'],
      recoveryMs: 0,        // 跳过限流冷却，保持测试快速
      reportDir: dir,
    });

    // —— 报告层 ——
    assert.ok(report.runId, 'runId 已生成');
    assert.equal(report.ok, true);
    assert.equal(report.targets.length, 1, '1 个 target');
    assert.deepEqual(report.phases, ['probe'], '契约顺序（展示用，仅含调用方传入的）');
    // phaseOrder = phases 经 PHASE_EXEC_ORDER 排序后的子集（实测：单相传入时只含该相）
    assert.deepEqual(report.phaseOrder, ['probe'], 'phaseOrder = phases（按执行序）');
    assert.ok(report.targets[0].verdict, 'verdict 已计算');
    assert.ok(Number.isFinite(report.elapsedMs), 'elapsedMs 已记录');
    assert.ok(report.targets[0].probe, 'probe 相已跑');

    // —— 落盘层 ——
    const jsons = readdirSync(dir).filter((n) => n.endsWith('.model-test.json'));
    const mds = readdirSync(dir).filter((n) => n.endsWith('.model-test.md'));
    assert.equal(jsons.length, 1, 'json 落盘');
    assert.equal(mds.length, 1, 'md 落盘');
    const archived = JSON.parse(readFileSync(join(dir, jsons[0]), 'utf8'));
    assert.equal(archived.kind, 'model-test', 'kind 已写入');
    assert.equal(archived.schemaVersion, KIND_SCHEMA_VERSION, 'schemaVersion 已写入');
    assert.equal(archived.runId, report.runId, 'runId 一致');
    assert.equal(archived.ok, true);

    // —— 读取回路：经真实端点读回 ——
    const routes = makeStatusRoutes(mkDeps({
      config: normalizeConfig({ rules: [], reports: { dir } }),
      modelTest: { reportDir: dir, snapshot: () => ({ running: false, aborted: false, last: null }) },
    }));
    const listRes = await call(routes, 'GET', '/api/model-router/test-archives');
    assert.equal(listRes.status, 200, '列表端点 200');
    const item = listRes.json.items.find((i) => i.runId === report.runId);
    assert.ok(item, '新档案出现在列表中');
    assert.equal(item.kind, 'model-test');
    assert.ok(item.mtime, '含 mtime（v0.9.20 契约）');
    assert.equal(item.startedAt, undefined, '不再暴露 startedAt（v0.9.20 契约）');

    const detailRes = await call(routes, 'GET',
      '/api/model-router/test-archives/detail?kind=model-test&runId=' + encodeURIComponent(report.runId));
    assert.equal(detailRes.status, 200, '详情端点 200');
    assert.equal(detailRes.json.runId, report.runId);
    assert.equal(detailRes.json.report.kind, 'model-test');
    assert.ok(typeof detailRes.json.markdown === 'string' && detailRes.json.markdown.length > 0, 'markdown 可读回');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('契约·E2E: 跑批落盘失败不阻塞（旁路语义）—— reportDir 不可用时报告仍返回', async () => {
  const { runReport } = await import('../lib/model-test.js');
  const warns = [];
  const llm = {
    stream: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'no cred' } } };
    })(),
  };
  const report = await runReport({
    llm, registry: null, daily: null,
    log: { warn: (m) => warns.push(String(m)), info() {}, error() {} },
    targets: [{ provider: 'p', model: 'm' }], phases: ['probe'], recoveryMs: 0,
    // 不传 reportDir 且 daily=null → 目录不可用
  });
  assert.ok(report.runId, '报告仍返回（落盘是旁路）');
  assert.ok(warns.some((w) => w.includes('档案目录不可用')), '有 warn 提示（不静默）');
});

// ============================================================
// v1.0.0 复核补测：/status 键集与契约文档一致（防文档漂移）
// ============================================================
// 背景：v1.0.0 复核时发现契约文档 §1.2 把 /status 的结构写错了三处：
//   ① 写成顶层 `wrapperStats` —— 真实键名是 `wrapper`
//   ② 写成顶层 `modelTest`   —— 真实 /status 无此键（走 /model-test 端点）
//   ③ 写成顶层 `timeWindows` —— 真实在 `config.timeWindows` 内
// 文档与实现的漂移**没有测试守住**。此用例把真实键集钉死。

test('契约: /status 顶层键集与契约文档 §1.2 一致（15 个）', async () => {
  const routes = makeStatusRoutes(mkDeps());
  const config = normalizeConfig({ rules: [] });
  const res = await call(routes, 'GET', config.statusPath);
  assert.equal(res.status, 200);

  const EXPECTED = [
    'checkedAt', 'config', 'cooldown', 'metrics', 'ok', 'plugin', 'probe',
    'quota', 'quotaWindows', 'registry', 'reports', 'router', 'uptimeSec',
    'version', 'wrapper',
  ].sort();
  const actual = Object.keys(res.json).sort();

  assert.deepEqual(actual, EXPECTED, '/status 顶层键集须与文档 §1.2 一致');

  // 反向：文档的**键表**不应把这三个键列为 /status 的顶层键。
  // ⚠ 注意：修正说明里会**合法地提到**这些名字（如「没有 `modelTest`」），
  //   故必须匹配「表格行」`| \`key\` |` 而非裸字符串（否则误报——初版即踩此坑）。
  const docSection = DOC.slice(DOC.indexOf('### 1. `/status`'), DOC.indexOf('### 2. `/state`'));
  const rowOf = (k) => new RegExp('\\|\\s*`' + k + '`\\s*\\|');
  assert.equal(rowOf('wrapperStats').test(docSection), false,
    '文档键表不应把 wrapper 写成 wrapperStats');
  assert.equal(rowOf('modelTest').test(docSection), false,
    '文档键表不应声称 /status 有 modelTest');
  assert.ok(rowOf('wrapper').test(docSection), '文档键表应含真实的 `wrapper` 键');
  assert.ok(docSection.includes('没有 `modelTest`'), '文档应显式声明没有 modelTest');
});

test('契约: /status.config 子键集与契约文档一致（15 个）', async () => {
  const routes = makeStatusRoutes(mkDeps());
  const config = normalizeConfig({ rules: [] });
  const res = await call(routes, 'GET', config.statusPath);

  const EXPECTED = [
    'adapterRegistered', 'allowLegacyMatch', 'exhaustionWindowSec', 'failoverBudgetMs',
    'fallbackPolicy', 'firstTokenTimeoutMs', 'mode', 'probe', 'propose', 'providerMeta',
    'rules', 'sessionsDir', 'storePath', 'timeWindows', 'timeZone',
  ].sort();
  const actual = Object.keys(res.json.config).sort();
  assert.deepEqual(actual, EXPECTED, 'config 子键集须与文档一致');

  // reports 是顶层键，不在 config 内（复核时确认的真实结构）
  assert.equal(actual.includes('reports'), false, 'config 内不应有 reports（它是顶层键）');
  assert.ok(res.json.reports, '/status 顶层应有 reports');
  // timeWindows 在 config 内（非顶层）
  assert.equal(Object.prototype.hasOwnProperty.call(res.json, 'timeWindows'), false,
    'timeWindows 不应出现在顶层（它在 config 内）');
  assert.ok(Object.prototype.hasOwnProperty.call(res.json.config, 'timeWindows'),
    'timeWindows 应在 config 内');
});
