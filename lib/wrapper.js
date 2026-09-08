/**
 * llm/stream 包装层：finish 分片驱动的首分片前无感故障切换（方案 P2，三轮审定版）。
 *
 * 关键设计（与 dsh v0.1.1-rc.2 实机语义对齐）：
 * 1. adapter 失败不抛异常，而是产出 finish{reason:{kind:'error'|'aborted',failure}}
 *    分片（adapterFailureChunk）；中间件 throw 会绕过 agent/request-error 恢复通道。
 *    故本层以 finish 分片驱动切换，候选耗尽时合成 error finish（不 throw）。
 * 2. commit-on-substantive（v0.6.0 修订，替代 v0.5 的 commit-on-first-chunk）：
 *    只有「实质内容分片」（非空 text/reasoning delta、tool-call delta、携带内容的
 *    block-end）才 commit；commit 前的结构性分片（block-start/空 delta/usage）进
 *    pending 缓冲区，不向下游产出——切换时直接丢弃（下游从未见过，文法干净），
 *    透传/收尾时先冲刷再发 finish。动机：部分网关先发无内容分片再报 QUOTA/
 *    TRANSPORT（实机日志：glm-5.2 committed 后中途 QUOTA，429 直达会话无法切换）。
 * 3. finish 分片前置处理：未 commit 的 finish 不缓冲，直接判 failover / 原样透传
 *    （复审 R-1；用户 abort 的 terminal finish 被吞会触发 invariant fail）。
 * 4. 看门狗：定时器异步触发（不依赖分片到达）；超时 → 对重发候选 abort 注入信号，
 *    对首选非阻塞弃流。看门狗守到 commit 为止（结构性分片不解除看门狗——供应商
 *    只发心跳不发内容时仍能超时切换）。DSH 在 signal.aborted 时产出 aborted
 *    finish，故以 timedOut 标志区分超时与用户 abort（复审 R-6）。
 * 5. 重发走全新 llm.stream（prepared.stream 绑定原 provider，换 provider 会
 *    INVALID_PREPARED_CALL）；markAgentLoopRequest 品牌是 WeakSet 实现、spread
 *    不保，须对 subOpts 显式重打；WeakSet 递归防护防止重发流被本层再次拦截。
 * 6. 首选尝试走 next()（保留 prepared 绑定与原 options，行为与无插件时完全一致）；
 *    仅失败后重发才走全新 stream。链耗尽 → router.recordExhausted 触发收敛（R-2/R-8）。
 * 7. 候选全被 cooldown 排除且 allCooldownFallback='force-first' → 无视冷却强制
 *    重试首选候选一次（复审 R-7，真正发起尝试而非空 reset）。
 */

import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { hopKeyOf } from './cooldown.js';
import { PROBE_MARK } from './probe.js';

function sameHop(hop, provider, model) {
  return hop.provider === provider && hop.model === model;
}

/**
 * 分片分类（v0.6.0）：是否「实质内容分片」——一旦向下游产出就无法无损回撤的内容。
 * 实质：非空 text/reasoning delta、tool-call delta、携带内容的 block-end。
 * 结构性：block-start、空 delta、usage、空内容 block-end——切换时丢弃是安全的
 * （下游从未见过，块文法不被破坏）。
 * 分片类型与 dsh-llm BlockAssembler 对齐：block-start/text-delta/reasoning-delta/
 * tool-call-delta/block-end/usage/finish。
 */
export function chunkSubstantive(chunk) {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text.length > 0;
    case 'tool-call-delta':
      return true;
    case 'block-end': {
      const b = chunk.block;
      if (!b) return false;
      if (b.type === 'text' || b.type === 'reasoning') {
        return typeof b.text === 'string' && b.text.length > 0;
      }
      return true; // tool-call 等其余块一律视为实质
    }
    default:
      return false; // block-start / usage / finish 由调用方单独处理
  }
}

/**
 * 冲刷 pre-commit 缓冲区（async generator，调用方 yield* 消费）。
 * onChunk 回调用于恢复 usage 记账追踪（缓冲期间的 usage 分片也计入 lastUsage）。
 */
async function* flushPending(state, onChunk) {
  for (const c of state.pending) {
    if (onChunk) onChunk(c);
    yield c;
  }
  state.pending.length = 0;
}

/** 非阻塞弃流（挂起流上 await return() 会死等，绝不 await）。 */
function cleanupStream(stream) {
  try {
    const r = stream.return?.();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch {
    // 弃流失败不影响 failover 主流程
  }
}

/** 可解除的超时闸：promise 与 timeout 二选一先到；fired 供 aborted finish 分流（R-6）。 */
function deferredTimeout(ms) {
  let fire;
  let timer = null;
  const state = { fired: false };
  const promise = new Promise((resolve) => {
    fire = () => {
      state.fired = true;
      resolve(true);
    };
    timer = setTimeout(fire, ms);
  });
  return {
    promise,
    get fired() {
      return state.fired;
    },
    disarm() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * @param {object} deps
 * @param {object} deps.config 规范化配置
 * @param {import('./router.js').Router} deps.router
 * @param {import('./cooldown.js').CooldownBoard} deps.cooldown
 * @param {import('./metrics.js').Metrics} deps.metrics
 * @param {import('./quota.js').QuotaLedger} deps.quota
 * @param {import('./daily.js').DailyLedger} [deps.daily] 日账本（v0.8.0 G1；
 *   透传/切换路径记账；未注入时跳过，保持既有行为）
 * @param {object} deps.log {debug,info,warn,error}
 * @returns {(this: object, options: object, next: () => AsyncIterable) => AsyncIterable}
 *   llm/stream waterfall 监听器（this = 发起派发的 LlmRuntime 实例）
 */
export function createStreamWrapper({ config, router, cooldown, metrics, quota, daily, log }) {
  /** @type {WeakSet<object>} 已被本层包装/重发的 options，防递归拦截 */
  const wrapped = new WeakSet();
  let seqCounter = 0;
  const stats = {
    wraps: 0,
    passthroughs: 0,
    failovers: 0,
    timeouts: 0,
    forced: 0,
    exhaustions: 0,
    userAborts: 0,
  };

  /**
   * 纯透传路径（无候选/兜底回退）：记账 + 同步 quota.record（口径与切换路径
   * 统一，计划 §2.8），try/catch 兜底——内层 throw 时以 EMPTY_RESPONSE 记账
   * 后原样重抛（不透传路径也丢账）。探针/已包装路径不经过这里（零污染）。
   */
  async function* passthrough(options, next, seed, seqId) {
    const startedAt = Date.now();
    let lastUsage = null;
    let recOutcome = 'committed';
    let recErrorCode;
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') lastUsage = chunk.usage ?? null;
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          recOutcome = 'failed';
          recErrorCode = chunk.reason.failure?.code;
        }
        yield chunk;
      }
    } catch (error) {
      if (daily) {
        daily.recordCall({
          provider: seed.provider,
          model: seed.model,
          outcome: 'failed',
          inSequence: false,
          seqId,
          attemptIndex: 0,
          attemptsTotal: 1,
          switched: false,
          errorCode: 'EMPTY_RESPONSE',
          e2eMs: Date.now() - startedAt,
          sessionId: seed.sessionId,
          ts: startedAt,
        });
      }
      throw error;
    }
    if (lastUsage) quota.record(seed.provider, lastUsage);
    if (daily) {
      daily.recordCall({
        provider: seed.provider,
        model: seed.model,
        outcome: recOutcome,
        inSequence: false,
        seqId,
        attemptIndex: 0,
        attemptsTotal: 1,
        switched: false,
        errorCode: recErrorCode,
        e2eMs: Date.now() - startedAt,
        tokens: lastUsage,
        sessionId: seed.sessionId,
        ts: startedAt,
      });
    }
  }

  /**
   * 消费一次尝试的流，产出「合成流」的分片。
   * @returns {AsyncGenerator<object, 'failover'|{kind:'done', failure?:object}, void>}
   *   返回 'failover' = 切换下一候选；done = 已产出 terminal finish（含透传）。
   */
  async function* runAttempt({
    stream,
    provider,
    model,
    attemptIndex,
    isLast,
    watchdog,
    abortInjectable,
    state,
    signals,
    seqId,
    attemptsTotal,
  }) {
    const startedAt = Date.now();
    let lastUsage = null;
    let recOutcome = 'committed';
    let recErrorCode;
    let iterator;
    try {
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        // 手工迭代 + 超时竞速：挂起供应商不产分片时由看门狗打破僵局（R-6）。
        // 看门狗只守首分片：commit 后绝不参与 race——否则 watchdog 恰在首分片
        // 附近触发时（promise 已 resolved），下一轮 race 必胜 → commit 后切换，
        // 两个候选的流拼进同一输出（文法违规）。commit 后恒等下一分片。
        const nextChunk = iterator.next();
        const raced = state.committed
          ? await nextChunk
          : await Promise.race([nextChunk, watchdog.promise.then(() => TIMEOUT)]);
        if (raced === TIMEOUT) {
          log.warn(`watchdog timeout @ ${provider}/${model} → failover(TIMEOUT)`);
          recOutcome = 'failed';
          recErrorCode = 'TIMEOUT';
          stats.timeouts += 1;
          cleanupStream(stream);
          cooldown.onFail(hopKeyOf({ provider, model }), 'TIMEOUT');
          metrics.sample({
            sessionId: state.sessionId, provider, model, attemptIndex, outcome: 'failed',
            errorCode: 'TIMEOUT', e2eMs: Date.now() - startedAt,
          });
          return { kind: 'failover', failure: { code: 'TIMEOUT', message: 'model-router: first-token watchdog' } };
        }
        const { value: chunk, done } = raced;
        if (done) {
          // 流未产出 terminal finish 即结束（adapter 异常）：兜底合成，保 invariant 文法
          log.warn(`stream ended without finish @ ${provider}/${model} → 合成 error finish`);
          recOutcome = 'failed';
          recErrorCode = 'EMPTY_RESPONSE';
          cooldown.onFail(hopKeyOf({ provider, model }), 'EMPTY_RESPONSE');
          metrics.sample({
            sessionId: state.sessionId, provider, model, attemptIndex, outcome: 'failed',
            errorCode: 'EMPTY_RESPONSE', e2eMs: Date.now() - startedAt,
          });
          if (!isLast) {
            // 未提交：pending 缓冲从未向下游产出，直接丢弃（无文法残留）
            return { kind: 'failover', failure: { code: 'EMPTY_RESPONSE', message: 'stream ended without terminal finish' } };
          }
          if (!state.committed) yield* flushPending(state);
          state.committed = true;
          yield {
            type: 'finish',
            reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'model-router: upstream stream ended without terminal finish' } },
          };
          return { kind: 'done' };
        }

        // —— finish 前置处理（R-1）：无论 commit 与否，finish 绝不进缓冲 ——
        if (chunk.type === 'finish') {
          const r = chunk.reason ?? {};
          if (r.kind === 'aborted') {
            if (abortInjectable && watchdog.fired) {
              // 看门狗 abort 注入引发的 aborted finish → 按 TIMEOUT 处理（R-6）
              log.warn(`watchdog abort surfaced @ ${provider}/${model} → failover(TIMEOUT)`);
              recOutcome = 'failed';
              recErrorCode = 'TIMEOUT';
              stats.timeouts += 1;
              cleanupStream(stream);
              cooldown.onFail(hopKeyOf({ provider, model }), 'TIMEOUT');
              metrics.sample({
                sessionId: state.sessionId, provider, model, attemptIndex, outcome: 'failed',
                errorCode: 'TIMEOUT', e2eMs: Date.now() - startedAt,
              });
              return { kind: 'failover', failure: { code: 'TIMEOUT', message: 'model-router: first-token watchdog' } };
            }
            // 真·用户取消：冲刷缓冲后原样透传 terminal finish，交回 agent loop
            recOutcome = 'aborted';
            stats.userAborts += 1;
            metrics.sample({
              sessionId: state.sessionId, provider, model, attemptIndex, outcome: 'aborted', e2eMs: Date.now() - startedAt,
            });
            if (!state.committed) yield* flushPending(state);
            state.committed = true;
            yield chunk;
            return { kind: 'done' };
          }
          if (r.kind === 'error') {
            const code = r.failure?.code;
            if (!state.committed && signals.has(code) && !isLast) {
              log.warn(`failover: ${provider}/${model} code=${code} → 下一候选`);
              recOutcome = 'failed';
              recErrorCode = code;
              stats.failovers += 1;
              cooldown.onFail(hopKeyOf({ provider, model }), code);
              metrics.sample({
                sessionId: state.sessionId, provider, model, attemptIndex, outcome: 'failed',
                errorCode: code, e2eMs: Date.now() - startedAt,
              });
              cleanupStream(stream);
              // 未提交：pending 缓冲（结构性分片）从未向下游产出，丢弃无文法残留
              state.pending.length = 0;
              return { kind: 'failover', failure: r.failure };
            }
            if (isLast && !state.committed) {
              // 最后一候选的未 commit error finish = 链耗尽 → 触发收敛（R-2/R-8）
              router.recordExhausted(r.failure);
            }
            // 已 commit（流中途失败）/ 非 failover 信号 / 最后一候选：冲刷缓冲后原样透传
            recOutcome = state.committed ? 'committed' : 'failed';
            recErrorCode = code;
            metrics.sample({
              sessionId: state.sessionId, provider, model, attemptIndex,
              outcome: state.committed ? 'committed' : 'failed',
              errorCode: code, e2eMs: Date.now() - startedAt,
            });
            if (state.committed) {
              cooldown.onFail(hopKeyOf({ provider, model }), code);
            }
            if (!state.committed) yield* flushPending(state);
            state.committed = true;
            yield chunk;
            return { kind: 'done' };
          }
          // kind === 'stop'：成功收尾
          if (lastUsage) quota.record(provider, lastUsage);
          cooldown.onSuccess(hopKeyOf({ provider, model }));
          metrics.sample({
            sessionId: state.sessionId, provider, model, attemptIndex, outcome: 'committed',
            ttftMs: state.ttftMs, e2eMs: Date.now() - startedAt,
          });
          if (!state.committed) yield* flushPending(state);
          state.committed = true;
          yield chunk;
          return { kind: 'done' };
        }

        // —— 非 finish 分片（v0.6.0）：结构性分片缓冲不产出、不解除看门狗；
        //    实质分片才 commit，commit 时冲刷缓冲（usage 分片恢复记账追踪）——
        if (!state.committed && !chunkSubstantive(chunk)) {
          state.pending.push(chunk);
          continue;
        }
        if (!state.committed) {
          state.committed = true;
          state.ttftMs = Date.now() - startedAt;
          yield* flushPending(state, (c) => {
            if (c.type === 'usage') lastUsage = c.usage ?? null;
          });
        }
        if (chunk.type === 'usage') lastUsage = chunk.usage ?? null;
        yield chunk;
      }
    } finally {
      watchdog.disarm();
      // v0.8.0 G1：attempt-level 记账（含被切换的失败尝试——「切换序列的 API
      // 调用情况」）。recOutcome/recErrorCode 由各分支设置；tokens 用最后 usage。
      if (daily) {
        daily.recordCall({
          provider,
          model,
          outcome: recOutcome,
          inSequence: true,
          seqId,
          attemptIndex,
          attemptsTotal,
          switched: attemptIndex > 0,
          errorCode: recErrorCode,
          ttftMs: state.ttftMs,
          e2eMs: Date.now() - startedAt,
          tokens: lastUsage,
          sessionId: state.sessionId,
          ts: startedAt,
        });
      }
      if (iterator && typeof iterator.return === 'function') {
        // 若因异常/提前返回退出，尽力收尾（正常 done 路径迭代器已结束，no-op）
        try {
          const r = iterator.return();
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch {
          // ignore
        }
      }
    }
  }

  const TIMEOUT = Symbol('model-router:watchdog-timeout');

  /**
   * llm/stream waterfall 监听器。
   * 普通 function 声明：cordis waterfall 将派发方 LlmRuntime 绑定为 this，
   * 重发必须用同一实例（adapter 注册表随实例走）。
   */
  async function* streamWrapper(options, next) {
    // 健康探测标记：探针需测「目标 provider/model」本身，不能被本层 failover 重定向到兜底。
    // 命中即直透下游（adapter 忽略该未知字段），不进入切换逻辑。
    if (options && options[PROBE_MARK]) return yield* next();
    // 会话捕捉（v0.4.2）：任何一次对话（含纯透传）都记录 sessionId，
    // 供面板「指定会话」作用域点选——此前只在尝试路径采样，无候选时永远为空。
    metrics.noteSession?.(options && typeof options.sessionId === 'string' ? options.sessionId : undefined);
    if (wrapped.has(options)) return yield* next();
    wrapped.add(options);
    stats.wraps += 1;

    const policy = config.fallbackPolicy;
    const signals = new Set(policy.failoverSignals);
    // sessionId 来自 dsh agent-loop 的请求标记（buildRequest 注入），
    // 供 match.sessionIds 作用域判定；无会话限定规则时仅作日志
    const seed = {
      provider: options.provider,
      model: options.model,
      ...(typeof options.sessionId === 'string' ? { sessionId: options.sessionId } : {}),
    };
    // v0.8.0 G1：调用序列标识（attempt 记账分组用；透传与切换路径共用）
    const seqId = `${Date.now()}-${++seqCounter}`;
    // candidates() 内部已按「链耗尽时间窗」收敛为单候选（R-2/R-8 汇聚点）
    const chain = router.candidates(seed);
    const failoverCandidates = chain.filter((hop) => !sameHop(hop, seed.provider, seed.model));

    // 无重发候选 → 纯透传（零行为改变；含收敛窗内与未配规则两种情形）。
    // v0.8.0 G1：透传也记账 + 同步 quota.record（口径统一）
    if (failoverCandidates.length === 0) {
      stats.passthroughs += 1;
      return yield* passthrough(options, next, seed, seqId);
    }

    // 候选全被 cooldown 排除时的兜底（R-7）。首选永远先尝试（cooldown 只约束重发候选）：
    // force-first → 强制首选候选一次；fail → 无重发候选，回退纯透传。
    let usable = failoverCandidates.filter((hop) => cooldown.allow(hopKeyOf(hop)));
    if (usable.length === 0 && policy.allCooldownFallback === 'force-first') {
      log.warn(`all candidates cooldown-blocked → force-first: ${hopKeyOf(failoverCandidates[0])}`);
      stats.forced += 1;
      cooldown.forceReset(hopKeyOf(failoverCandidates[0]));
      usable = [failoverCandidates[0]];
    } else if (usable.length === 0) {
      stats.passthroughs += 1;
      return yield* passthrough(options, next, seed, seqId);
    }
    const maxFailovers = Math.min(usable.length, policy.maxRetries);
    const planned = usable.slice(0, maxFailovers);

    // v0.6.1 首选冷却升级：首选被熔断（open）时不再「永远先撞首选」，直接从首个
    // 可用候选发起（全新 llm.stream）。保护：①half-open 期满后首选自动回归首选位；
    // ②候选池为空时维持纯透传；③全部候选被熔断仍走 force-first 兜底（R-7）。
    const primaryUsable = cooldown.allow(hopKeyOf(seed));

    const state = {
      committed: false,
      ttftMs: undefined,
      pending: [],
      // v0.8.0 G1：sessionId 修复——此前未赋值，runAttempt 引用恒为 undefined，
      // 导致 metrics.sample 会话丢失（历史 bug，批 4 修订）
      sessionId: seed.sessionId,
    };
    let llm = this; // 派发方 LlmRuntime（cordis waterfall thisArg）

    // v0.6.1 尝试序列：首选（若未被熔断跳过）+ 计划重发；每跳看门狗受总预算约束
    //（failoverBudgetMs，防挂起候选叠加把会话拖死）。
    const seq = [];
    if (primaryUsable) seq.push({ provider: seed.provider, model: seed.model, viaNext: true });
    else if (planned.length > 0) seq.push({ ...planned.shift(), viaNext: false });
    for (const hop of planned) seq.push({ ...hop, viaNext: false });

    // 保护：序列为空（首选被熔断且无任何可用重发候选、allCooldownFallback='fail'）
    // → 回退纯透传，保持「至少尝试一次」的旧行为，绝不静默失败。
    if (seq.length === 0) {
      stats.passthroughs += 1;
      return yield* passthrough(options, next, seed, seqId);
    }

    let budgetLeft = config.failoverBudgetMs ?? 90_000;
    // 下限仅防 0/负值（生产下限由 normalizeConfig >=1000 校验保证；测试用小值不被钳）
    const watchdogMs = () => Math.max(1, Math.min(config.firstTokenTimeoutMs, budgetLeft));

    let outcome;
    for (let i = 0; i < seq.length; i++) {
      const a = seq[i];
      const isLast = i === seq.length - 1;
      const attemptStart = Date.now();
      const watchdog = deferredTimeout(watchdogMs());
      try {
        if (a.viaNext) {
          // 首选走 next()：保留 prepared 绑定与原 options（行为与无插件时一致）
          outcome = yield* runAttempt({
            stream: next(),
            provider: a.provider,
            model: a.model,
            attemptIndex: i,
            isLast,
            watchdog,
            abortInjectable: false, // 首选无法注入 abort 信号（不能改 next() 的 options）
            state,
            signals,
            seqId,
            attemptsTotal: seq.length,
          });
        } else {
          // 重发/跳过首选：全新 llm.stream（换 provider 必须 prepareCall 重解析）
          const controller = new AbortController();
          watchdog.promise.then(() => {
            try { controller.abort(new Error('model-router: first-token watchdog')); } catch { /* ignore */ }
          });
          const subOpts = markAgentLoopRequest({
            ...options,
            provider: a.provider,
            model: a.model,
            signal: options.signal
              ? AbortSignal.any([options.signal, controller.signal])
              : controller.signal,
          });
          wrapped.add(subOpts);
          log.info(
            `attempt ${i + 1}/${seq.length}: ${seed.provider}/${seed.model} → ${a.provider}/${a.model}`,
          );
          outcome = yield* runAttempt({
            stream: llm.stream(subOpts),
            provider: a.provider,
            model: a.model,
            attemptIndex: i,
            isLast,
            watchdog,
            abortInjectable: true,
            state,
            signals,
            seqId,
            attemptsTotal: seq.length,
          });
        }
      } finally {
        watchdog.disarm();
      }
      budgetLeft -= Date.now() - attemptStart;
      if (outcome.kind === 'done') return;
    }

    // —— 候选耗尽：合成 error finish（不 throw），交 agent/request-error + dsh-llm-retry ——
    log.warn('failover chain exhausted → synthetic error finish');
    router.recordExhausted(outcome.failure ?? null);
    stats.exhaustions += 1;
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: outcome.failure ?? { code: 'NO_CANDIDATE', message: 'model-router: failover chain exhausted' },
      },
    };
  }

  streamWrapper.stats = stats;
  return streamWrapper;
}
