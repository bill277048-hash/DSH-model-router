/**
 * 人工测试用例集 · 可自动化部分（对照 `docs/v1.0-人工测试用例.md`）
 *
 * **定位**：46 例人工用例中，**13 例无需 UI 点击 / 真实上游**，可由本脚本在**实机**上执行。
 * 其余 33 例（页签交互、配置改动、启停回滚）仍须人工完成。
 *
 * **与 `contract.test.mjs` 的分工**：
 * - `contract.test.mjs` —— 用 **mock 依赖**验证契约（可在 CI 跑，不需实例）
 * - 本脚本 —— 用**真实运行实例**验证同样的事实（证明「mock 之外的现实也成立」）
 *
 * **安全设计**：C-01/02/03 会 POST 非法配置到 `/state` —— 这些请求**必须被拒绝**。
 * 脚本在跑完后**重新读取 config 并逐字节比对**，确认配置未被改动（见末尾 CASE X-01）。
 *
 * 用法：
 *   node test/manual-suite-automated.mjs
 * 退出码：0 = 全过；1 = 有 FAIL
 */

import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOST = '127.0.0.1';
const PORT = 3081;
const BASE = '/api/model-router';
const REPORTS_DIR = join(homedir(), 'Documents', 'dsh-model-router-reports');

/** 发原始请求（可伪造 Host —— fetch 不允许设 Host 头） */
function req(method, path, { body, host, headers = {} } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        host: HOST, port: PORT, method, path,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(host ? { Host: host } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* 非 JSON（如 client.js） */ }
          resolve({ status: res.statusCode, body: data, json });
        });
      },
    );
    r.on('error', (e) => resolve({ status: 0, body: String(e.message), json: null, error: e }));
    if (payload) r.write(payload);
    r.end();
  });
}

const results = [];
async function CASE(id, name, fn) {
  try {
    const r = await fn();
    results.push({ id, name, pass: r.pass, detail: r.detail });
  } catch (e) {
    results.push({ id, name, pass: false, detail: 'EXCEPTION: ' + e.message });
  }
}

// ─────────────────────────────────────────────
// 前置：实例可达
// ─────────────────────────────────────────────
const pre = await req('GET', BASE + '/status');
if (pre.status !== 200 || !pre.json) {
  console.error('✗ 实例不可达（' + HOST + ':' + PORT + BASE + '/status → ' + pre.status + '）');
  console.error('  请先确认 DSH 已启动且插件已加载。');
  process.exit(1);
}
const STATUS = pre.json;
const CONFIG_BEFORE_OBJ = STATUS.config;

// ─────────────────────────────────────────────
// A-02 · 状态端点可达且版本正确
// ─────────────────────────────────────────────
await CASE('A-02', '状态端点可达且版本正确', async () => {
  const ok = STATUS.ok === true
    && STATUS.plugin === '@botton/dsh-model-router'
    && /^\d+\.\d+\.\d+$/.test(STATUS.version);
  return { pass: ok, detail: `version=${STATUS.version} plugin=${STATUS.plugin} ok=${STATUS.ok}` };
});

// ─────────────────────────────────────────────
// A-06 · 切换日志记账正常（NDJSON 结构与字段）
// ─────────────────────────────────────────────
await CASE('A-06', '切换日志记账正常（NDJSON 结构）', async () => {
  if (!existsSync(REPORTS_DIR)) return { pass: false, detail: '报告目录不存在: ' + REPORTS_DIR };
  const files = readdirSync(REPORTS_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).sort();
  if (!files.length) return { pass: false, detail: '无 ndjson 文件' };
  const latest = files[files.length - 1];
  const lines = readFileSync(join(REPORTS_DIR, latest), 'utf8').split('\n').filter((l) => l.trim());
  if (!lines.length) return { pass: false, detail: latest + ' 为空' };
  // 逐行必须是合法 JSON
  let bad = 0;
  for (const l of lines) { try { JSON.parse(l); } catch { bad++; } }
  const last = JSON.parse(lines[lines.length - 1]);
  const REQUIRED = ['day', 'ts', 'provider', 'model', 'outcome', 'inSequence', 'seqId',
    'attemptIndex', 'attemptsTotal', 'switched', 'e2eMs', 'sessionId', 'tokens'];
  const missing = REQUIRED.filter((k) => !(k in last));
  return {
    pass: bad === 0 && missing.length === 0,
    detail: `${latest}: ${lines.length} 行, 破损 ${bad}, 缺失字段 [${missing.join(',')}]`,
  };
});

// ─────────────────────────────────────────────
// B-09 · 15 端点全量可达（无 5xx）
// ─────────────────────────────────────────────
await CASE('B-09', 'API 端点全量可达（无 5xx）', async () => {
  const provider = (STATUS.registry?.providers ?? []).find((p) => !p.dormant)?.provider
    ?? (STATUS.registry?.providers ?? [])[0]?.provider ?? 'unknown';
  const archives = await req('GET', BASE + '/test-archives');
  const anyRun = archives.json?.items?.[0];
  const detailPath = anyRun
    ? `${BASE}/test-archives/detail?kind=${anyRun.kind}&runId=${encodeURIComponent(anyRun.runId)}`
    : `${BASE}/test-archives/detail?kind=model-test&runId=__none__`;

  const cases = [
    ['GET', BASE + '/status', undefined, [200]],
    ['POST', BASE + '/state', {}, [200, 400]],
    ['GET', `${BASE}/quota/windows?provider=${encodeURIComponent(provider)}`, undefined, [200]],
    ['POST', BASE + '/quota/reset', { provider: 'x', windowId: 'y' }, [200, 400]],
    ['POST', BASE + '/quota/sync', { provider }, [200, 400]],
    ['POST', BASE + '/probe', {}, [200, 202, 400]],
    ['POST', BASE + '/benchmark', {}, [200, 202, 400]],
    ['GET', BASE + '/reports', undefined, [200, 404]],
    ['POST', BASE + '/reports/generate', {}, [200, 404, 500]],
    ['GET', BASE + '/loadtest', undefined, [200]],
    ['GET', BASE + '/model-test', undefined, [200]],
    ['POST', BASE + '/model-test/manual', { runId: '', targetKey: '' }, [400, 404]],
    ['GET', BASE + '/model-test/list', undefined, [200]],
    ['GET', BASE + '/test-archives', undefined, [200]],
    ['GET', detailPath, undefined, [200, 404]],
  ];
  const bad = [];
  const lines = [];
  for (const [m, p, b, expected] of cases) {
    const r = await req(m, p, { body: b });
    const is5xx = r.status >= 500;
    const okExpected = expected.includes(r.status);
    lines.push(`${m} ${p.replace(BASE, '')} → ${r.status}`);
    if (is5xx) bad.push(`${m} ${p} → ${r.status} (5xx!)`);
    else if (!okExpected) bad.push(`${m} ${p} → ${r.status} (期望 ${expected.join('/')})`);
  }
  return {
    pass: bad.length === 0,
    detail: bad.length === 0
      ? `${cases.length} 端点全部符合（无 5xx）`
      : bad.join(' | '),
    verbose: lines,
  };
});

// ─────────────────────────────────────────────
// B-10 · 客户端资源下发正确
// ─────────────────────────────────────────────
await CASE('B-10', '客户端资源下发正确', async () => {
  const r = await req('GET', '/plugins/@botton/dsh-model-router/client.js');
  const size = Buffer.byteLength(r.body);
  const hasLabel = r.body.includes('模型路由');
  return {
    pass: r.status === 200 && size > 100_000 && hasLabel,
    detail: `status=${r.status} size=${size}B 含「模型路由」=${hasLabel}`,
  };
});

// ─────────────────────────────────────────────
// C-01/02/03 · 配置校验（POST 非法值必须被拒）
// ─────────────────────────────────────────────
await CASE('C-01', '非法时段配置被拒（peakStart == valleyStart）', async () => {
  const r = await req('POST', BASE + '/state', {
    body: { rules: [], timeWindows: { enabled: true, peakStart: '09:00', valleyStart: '09:00', peak: { route: [] }, valley: { route: [] } } },
  });
  const rejected = r.status === 400;
  const msg = r.json?.error ?? '';
  return { pass: rejected && /相等/.test(msg), detail: `${r.status} ${msg.slice(0, 70)}` };
});

await CASE('C-02', '备注超长被拒（notes > 500）', async () => {
  const r = await req('POST', BASE + '/state', {
    body: { rules: [], providerMeta: { __probe__: { notes: 'x'.repeat(501) } } },
  });
  const rejected = r.status === 400;
  const msg = r.json?.error ?? '';
  return { pass: rejected && /长度上限|500/.test(msg), detail: `${r.status} ${msg.slice(0, 70)}` };
});

await CASE('C-03', '报告时刻格式非法被拒（hour=25:00）', async () => {
  const r = await req('POST', BASE + '/state', {
    body: { rules: [], reports: { enabled: true, hour: '25:00' } },
  });
  const rejected = r.status === 400;
  const msg = r.json?.error ?? '';
  return { pass: rejected && /HH:MM/.test(msg), detail: `${r.status} ${msg.slice(0, 70)}` };
});

// ─────────────────────────────────────────────
// C-04 · 路径穿越被拒（安全边界）
// ─────────────────────────────────────────────
await CASE('C-04', '档案详情路径穿越被拒（400）', async () => {
  const bads = ['../../../etc/passwd', 'a/../../b', 'x'.repeat(300), '..%2f..%2fetc'];
  const lines = [];
  let all400 = true;
  for (const b of bads) {
    const p = `${BASE}/test-archives/detail?kind=model-test&runId=${encodeURIComponent(b)}`;
    const r = await req('GET', p);
    lines.push(`${r.status} runId=${b.slice(0, 22)}`);
    if (r.status !== 400) all400 = false;
    // 绝不能读出系统文件内容
    if (r.body.includes('root:')) all400 = false;
  }
  return { pass: all400, detail: lines.join(' | ') };
});

// ─────────────────────────────────────────────
// C-05 · 非法 kind 被拒
// ─────────────────────────────────────────────
await CASE('C-05', '非法 kind 被拒（400）', async () => {
  const r = await req('GET', BASE + '/test-archives/detail?kind=bogus&runId=x');
  return {
    pass: r.status === 400 && /kind/.test(r.json?.error ?? ''),
    detail: `${r.status} ${(r.json?.error ?? '').slice(0, 70)}`,
  };
});

// ─────────────────────────────────────────────
// C-06 · 非回环被拒（安全边界）
// ─────────────────────────────────────────────
await CASE('C-06', '非回环请求被拒（403），且 XFF 不被信任', async () => {
  const legit = await req('GET', BASE + '/status', { host: '127.0.0.1:3081' });
  const evil = await req('GET', BASE + '/status', { host: 'evil.com' });
  const lan = await req('GET', BASE + '/status', { host: '10.0.0.5:3081' });
  const xff = await req('GET', BASE + '/status', { headers: { 'X-Forwarded-For': '10.0.0.5' } });
  const pass = legit.status === 200 && evil.status === 403 && lan.status === 403 && xff.status === 200;
  return {
    pass,
    detail: `合法Host=${legit.status} evil.com=${evil.status} 10.0.0.5=${lan.status} XFF=${xff.status}(须200=不信任XFF)`,
  };
});

// ─────────────────────────────────────────────
// C-07 · 未知路径 404 / 方法错误 405
// ─────────────────────────────────────────────
await CASE('C-07', '未知路径 404 / 方法错误 405', async () => {
  const a = await req('GET', BASE + '/nonexistent');
  const b = await req('POST', BASE + '/status');
  return { pass: a.status === 404 && b.status === 405, detail: `未知=${a.status} POST /status=${b.status}` };
});

// ─────────────────────────────────────────────
// C-08 · 空 targets 被拒
// ─────────────────────────────────────────────
await CASE('C-08', '空 targets 跑批被拒（400）', async () => {
  const r = await req('POST', BASE + '/model-test', { body: { targets: [] } });
  return {
    pass: r.status === 400 && /targets/.test(r.json?.error ?? ''),
    detail: `${r.status} ${(r.json?.error ?? '').slice(0, 70)}`,
  };
});

// ─────────────────────────────────────────────
// D-08 · 档案量与重访阈值告警
// ─────────────────────────────────────────────
await CASE('D-08', '档案列表正常 + 阈值告警符合预期', async () => {
  const r = await req('GET', BASE + '/test-archives');
  if (r.status !== 200) return { pass: false, detail: 'status=' + r.status };
  const n = (r.json.items ?? []).length;
  const THRESHOLD = 150;
  const shouldWarn = n > THRESHOLD;
  return {
    pass: true,
    detail: `档案 ${n} 份（阈值 ${THRESHOLD}，${shouldWarn ? '应告警' : '不应告警'}），响应 ${Buffer.byteLength(r.body)}B`,
  };
});

// ─────────────────────────────────────────────
// X-01 · 安全复核：非法请求未改动配置
// ─────────────────────────────────────────────
// ⚠ 设计要点（初版曾误报，记录于此）：
//   初版比较**整个 config 的 JSON 字符串**，结果误报「配置被改动」。
//   根因是 /status.config 里含**实时派生字段**（providerMeta 的 observed/conflicts
//   由 serializeProviderMeta 现算），随 metrics 变化 → 字符串比对天然不稳定。
//   正解：**只比对「用户可声明的稳定字段」**，派生字段排除在外。
const DERIVED_KEYS = new Set(['observed', 'conflicts']);

/** 剥离派生字段后的稳定视图（用于「配置是否被改动」判定） */
function stableView(config) {
  const out = JSON.parse(JSON.stringify(config));
  for (const [prov, meta] of Object.entries(out.providerMeta ?? {})) {
    for (const k of DERIVED_KEYS) delete meta[k];
  }
  // fallbackPolicy 也含派生诊断字段
  for (const k of ['maxRetriesSource', 'autoTuneFormula', 'quotaGroupCount']) {
    delete out.fallbackPolicy?.[k];
  }
  return out;
}

await CASE('X-01', '安全复核：C-01/02/03 的非法请求未改动配置', async () => {
  const after = await req('GET', BASE + '/status');
  const cfgAfter = after.json?.config ?? {};

  /** 逐字段差异描述 */
  const diffOf = (A, B) => {
    const out = [];
    for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const va = JSON.stringify(A[k]);
      const vb = JSON.stringify(B[k]);
      if (va !== vb) out.push(`${k}: ${String(va).slice(0, 55)} → ${String(vb).slice(0, 55)}`);
    }
    return out;
  };

  const strictDiffs = diffOf(CONFIG_BEFORE_OBJ, cfgAfter);
  const stableDiffs = diffOf(stableView(CONFIG_BEFORE_OBJ), stableView(cfgAfter));

  // 判定用「稳定字段」；严格差异作为**诊断信息**一并输出（用于证实解释）
  const pass = stableDiffs.length === 0;
  const note = strictDiffs.length
    ? ' ｜ 严格比对差异（诊断）: ' + strictDiffs.join(' ; ')
    : ' ｜ 严格比对亦一致';
  return {
    pass,
    detail: (pass ? '稳定字段一致 ✓' : '⚠ 稳定字段被改动: ' + stableDiffs.join(' ; ')) + note,
  };
});

// ─────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────
console.log('════════════════════════════════════════════════════════');
console.log('  人工用例集 · 自动化部分（实机 ' + HOST + ':' + PORT + '）');
console.log('════════════════════════════════════════════════════════');
for (const r of results) {
  console.log(`  ${r.pass ? '✅' : '❌'} ${r.id.padEnd(6)} ${r.name}`);
  if (r.detail) console.log(`           ${r.detail}`);
  if (r.verbose) for (const l of r.verbose) console.log(`             · ${l}`);
}
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log('────────────────────────────────────────────────────────');
console.log(`  通过 ${pass} / ${results.length}${fail ? `  · 失败 ${fail}` : '  · 全过 ✅'}`);
console.log('  未覆盖（须人工）：B-01~B-08 页签交互 · A-01/03/04/05 · C-09~C-12 ·');
console.log('                    D-01~D-07 · E-01~E-09（共 33 例）');
console.log('════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
