#!/usr/bin/env node
// dsh 会话诊断：解码 session.jsonl.zstd，判断"中途停止"的根因，
// 并定性"是否由插件切换模型造成"。
// 用法:
//   node scripts/diag-session.mjs --latest
//   node scripts/diag-session.mjs --id <sessionId>
//   node scripts/diag-session.mjs            # 默认等同 --latest
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
function decodeZstd(buf) {
  let out = Buffer.alloc(0), i = 0;
  while (i + 4 <= buf.length) {
    if (!(buf[i] === 0x28 && buf[i+1] === 0xB5 && buf[i+2] === 0x2F && buf[i+3] === 0xFD)) { i++; continue; }
    let next = -1, j = i + 4;
    while (j + 4 <= buf.length) {
      if (buf[j] === 0x28 && buf[j+1] === 0xB5 && buf[j+2] === 0x2F && buf[j+3] === 0xFD) { next = j; break; }
      j++;
    }
    const frame = next === -1 ? buf.subarray(i) : buf.subarray(i, next);
    try { out = Buffer.concat([out, zlib.zstdDecompressSync(frame)]); } catch { break; }
    if (next === -1) break;
    i = next;
  }
  return out.toString('utf8');
}

const SESSIONS_DIR = path.join(os.homedir(), '.deepseek-harness', 'sessions');
function listSessions() {
  const out = [];
  if (!fs.existsSync(SESSIONS_DIR)) return out;
  for (const ent of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const b = path.join(SESSIONS_DIR, ent.name);
    for (const d of fs.readdirSync(b)) {
      if (!d.startsWith('session-')) continue;
      const p = path.join(b, d, 'session.jsonl.zstd');
      if (fs.existsSync(p)) out.push({ id: d.replace('session-', ''), p, mtime: fs.statSync(p).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const args = process.argv.slice(2);
const idArg = (() => { const i = args.indexOf('--id'); return i >= 0 ? args[i + 1] : null; })();
const useLatest = args.includes('--latest') || (!idArg);

const all = listSessions();
if (all.length === 0) { console.error('未找到任何会话日志'); process.exit(1); }
let target = useLatest ? all[0] : all.find(s => s.id.startsWith(idArg));
if (!target) { console.error('未找到会话:', idArg); process.exit(1); }

const raw = decodeZstd(fs.readFileSync(target.p));
const lines = raw.split('\n').filter(l => l.trim());
let title = null;
const steps = new Map();
let lastFinish = null, lastText = 0, errs = [];
for (const l of lines) {
  let ev; try { ev = JSON.parse(l); } catch { continue; }
  const d = ev.data || {};
  if (ev.type === 'session/title' && d.title) title = d.title.title || d.title;
  if (ev.type === 'assistant/chunk') {
    const c = d.chunk || {};
    const key = `${d.turn}.${d.step}`;
    if (!steps.has(key)) steps.set(key, { provider: null, model: null, finishKind: null, textLen: 0, time: ev.time });
    const s = steps.get(key);
    if (c.type === 'block-end' && c.block?.type === 'text' && c.block?.text) s.textLen += c.block.text.length;
    if (c.type === 'finish') {
      s.finishKind = c.reason?.kind || '?';
      lastFinish = c.reason?.kind || '?';
      const r = c.replayState?.response;
      if (r) { s.provider = r.provider; s.model = r.model; }
      if (c.reason?.kind === 'error' || c.reason?.kind === 'aborted') {
        errs.push({ step: key, code: c.reason?.failure?.code || '?', msg: (c.reason?.failure?.message || '').slice(0, 160), model: r ? `${r.provider}/${r.model}` : '?/?' });
      }
    }
  }
  if (ev.type === 'assistant/message') {
    const src = d.message?.source;
    if (src && src.kind === 'model') {
      const key = `${d.turn}.${d.step}`;
      if (!steps.has(key)) steps.set(key, { provider: null, model: null, finishKind: null, textLen: 0, time: ev.time });
      steps.get(key).provider = src.provider; steps.get(key).model = src.model;
    }
  }
}
const ordered = [...steps.entries()].sort((a, b) => {
  const ka = a[0].split('.').map(Number), kb = b[0].split('.').map(Number);
  return ka[0] - kb[0] || ka[1] - kb[1];
});
let switches = 0, prev = null;
for (const [, s] of ordered) {
  if (s.provider && s.model) { const cur = `${s.provider}/${s.model}`; if (prev && prev !== cur) switches++; prev = cur; }
}

console.log('================ 会话诊断 ================');
console.log(`会话ID : ${target.id}`);
console.log(`标题   : ${title ? JSON.stringify(title) : '(无)'}`);
console.log(`时间   : ${new Date(target.mtime + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16)} (北京)`);
console.log(`步数   : ${steps.size}`);
console.log(`收尾   : ${lastFinish || '(无任何 finish —— 真正的中途截断)'}`);
console.log(`切换   : ${switches} 次`);
console.log('\n--- 错误 finish 明细 ---');
if (errs.length === 0) console.log('  (无 error/aborted finish)');
else for (const e of errs) console.log(`  步 ${e.step.padEnd(9)} code=${e.code.padEnd(10)} model=${e.model}\n     ${e.msg}`);

console.log('\n--- 结论 ---');
if (lastFinish === null) {
  console.log('⚠️ 真正的中途静默停止（无任何 finish）。需结合 dsh 运行时/网络排查传输中断。');
} else if (errs.length > 0) {
  console.log('停止伴随可见错误事件 → 排除"插件静默切换"假设。');
  console.log('根因 = 供应商侧配额/限流/传输错误（见上方 code/message）。');
  console.log('插件切换模型只会在"提交前出错"时发生，且必有可见错误事件；本案');
  console.log(errs.some(e => e.model === '?/?') ? '  出错前未提交模型(?/?)，说明当时仍可切换（插件本可重试/改派）。' : '  出错时已提交模型，插件按设计透传错误、不再切换。');
} else {
  console.log('正常完成（finish=stop / tool-calls），无错误。若仍觉"答到一半停"，多为上游正常截断或用户/客户端中止。');
}
console.log('=========================================');
