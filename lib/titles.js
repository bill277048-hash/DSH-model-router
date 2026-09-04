/**
 * 会话标题解析（v0.6.0 三级版）：供面板「指定会话」作用域把 sessionId 映射为人类可读标题。
 *
 * 数据源 = 会话日志中的 `session/title` 事件（last-wins，见 @deepseek-ai/dsh-session-title）。
 *
 * 三级解析（逐级兜底，任何失败都降级为 title=null，绝不影响状态接口主流程）：
 * 1. live 会话（`ctx.sessions.get(id)` → 折叠 `session.events`）：同步、最快；
 * 2. sessionQuery 服务（`ctx.get('sessionQuery').readTitleSnapshots`）：live-preferred
 *    + 持久化兜底，异步——覆盖「对话结束、会话已从 live store 卸载」场景
 *    （v0.5.1 只做第 1 级导致标题恒为 null）；
 * 3. 持久化日志直读：`<sessionsDir>/<cwd-slug>/session-<id>/session.jsonl.zstd`
 *    拼接 zstd 帧解码后折叠（sessionQuery 未挂载时的最终兜底；带 mtime 缓存，
 *    未变更不重解码）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** 持久化日志单文件解码上限（字节）——防御异常膨胀的会话日志。 */
const PERSISTED_LOG_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 从会话事件日志折叠最新标题（自家轻量版，返回字符串）。
 * @param {ReadonlyArray<{type: string, data?: object}>|undefined} events 会话事件日志
 * @returns {string|null} 最新标题；无标题事件或日志不可读时为 null
 */
export function foldSessionTitle(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === 'session/title') {
      const t = e.data && typeof e.data.title === 'string' ? e.data.title : null;
      return t && t.length > 0 ? t : null;
    }
  }
  return null;
}

/**
 * 从 sessionQuery 结果条目提取标题字符串。
 * readTitleSnapshots 的 fulfilled value 形如 {session, title?: snapshot}，
 * snapshot 为 dsh-session-title 快照对象 {title, messageSeqs, source, ...}；
 * 防御性兼容直接给字符串的形态。
 */
function titleFromQueryValue(value) {
  const t = value && value.title;
  if (typeof t === 'string') return t.length > 0 ? t : null;
  if (t && typeof t.title === 'string') return t.title.length > 0 ? t.title : null;
  return null;
}

/** zstd 帧魔数（小端 28 B5 2F FD）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * 解码 dsh 拼接帧 zstd 容器，返回全部 JSONL 文本。
 * 容器为多个独立 zstd 帧顺序拼接（append 批次），逐帧解码后拼接。
 */
export function decodeZstdContainer(buf) {
  const positions = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      positions.push(i);
    }
  }
  let text = '';
  for (let k = 0; k < positions.length; k++) {
    const end = k + 1 < positions.length ? positions[k + 1] : buf.length;
    try {
      text += zstdDecompressSync(buf.subarray(positions[k], end)).toString('utf8');
      text += '\n';
    } catch {
      // 坏帧跳过（魔数误匹配的切片会在此失败）
    }
  }
  return text;
}

/**
 * 从持久化日志原始字节折叠最新标题（只 JSON.parse 含标题事件的行，防大行开销）。
 */
export function foldTitleFromContainer(buf) {
  const text = decodeZstdContainer(buf);
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.length === 0 || line.indexOf('"type":"session/title"') === -1) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.type === 'session/title') {
        const t = e.data && typeof e.data.title === 'string' ? e.data.title : null;
        if (t && t.length > 0) return t;
      }
    } catch {
      // 非 JSON 行 / 解析失败 → 继续向前找
    }
  }
  return null;
}

/**
 * 构造 sessionId → 标题 的批量解析器（host 装配用，异步）。
 * @param {object|(() => object|undefined)} sessions SessionStore（`ctx.sessions`）或惰性取值函数
 * @param {() => object|undefined} getQuery 惰性取 sessionQuery 引擎（`ctx.get('sessionQuery')`）；
 *   undefined/服务未挂载时跳过第 2 级
 * @param {string|null} sessionsDir 持久化会话根目录（第 3 级；null 关闭）
 * @param {object} log 日志对象 {debug?}
 * @returns {(ids: string[]) => Promise<Array<{id: string, title: string|null}>>}
 */
export function makeSessionTitleResolver(sessions, getQuery, sessionsDir, log) {
  /** @type {Map<string, {mtimeMs: number, title: string|null}>} 持久化折叠缓存（mtime 失效） */
  const persistedCache = new Map();

  function findPersistedLog(id) {
    if (!sessionsDir || typeof id !== 'string' || !id) return null;
    try {
      for (const slug of readdirSync(sessionsDir)) {
        // 用 readdir 探测会话目录（部分环境 stat/existsSync 受限而 readdir 可用；
        // 失败仅视为该 slug 下无此会话）
        const p = join(sessionsDir, slug, `session-${id}`);
        let files;
        try {
          files = readdirSync(p);
        } catch {
          continue;
        }
        if (files.includes('session.jsonl.zstd')) return join(p, 'session.jsonl.zstd');
      }
    } catch {
      // 根目录不可读 → 视为无持久化
    }
    return null;
  }

  function titleFromPersisted(id) {
    const path = findPersistedLog(id);
    if (!path) return null;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // stat 受限：mtime=0，退化为信任缓存（decode 失败才有影响）
    }
    const cached = persistedCache.get(id);
    if (cached && (mtimeMs > 0 ? cached.mtimeMs === mtimeMs : true)) return cached.title;
    let title = null;
    try {
      const buf = readFileSync(path);
      if (buf.length <= PERSISTED_LOG_MAX_BYTES) title = foldTitleFromContainer(buf);
    } catch (error) {
      try {
        log?.debug?.(`persisted title fold(${id}) failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // ignore
      }
    }
    persistedCache.set(id, { mtimeMs, title });
    return title;
  }

  return async function resolveSessions(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const resolved = new Map();
    const unresolved = [];

    // 第 1 级：live 会话折叠（同步）
    for (const id of ids) {
      let title = null;
      try {
        const store = typeof sessions === 'function' ? sessions() : sessions;
        const session = store && typeof store.get === 'function' ? store.get(id) : null;
        title = foldSessionTitle(session && session.events);
      } catch (error) {
        try {
          log?.debug?.(`live title fold(${id}) failed: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // 日志不可用不影响解析
        }
      }
      if (title) resolved.set(id, title);
      else unresolved.push(id);
    }
    if (unresolved.length === 0) return ids.map((id) => ({ id, title: resolved.get(id) ?? null }));

    // 第 2 级：sessionQuery（live-preferred + 持久化兜底，异步）
    let engine = null;
    try {
      engine = typeof getQuery === 'function' ? getQuery() : getQuery;
    } catch (error) {
      try {
        log?.debug?.(`sessionQuery lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // ignore
      }
    }
    if (engine && typeof engine.readTitleSnapshots === 'function') {
      try {
        const results = await engine.readTitleSnapshots(unresolved);
        for (let i = 0; i < unresolved.length; i++) {
          const r = results[i];
          if (r && r.status === 'fulfilled') {
            const title = titleFromQueryValue(r.value);
            if (title) resolved.set(unresolved[i], title);
          } else if (r && r.status === 'rejected') {
            try {
              log?.debug?.(`sessionQuery title(${unresolved[i]}) rejected: ${String(r.reason).slice(0, 120)}`);
            } catch {
              // ignore
            }
          } else if (r && r.value) {
            // 防御：非 AllSettled 形态（直接 value 数组）
            const title = titleFromQueryValue(r);
            if (title) resolved.set(unresolved[i], title);
          }
        }
      } catch (error) {
        try {
          log?.debug?.(`sessionQuery batch failed: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // ignore
        }
      }
    }

    // 第 3 级：持久化日志直读（sessionQuery 未挂载/未命中时的最终兜底）
    for (const id of unresolved) {
      if (resolved.has(id)) continue;
      const title = titleFromPersisted(id);
      if (title) resolved.set(id, title);
    }

    return ids.map((id) => ({ id, title: resolved.get(id) ?? null }));
  };
}
