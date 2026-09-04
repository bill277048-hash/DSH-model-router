/**
 * 运行时状态持久化（v0.2 需求 1：面板可改排序/开关，免改 patch 免重启）。
 *
 * 文件落在 dsh home（本地 APFS）——绝对不放 SMB NAS（SQLite/原子写约束同方案 §八.1）。
 * 写入走 temp + rename 原子替换。存在时 rules/propose 覆盖 patch config 初值。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadState(storePath, log) {
  if (!storePath) return null;
  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    if (!raw || raw.version !== 1 || !Array.isArray(raw.rules)) {
      log.warn(`store 文件格式不符（version=${raw?.version}），忽略并沿用 patch config`);
      return null;
    }
    return { propose: raw.propose === true, rules: raw.rules, storePath };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log.warn(`store 读取失败（沿用 patch config）: ${error?.message ?? error}`);
    }
    return null;
  }
}

export function saveState(storePath, state, log) {
  const payload = JSON.stringify({ version: 1, ...state, savedAt: new Date().toISOString() }, null, 2);
  const tmp = `${storePath}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(tmp, payload, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, storePath); // 原子替换
    log.info(`state saved → ${storePath}`);
    return true;
  } catch (error) {
    log.error(`state 保存失败: ${error?.message ?? error}`);
    try {
      unlinkSync(tmp); // 清理残留 tmp（best-effort）
    } catch {
      // ignore
    }
    return false;
  }
}
