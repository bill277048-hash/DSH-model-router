/**
 * @botton/dsh-model-router 插件浏览器半（client）v0.8.0。
 *
 * 手写 ModuleLoader 包装格式（无构建链、无 JSX，与 @botton/dsh-guardian 同款）：
 * 注册到 "web-ui.plugin.item" slot（WebUI 插件管理页卡片列表）。
 *
 * v0.8.0（G2 面板信息分级）：
 * - 五页签三级结构：概览摘要卡（L1）→ 明细页签（L2：切换规则/切换日志/
 *   可切换模型/每日报告）→ 工具折叠区（L3：健康探测/TRM 压测/用量窗口）。
 * - 概览默认页 5 张摘要卡：健康总览 / 今日运行 / 昨日报告 / 熔断速览 / 规则速览；
 *   概览态 5s 轮询 `?l1=1` 轻量摘要接口，明细页签才拉全量 status。
 * - 每日报告页签：近 30 天日期下拉 + 报告渲染（评级徽章/总览/按模型表）+ 立即生成。
 * - 用量窗口标题注明口径「全部调用（含透传）」（与每日报告一致）。
 * - 保留原功能：规则编辑/保存/模式/时区/探测/日志/模型全部可达。
 */
window.__ModuleLoader__.load({
  id: "@botton/dsh-model-router",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;
    var useRef = react.useRef;

    var API = {
      status: "/api/model-router/status",
      state: "/api/model-router/state",
      probe: "/api/model-router/probe",
      benchmark: "/api/model-router/benchmark",
      reports: "/api/model-router/reports",
      reportsGenerate: "/api/model-router/reports/generate",
      modelTest: "/api/model-router/model-test",
      modelTestManual: "/api/model-router/model-test/manual",
      modelTestList: "/api/model-router/model-test/list",
      quotaWindows: "/api/model-router/quota/windows",
      quotaReset: "/api/model-router/quota/reset",
      quotaSync: "/api/model-router/quota/sync"
    };
    var POLL_INTERVAL_MS = 5000;
    var REPORT_DAYS_RANGE = 30;

    var STRATEGY_LABELS = {
      explicit: "手工列表（按下方顺序）",
      "same-model": "同模型跨供应商（自动）",
      "same-provider": "同供应商换模型（自动）",
      "exclude-current": "排除当前·注册表全部（自动）"
    };

    // v0.8.0 G2：五页签（原 4 页签 + 每日报告）
    var TABS = [
      { key: "overview", label: "概览" },
      { key: "rules", label: "切换规则" },
      { key: "logs", label: "切换日志" },
      { key: "models", label: "可切换模型" },
      { key: "reports", label: "每日报告" },
      { key: "modelTest", label: "模型测试" }
    ];

    var styles = {
      card: {
        border: "1px solid #d0d7de",
        borderRadius: "8px",
        padding: "16px",
        maxWidth: "900px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif",
        fontSize: "13px",
        color: "#1f2328",
        background: "#ffffff"
      },
      header: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", flexWrap: "wrap" },
      title: { fontSize: "15px", fontWeight: 600, margin: 0 },
      badge: {
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "10px",
        fontSize: "12px",
        fontWeight: 600
      },
      tabbar: { display: "flex", gap: "2px", borderBottom: "1px solid #d0d7de", margin: "4px 0 12px", flexWrap: "wrap" },
      tab: {
        padding: "6px 12px",
        border: "none",
        background: "transparent",
        cursor: "pointer",
        fontSize: "13px",
        color: "#57606a",
        borderBottom: "2px solid transparent",
        marginBottom: "-1px"
      },
      tabActive: {
        padding: "6px 12px",
        border: "none",
        background: "transparent",
        cursor: "pointer",
        fontSize: "13px",
        fontWeight: 600,
        color: "#1f2328",
        borderBottom: "2px solid #0969da",
        marginBottom: "-1px"
      },
      section: { marginBottom: "14px" },
      sectionTitle: { fontWeight: 600, marginBottom: "6px", color: "#57606a" },
      row: { display: "flex", gap: "8px", alignItems: "center", padding: "3px 0", flexWrap: "wrap" },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" },
      meta: { color: "#57606a", fontSize: "12px" },
      warn: { color: "#9a6700", fontSize: "11px" },
      chip: {
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: "10px",
        background: "#f6f8fa",
        border: "1px solid #d0d7de",
        fontSize: "11px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
      },
      box: {
        background: "#f6f8fa",
        border: "1px solid #d0d7de",
        borderRadius: "6px",
        padding: "8px",
        margin: 0,
        maxHeight: "220px",
        overflow: "auto",
        fontSize: "11px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all"
      },
      button: {
        padding: "3px 10px",
        borderRadius: "6px",
        border: "1px solid #d0d7de",
        background: "#f6f8fa",
        cursor: "pointer",
        fontSize: "12px"
      },
      primaryButton: {
        padding: "5px 14px",
        borderRadius: "6px",
        border: "1px solid #1f883d",
        background: "#1f883d",
        color: "#ffffff",
        cursor: "pointer",
        fontSize: "13px"
      },
      narrowSelect: {
        padding: "3px 6px",
        borderRadius: "6px",
        border: "1px solid #d0d7de",
        fontSize: "12px",
        background: "#ffffff",
        maxWidth: "300px"
      },
      input: {
        padding: "3px 6px",
        borderRadius: "6px",
        border: "1px solid #d0d7de",
        fontSize: "12px",
        width: "200px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
      },
      ruleCard: {
        border: "1px solid #eaeef2",
        borderRadius: "6px",
        padding: "10px",
        marginBottom: "10px"
      },
      hint: { color: "#57606a", fontSize: "11px", marginTop: "6px" },
      divider: { borderTop: "1px solid #eaeef2", margin: "10px 0" },
      // v0.8.0 G2：摘要卡
      summaryGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
        gap: "10px",
        marginBottom: "14px"
      },
      summaryCard: {
        border: "1px solid #d0d7de",
        borderRadius: "8px",
        padding: "10px 12px",
        background: "#ffffff",
        cursor: "pointer"
      },
      summaryTitle: { fontSize: "12px", color: "#57606a", fontWeight: 600, marginBottom: "6px" },
      summaryValue: { fontSize: "20px", fontWeight: 700, lineHeight: 1.2 },
      summarySub: { fontSize: "11px", color: "#57606a", marginTop: "4px", lineHeight: 1.5 },
      // 折叠区（L3 工具下沉）
      fold: {
        border: "1px solid #eaeef2",
        borderRadius: "6px",
        marginBottom: "8px",
        background: "#f6f8fa"
      },
      foldSummary: {
        padding: "8px 10px",
        cursor: "pointer",
        fontWeight: 600,
        fontSize: "12px",
        color: "#1f2328",
        listStyle: "none"
      },
      foldBody: { padding: "0 10px 10px" },
      table: { borderCollapse: "collapse", width: "100%", fontSize: "12px" },
      th: { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid #d0d7de", color: "#57606a", fontWeight: 600 },
      td: { padding: "4px 8px", borderBottom: "1px solid #eaeef2" }
    };

    function routeBadge(converged) {
      return converged
        ? { text: "链耗尽收敛中", color: "#9a6700", bg: "#fff8c5" }
        : { text: "正常监听", color: "#1a7f37", bg: "#dafbe1" };
    }

    var MODE_BADGES = {
      stable: { text: "模式：稳定优先", color: "#0969da", bg: "#ddf4ff" },
      balanced: { text: "模式：平衡", color: "#57605a", bg: "#eaeef2" },
      fast: { text: "模式：极速优先", color: "#9a6700", bg: "#fff8c5" },
      "free-tier": { text: "模式：免费额度", color: "#8250df", bg: "#fbefff" },
      custom: { text: "模式：自定义", color: "#1a7f37", bg: "#dafbe1" },
    };

    function modeBadge(mode) {
      return MODE_BADGES[mode] || MODE_BADGES.balanced;
    }

    /** 本地时间显示（日志/探测时间戳原为 UTC ISO，直接截取会与真实时间差 8 小时） */
    function fmtLogTime(ts) {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
      return p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " +
        p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
    }

    function stateBadge(c) {
      if (!c) return { text: "无记录", color: "#57605a", bg: "#eaeef2" };
      if (c.state === "open") return { text: "熔断中", color: "#cf222e", bg: "#ffebe9" };
      if (c.state === "half-open") return { text: "试探中", color: "#9a6700", bg: "#fff8c5" };
      return { text: "正常", color: "#1a7f37", bg: "#dafbe1" };
    }

    function probeBadge(h) {
      if (!h) return { text: "未探测", color: "#57605a", bg: "#eaeef2" };
      if (h.status === "down") return { text: "不可用", color: "#cf222e", bg: "#ffebe9" };
      if (h.status === "degraded") return { text: "降级", color: "#9a6700", bg: "#fff8c5" };
      return { text: "健康", color: "#1a7f37", bg: "#dafbe1" };
    }

    /** v0.8.0 G2：稳定性评级徽章（S/A/B/C/D/N/A） */
    function gradeBadge(grade) {
      var map = {
        S: { color: "#1a7f37", bg: "#dafbe1" },
        A: { color: "#0969da", bg: "#ddf4ff" },
        B: { color: "#9a6700", bg: "#fff8c5" },
        C: { color: "#bf8700", bg: "#fff1e5" },
        D: { color: "#cf222e", bg: "#ffebe9" },
        "N/A": { color: "#57606a", bg: "#eaeef2" }
      };
      var s = map[grade] || map["N/A"];
      return h("span", { style: Object.assign({}, styles.badge, { color: s.color, background: s.bg }) }, grade);
    }

    /** 指定时区当前时刻（Intl/ICU 确定性换算，不依赖 IP 地理位置——VPN 不影响） */
    function fmtNowInTz(tz) {
      try {
        return new Intl.DateTimeFormat("zh-CN", {
          timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        }).format(new Date());
      } catch (e) { return "?"; }
    }

    function fmtInt(n) {
      return typeof n === "number" ? String(n) : "0";
    }

    function fmtTokens(n) {
      if (typeof n !== "number" || !isFinite(n)) return "0";
      if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
      if (n >= 1000) return (n / 1000).toFixed(1) + "k";
      return String(n);
    }

    function providerLabel(p) {
      return p.displayName && p.displayName !== p.provider
        ? p.provider + "（" + p.displayName + "）"
        : p.provider;
    }

    /** 本地日期 YYYY-MM-DD（报告下拉选项用） */
    function dayStr(offset) {
      var d = new Date(Date.now() - offset * 86400000);
      var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
      return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
    }

    /** v0.8.0 G2：摘要卡小组件 */
    function SummaryCard(props) {
      return h("div", {
        style: styles.summaryCard,
        title: props.title || "",
        onClick: props.onClick || undefined
      },
        h("div", { style: styles.summaryTitle }, props.label),
        h("div", { style: styles.summaryValue }, props.value),
        props.sub ? h("div", { style: styles.summarySub }, props.sub) : null);
    }

    function ModelRouterPanel() {
      var s1 = useState(null);
      var status = s1[0];
      var setStatus = s1[1];
      var s2 = useState(null);
      var loadError = s2[0];
      var setLoadError = s2[1];
      var s3 = useState(null);
      var edit = s3[0];
      var setEdit = s3[1];
      var s4 = useState(null);
      var feedback = s4[0];
      var setFeedback = s4[1];
      var s5 = useState(false);
      var saving = s5[0];
      var setSaving = s5[1];
      // v0.9.4 UX 补丁：浮层 toast（生成结果 + 启用 daily 反馈 + 全局错误提示）
      // {kind:'ok'|'warn'|'err', text:string, hint?:string, action?:{label, onClick}, ts:number}
      var sToast = useState(null);
      var toast = sToast[0];
      var setToast = sToast[1];
      var toastTimerRef = useRef(null);
      var s6 = useState("overview");
      var activeTab = s6[0];
      var setActiveTab = s6[1];
      // v0.8.0 G2：l1 轻量摘要（概览轮询）+ 报告页签数据
      var s7 = useState(null);
      var l1 = s7[0];
      var setL1 = s7[1];
      var s8 = useState(null);
      var report = s8[0];
      var setReport = s8[1];
      var s9 = useState(null);
      var reportError = s9[0];
      var setReportError = s9[1];
      var s10 = useState(false);
      var generating = s10[0];
      var setGenerating = s10[1];
      var s11 = useState(null);
      var bench = s11[0];
      var setBench = s11[1];
      // v0.9.5：报告页签 — 是否显示 Markdown 全文视图（全局 state）
      var sShowMd = useState(false);
      var showMd = sShowMd[0];
      var setShowMd = sShowMd[1];
      var sMarkdown = useState(null);
      var markdown = sMarkdown[0];
      var setMarkdown = sMarkdown[1];
      // v0.9.5：切换规则页签 — 每条规则的高级选项（mode / 时序参数）折叠开关
      var sShowAdvanced = useState(new Set());
      var showAdvancedSet = sShowAdvanced[0];
      var setShowAdvancedSet = sShowAdvanced[1];
      function toggleAdvanced(ri) {
        setShowAdvancedSet(function (prev) {
          var next = new Set(prev);
          if (next.has(ri)) next.delete(ri); else next.add(ri);
          return next;
        });
      }
      // v0.9.5：场景预设——覆盖当前 rule.strategy + mode；不触碰其它规则
      function applyPreset(ri, presetId) {
        var preset = {
          'long-stable': { strategy: 'same-model', mode: 'stable' },
          'short-fast': { strategy: 'same-provider', mode: 'free-tier' },
          'cold-start': { strategy: 'exclude-current', mode: 'balanced' },
        }[presetId];
        if (!preset) return;
        mutate(function (next) {
          var r = next.rules[ri];
          if (!r) return;
          r.strategy = preset.strategy;
          r.mode = preset.mode;
        });
        showToast('ok', '已应用场景预设（仅当前规则）', { hint: '其它规则未改动；保存后生效' });
      }
      var mountedRef = useRef(true);

      // 全量 status（明细页签 / 概览初始化 / 保存后刷新）
      var refresh = useCallback(function () {
        return fetch(API.status)
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!mountedRef.current) return;
            if (body && body.ok) {
              setStatus(body);
              setLoadError(null);
              setEdit(function (prev) {
                if (!prev) {
                  return {
                    propose: !!body.config.propose,
                    rules: JSON.parse(JSON.stringify(body.config.rules || [])),
                    timeZone: typeof body.config.timeZone === "string" ? body.config.timeZone : "",
                    mode: typeof body.config.mode === "string" ? body.config.mode : "balanced",
                    dirty: false,
                    syncedAt: "server"
                  };
                }
                return prev;
              });
            } else {
              setLoadError((body && (body.error || body.message)) || "状态查询失败");
            }
          })
          .catch(function (error) {
            if (!mountedRef.current) return;
            setLoadError("无法连接插件服务：" + (error && error.message ? error.message : String(error)));
          });
      }, []);

      // v0.8.0 G2：轻量摘要轮询（概览态专用；daily 未启用时返回 503 → l1 置 null）
      var refreshL1 = useCallback(function () {
        return fetch(API.reports + "?l1=1")
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!mountedRef.current) return;
            if (body && body.ok) setL1(body);
            else setL1(null);
          })
          .catch(function () {
            if (!mountedRef.current) return;
            setL1(null);
          });
      }, []);

      // 报告页签：按日加载报告
      var loadReport = useCallback(function (day) {
        if (!day) return;
        setReportError(null);
        fetch(API.reports + "?day=" + encodeURIComponent(day))
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!mountedRef.current) return;
            if (body && body.ok) {
              setReport(body.report);
              setMarkdown(typeof body.markdown === "string" ? body.markdown : null);
              setShowMd(false);
              setReportError(null);
            } else {
              setReport(null);
              setMarkdown(null);
              setShowMd(false);
              setReportError((body && body.error) || "报告不可用");
            }
          })
          .catch(function (error) {
            if (!mountedRef.current) return;
            setReport(null);
            setReportError("请求失败：" + (error && error.message ? error.message : String(error)));
          });
      }, []);

      // v0.8.0 G2 轮询分级：概览态轮 l1 轻量；明细页签轮全量；报告页签只拉一次
      useEffect(function () {
        mountedRef.current = true;
        if (activeTab === "reports") {
          refresh();
          return function () {
            mountedRef.current = false;
            // 无定时器（报告页按需拉取，不轮询）
          };
        }
        var isOverview = activeTab === "overview";
        if (isOverview) {
          refresh();
          refreshL1();
        } else {
          refresh();
        }
        var timer = setInterval(function () {
          if (isOverview) refreshL1();
          else refresh();
        }, POLL_INTERVAL_MS);
        return function () {
          mountedRef.current = false;
          clearInterval(timer);
          // v0.9.4 UX 补丁：清理 toast 计时器（避免组件卸载后 setState on unmounted）
          if (toastTimerRef.current) {
            clearTimeout(toastTimerRef.current);
            toastTimerRef.current = null;
          }
        };
      }, [refresh, refreshL1, activeTab]);

      // 首次挂载 + 切到报告页：默认选「昨天」
      useEffect(function () {
        if (activeTab === "reports") {
          loadReport(dayStr(1));
        }
      }, [activeTab, loadReport]);

      var save = useCallback(function () {
        if (!edit) return;
        // 客户端预校验：先拦住服务端 400 的明显问题，给出可操作提示（v0.4.1/0.4.2）
        for (var vi = 0; vi < (edit.rules || []).length; vi++) {
          var vm = edit.rules[vi].match || {};
          var hasCond = !!(vm.default || vm.provider || vm.model ||
            (Array.isArray(vm.sessionIds) && vm.sessionIds.length > 0) ||
            (vm.hours && vm.hours.start && vm.hours.end));
          if (!hasCond) {
            setFeedback({
              ok: false,
              message: "规则 " + (vi + 1) + "：未设置任何生效条件——请至少选择一个作用域条件，或把范围改回「全部会话」"
            });
            return;
          }
          // 时间窗校验（v0.5.0）：要么两边都填，要么两边都清；起止不能相同
          if (vm.hours) {
            var hs = vm.hours.start || "", he = vm.hours.end || "";
            if ((hs ? 1 : 0) !== (he ? 1 : 0)) {
              setFeedback({
                ok: false,
                message: "规则 " + (vi + 1) + "：时间窗需同时填写开始与结束时间（或两边都清空以移除时间窗）"
              });
              return;
            }
            if (hs && hs === he) {
              setFeedback({ ok: false, message: "规则 " + (vi + 1) + "：时间窗开始与结束不能相同" });
              return;
            }
          }
          if (Array.isArray(vm.sessionIds) && vm.sessionIds.length === 0) {
            setFeedback({
              ok: false,
              message: "规则 " + (vi + 1) + "：生效范围为「指定会话」但尚未添加任何会话——请从最近会话点选、或粘贴完整会话 ID 添加后再保存；若不想限定会话，请把范围改回「全部会话」"
            });
            return;
          }
        }
        setSaving(true);
        setFeedback(null);
        // v0.9.5 防御性修复：保存前剥离每条规则的残留 match 字段——v0.9.1 起 match 语义
        // 已废除（规则启用由会话模型选择器驱动），若面板加载到历史遗留的 match 规则，
        // 直接保存会触发服务端 fail-fast（allowLegacyMatch=false）。这里统一清洗后提交，
        // 确保面板流程永不携带 match，与「请删除规则的 match 字段」要求一致。
        var saveRules = (edit.rules || []).map(function (r) {
          if (!r || typeof r !== "object") return r;
          var c = Object.assign({}, r);
          delete c.match;
          delete c.scope;
          return c;
        });
        fetch(API.state, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rules: saveRules, timeZone: edit.timeZone ? edit.timeZone : null, mode: edit.mode || "balanced" })
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!mountedRef.current) return;
            if (body.ok) {
              setEdit(function (prev) {
                return prev ? Object.assign({}, prev, { dirty: false }) : prev;
              });
            }
            setFeedback({
              ok: !!body.ok,
              message: body.message || body.error || (body.ok ? "已保存" : "保存失败")
            });
            refresh();
          })
          .catch(function (error) {
            if (!mountedRef.current) return;
            setFeedback({ ok: false, message: "请求失败：" + (error && error.message ? error.message : String(error)) });
          })
          .finally(function () {
            if (mountedRef.current) setSaving(false);
          });
      }, [edit, refresh]);

      // 立即探测全部 (provider,model)（v0.4.0）：异步触发，3 秒后自动刷新看结果
      var probeAll = useCallback(function () {
        fetch(API.probe, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!mountedRef.current) return;
            setFeedback({
              ok: !!body.ok,
              message: body.message || body.error || (body.ok ? "已触发探测" : "探测失败")
            });
            setTimeout(function () { if (mountedRef.current) refresh(); }, 3000);
          })
          .catch(function (error) {
            if (!mountedRef.current) return;
            setFeedback({ ok: false, message: "探测请求失败：" + (error && error.message ? error.message : String(error)) });
          });
      }, [refresh]);

      // v0.8.0 G2：TRM 压测（工具 L3）
      var runBenchmark = useCallback(function () {
        if (!bench || !bench.provider || !bench.model) {
          setFeedback({ ok: false, message: "压测须选择 provider 与 model" });
          return;
        }
        setBench(Object.assign({}, bench, { running: true, result: null, error: null }));
        fetch(API.benchmark, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: bench.provider, model: bench.model })
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!mountedRef.current) return;
            if (body && body.ok) setBench(Object.assign({}, bench, { running: false, result: body.report }));
            else setBench(Object.assign({}, bench, { running: false, error: (body && body.error) || "压测失败" }));
          })
          .catch(function (error) {
            if (!mountedRef.current) return;
            setBench(Object.assign({}, bench, { running: false, error: "压测请求失败：" + (error && error.message ? error.message : String(error)) }));
          });
      }, [bench]);

      // v0.9.4 UX 补丁：浮层 toast helper——3s 自动消失（点 action 不消失；err 5s）
      // 提示+动作按钮场景：「立即生成」失败内嵌「一键启用」按钮；「启用 daily」成功内嵌「如何重启」提示。
      function showToast(kind, text, opts) {
        if (toastTimerRef.current) {
          clearTimeout(toastTimerRef.current);
          toastTimerRef.current = null;
        }
        var payload = Object.assign({ kind: kind, text: text, ts: Date.now() }, opts || {});
        setToast(payload);
        var ttl = kind === 'err' ? 6000 : 3500;
        toastTimerRef.current = setTimeout(function () {
          setToast(null);
          toastTimerRef.current = null;
        }, ttl);
      }
      // v0.9.4 UX 补丁：未启用 daily 时一键启用（POST state 触发保存 + 提示需重启 dsh）
      var enableReports = useCallback(function () {
        if (!status || !status.config) return;
        var hour = (status.reports && status.reports.hour) || '01:00';
        setSaving(true);
        showToast('warn', '正在启用每日报告...', null);
        fetch(API.state, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reports: { enabled: true, hour: hour } })
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!mountedRef.current) return;
            if (body && body.ok) {
              var hint = body.reloadHint || '设置已保存，但需重启 dsh 才生效';
              showToast('ok', body.message || '每日报告已启用', {
                hint: hint,
                action: body.requiresReload ? null : null, // 重启是 shell 命令，不由按钮触发
              });
              // 立即 refresh status 让 enabled 字段更新（虽然 daily 实例要重启才真生效）
              refresh();
            } else {
              showToast('err', '启用失败：' + ((body && body.error) || '未知错误'), null);
            }
          })
          .catch(function (error) {
            if (!mountedRef.current) return;
            showToast('err', '启用请求失败：' + (error && error.message ? error.message : String(error)), null);
          })
          .finally(function () {
            if (mountedRef.current) setSaving(false);
          });
      }, [status, refresh]);

      // v0.9.4 UX 补丁：重写 generateReport——失败时显示 toast（不再仅红字内嵌），
      // 失败若是「未启用 daily」类错误，内嵌「一键启用」按钮；成功 toast 显示「调用 N 次」+ reportDir。
      var generateReport = useCallback(function () {
        setGenerating(true);
        setReportError(null);
        showToast('warn', '正在生成昨日报告...', null);
        fetch(API.reportsGenerate, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!mountedRef.current) return;
            if (body && body.ok) {
              setReport(body.report);
              setReportError(null);
              if (body.day) loadReport(body.day);
              var summary = body.report && body.report.summary;
              var calls = summary ? summary.calls : 0;
              showToast('ok', '已生成 ' + body.day + ' · 调用 ' + calls + ' 次', {
                hint: status && status.reports && status.reports.reportDir
                  ? '文件路径：' + status.reports.reportDir
                  : null,
              });
            } else {
              var errMsg = (body && body.error) || "生成失败";
              setReportError(errMsg);
              // 「未启用 daily」类错误自动给「一键启用」动作
              var isDisabled = errMsg.indexOf('reports disabled') !== -1;
              showToast('err', '生成失败：' + errMsg, isDisabled ? {
                hint: '一键启用每日报告',
                action: { label: '立即启用', onClick: enableReports },
              } : null);
            }
            refreshL1();
          })
          .catch(function (error) {
            if (!mountedRef.current) return;
            var msg = (error && error.message ? error.message : String(error));
            setReportError("生成请求失败：" + msg);
            showToast('err', '生成请求失败：' + msg, null);
          })
          .finally(function () {
            if (mountedRef.current) setGenerating(false);
          });
      }, [loadReport, refreshL1, status, enableReports]);

      // ---------- 编辑态操作 ----------
      function mutate(fn) {
        setEdit(function (prev) {
          if (!prev) return prev;
          var next = JSON.parse(JSON.stringify(prev));
          fn(next);
          next.dirty = true;
          return next;
        });
      }
      // v0.9.4 UX 清理：setRuleMatch / setScope 已删除——match 语义在 v0.9.1 已
      // 移除；规则启用由会话模型选择器驱动。这里 mutate 仅供候选链 / 模式 /
      // 时间窗（setHours）等保留功能使用。
      function moveHop(ri, hi, delta) {
        mutate(function (next) {
          var route = next.rules[ri].route;
          var j = hi + delta;
          if (j < 0 || j >= route.length) return;
          var t = route[hi];
          route[hi] = route[j];
          route[j] = t;
        });
      }
      function removeHop(ri, hi) {
        mutate(function (next) { next.rules[ri].route.splice(hi, 1); });
      }
      function addHop(ri, provider, model) {
        if (!provider || !model) return;
        mutate(function (next) {
          next.rules[ri].route.push({ provider: provider, model: model });
        });
      }
      function setStrategy(ri, strategy) {
        mutate(function (next) { next.rules[ri].strategy = strategy; });
      }
      // v0.9.4 UX 清理：setHours 与时间窗 UI 已删除——v0.9.1 起 match 语义废除，
      // 时间窗属于 match 内的 hours 字段（不再参与匹配）。
      function removeRule(ri) {
        mutate(function (next) { next.rules.splice(ri, 1); });
      }
      function addRule() {
        if (!status) return;
        var reg = status.registry || { providers: [] };
        var seed = null;
        for (var i = 0; i < reg.providers.length && !seed; i++) {
          var p = reg.providers[i];
          if (!p.dormant && p.models.length > 0) seed = { provider: p.provider, model: p.models[0].id };
        }
        if (!seed) return;
        mutate(function (next) {
          // v0.9.5 修复：新建规则不得再携带 match——v0.9.1 起 match 语义已废除，
          // 残留 match 会在保存时触发 fail-fast（allowLegacyMatch=false 默认）。
          next.rules.push({ strategy: "explicit", route: [seed] });
        });
      }
      function resetEdit() {
        if (!status) return;
        setEdit({
          propose: !!status.config.propose,
          rules: JSON.parse(JSON.stringify(status.config.rules || [])),
          timeZone: typeof status.config.timeZone === "string" ? status.config.timeZone : "",
          mode: typeof status.config.mode === "string" ? status.config.mode : "balanced",
          dirty: false,
          syncedAt: "server"
        });
        setFeedback(null);
      }

      // ---------- 派生数据 ----------
      var registry = (status && status.registry) || { providers: [] };
      var activeProviders = registry.providers.filter(function (p) { return !p.dormant; });
      var modelOptions = [];
      activeProviders.forEach(function (p) {
        p.models.forEach(function (mo) {
          modelOptions.push({
            provider: p.provider,
            model: mo.id,
            label: p.provider + (p.displayName ? "（" + p.displayName + "）" : "") + " / " + mo.id
          });
        });
      });
      var providerOptions = activeProviders.map(function (p) {
        return { provider: p.provider, label: providerLabel(p) };
      });
      var msRaw = (status && status.metrics) || {};
      // v0.5.1：会话条目 {id, ts?, title?}（title 来自服务端 session 日志折叠，
      // null/缺失时回退显示 id）。兼容旧版仅 sessionIds 的响应。
      var recentSessions = msRaw.sessions || (msRaw.sessionIds || []).map(function (id) { return { id: id }; });
      var sessionTitleById = {};
      recentSessions.forEach(function (s) { sessionTitleById[s.id] = s.title || null; });
      var sessionLabel = function (sid) {
        var t = sessionTitleById[sid];
        if (t) return t.length > 20 ? t.slice(0, 20) + "…" : t;
        return sid.slice(0, 10) + "…";
      };

      var children = [];

      // —— 头部 + 页签 ——
      var meta = routeBadge(status && status.router && status.router.converged);
      children.push(
        h("div", { key: "header", style: styles.header },
          h("h3", { style: styles.title }, "模型路由（dsh-model-router）"),
          h("span", { style: Object.assign({}, styles.badge, { color: meta.color, background: meta.bg }) }, meta.text),
          h("span", { style: Object.assign({}, styles.badge, modeBadge(status && status.config && status.config.mode)) }),
          h("span", { style: styles.meta }, "v" + (status ? status.version : "?"))),
        h("div", { key: "tabbar", style: styles.tabbar },
          TABS.map(function (t) {
            return h("button", {
              key: t.key,
              style: activeTab === t.key ? styles.tabActive : styles.tab,
              onClick: function () { setActiveTab(t.key); }
            }, t.label);
          }))
      );

      if (loadError) {
        children.push(h("div", { key: "err", style: { color: "#cf222e", marginBottom: "8px" } }, loadError));
      }

      if (status && edit) {
        // ============ L1：概览（默认页）5 张摘要卡 ============
        if (activeTab === "overview") {
          // 卡 1：健康总览（provider 总数 + 探测状态计数）
          var provAll = registry.providers;
          var activeCount = activeProviders.length;
          var probeEntriesMap = (status.probe && status.probe.entries) || {};
          var upCount = 0, degradedCount = 0, downCount = 0, probeTotal = 0;
          Object.keys(probeEntriesMap).forEach(function (k) {
            var hh = probeEntriesMap[k];
            probeTotal += 1;
            if (hh.status === "down") downCount += 1;
            else if (hh.status === "degraded") degradedCount += 1;
            else upCount += 1;
          });
          var healthSub = probeTotal > 0
            ? "健康 " + upCount + " · 降级 " + degradedCount + " · 不可用 " + downCount + "（探测 " + probeTotal + "）"
            : (status.probe && status.probe.enabled
                ? "探测已开启，暂无结果"
                : "探测未开启——点「立即探测」可手动跑一轮");
          children.push(
            h("div", { key: "ov-cards", style: styles.summaryGrid },
              h(SummaryCard, {
                key: "c1", label: "健康总览",
                value: String(activeCount) + " 家",
                sub: healthSub,
                title: "已接入的非休眠供应商数；探测状态来自健康探测板",
                onClick: function () { setActiveTab("models"); }
              }),

              // 卡 2：今日运行（wrapper 计数 + 今日 token 小计）
              (function () {
                var w = status.wrapper || {};
                var today = (l1 && l1.today) || null;
                var tokenTotal = today && today.tokens ? today.tokens.total : null;
                var subParts = [
                  "透传 " + fmtInt(w.passthroughs) + " · 切换 " + fmtInt(w.failovers) +
                  " · 超时 " + fmtInt(w.timeouts) + " · 链耗尽 " + fmtInt(w.exhaustions)
                ];
                if (tokenTotal !== null) subParts.push("今日 token " + fmtTokens(tokenTotal));
                else subParts.push("（未启用每日报告，无 token 统计）");
                return h(SummaryCard, {
                  key: "c2", label: "今日运行",
                  value: fmtInt(w.wraps) + " 次",
                  sub: subParts.join(" · "),
                  title: "包装调用次数（含透传与切换）；今日 token 来自每日报告账本（reports.enabled=true 时）",
                  onClick: function () { setActiveTab("logs"); }
                });
              })(),

              // 卡 3：昨日报告（l1.days 最近一日）
              (function () {
                var days = (l1 && l1.days) || [];
                var last = days.length > 0 ? days[days.length - 1] : null;
                if (!last) {
                  return h(SummaryCard, {
                    key: "c3", label: "昨日报告",
                    value: "暂无",
                    sub: l1 ? "昨日无调用记录" : "未启用每日报告（reports.enabled=false）",
                    title: "每日凌晨 1 点生成前一日报告",
                    onClick: function () { setActiveTab("reports"); }
                  });
                }
                var sm = last.summary || {};
                var total = sm.calls || 0;
                var rate = total > 0 ? Math.round(((total - (sm.failed || 0) - (sm.aborted || 0)) / total) * 100) + "%" : "—";
                return h(SummaryCard, {
                  key: "c3", label: "昨日报告",
                  value: last.day,
                  sub: "成功率 " + rate + " · 切换 " + fmtInt(sm.switchedCalls) + " 次 · 调用 " + fmtInt(total),
                  title: "点击查看每日报告明细",
                  onClick: function () { setActiveTab("reports"); }
                });
              })(),

              // 卡 4：熔断速览（cooldown 熔断中条目数）
              (function () {
                var cdEntries = Object.entries(status.cooldown || {});
                var openCount = cdEntries.filter(function (p) { return p[1] && p[1].state === "open"; }).length;
                var halfCount = cdEntries.filter(function (p) { return p[1] && p[1].state === "half-open"; }).length;
                var sub = openCount + halfCount > 0
                  ? "熔断中 " + openCount + " · 试探 " + halfCount
                  : "无熔断——全部正常";
                return h(SummaryCard, {
                  key: "c4", label: "熔断速览",
                  value: String(openCount),
                  sub: sub,
                  title: "点击查看 Cooldown 明细",
                  onClick: function () { setActiveTab("logs"); }
                });
              })(),

              // 卡 5：规则速览（v0.9.4 UX 清理：match 已废除，简化为数 + 首链首跳）
              (function () {
                var rules = (edit && edit.rules) || [];
                var scopeText = rules.length === 0
                  ? "纯透传模式（不改任何行为）"
                  : rules.map(function (r, ri) {
                      var first = (r.route || [])[0];
                      var firstHop = first ? (first.provider + "/" + first.model) : "（无候选）";
                      return "规则" + (ri + 1) + "：首选 " + firstHop + "（链长 " + (r.route || []).length + "）";
                    }).join("；");
                return h(SummaryCard, {
                  key: "c5", label: "切换规则",
                  value: String(rules.length) + " 条",
                  sub: scopeText.length > 60 ? scopeText.slice(0, 60) + "…" : scopeText,
                  title: "点击进入切换规则编辑",
                  onClick: function () { setActiveTab("rules"); }
                });
              })())
          );
        }

        // ============ 页签 2：切换规则 ============
        if (activeTab === "rules") {
          // 时间规则时区状态（v0.5.0）：Intl 换算不依赖 IP，VPN 不直接影响；
          // 但 VPN 可能改变系统自动定位的时区——显式固定规则时区可彻底免疫
          var sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          var cfgTz = (status.config && status.config.timeZone) || sysTz;
          children.push(
            h("div", { key: "tzrow", style: styles.section },
              h("div", { style: styles.sectionTitle }, "时间窗口径（峰谷定价）"),
              h("div", { style: styles.row },
                h("span", { style: styles.meta },
                  "规则时区 " + cfgTz + " · 当前时间 " + fmtNowInTz(cfgTz)),
                (status.config && status.config.timeZone && sysTz !== status.config.timeZone)
                  ? h("span", { style: styles.warn },
                      "⚠ 系统时区 " + sysTz + " 与规则时区不一致——时间窗一律按规则时区执行，VPN 改系统时区不影响")
                  : (!(status.config && status.config.timeZone))
                    ? h("span", { style: styles.meta },
                        "未显式固定——现用系统时区；若设备 VPN 可能改变系统时区，请在下方把它固定（如 Asia/Shanghai）")
                    : null))
          );
          children.push(
            h("div", { key: "rules", style: styles.section },
              h("div", { style: styles.sectionTitle }, "规则编辑"),
              // v0.9.4 UX 清理：v0.9.1 起 match 语义已废除。规则启用由会话模型选择器
              // 驱动——选模型包即本规则对应包生效；选普通直连模型即按系统默认直连。
              h("div", { style: styles.hint },
                "规则启用来自会话模型选择器：选择本规则对应的模型包即生效；选择普通直连模型即按系统默认直连。"),
              (edit.rules || []).length === 0
                ? h("div", { style: styles.meta, key: "none" }, "无规则——纯透传模式")
                : edit.rules.map(function (rule, ri) {
                    // v0.9.4 UX 清理：v0.9.1 起 match 语义已被移除，规则启用由会话
                    // 模型选择器驱动（选模型包即生效、选普通直连模型即直连）。故此处
                    // 不再保留「作用域下拉 / model / provider / session / 自定义组合」
                    // 编辑器，仅展示规则名 + 模式 + 候选链。
                    // v0.9.5：策略折叠——默认显示 explicit，3 个场景预设直接覆盖当前 rule；高级选项折叠
                     var strat = rule.strategy || "explicit";
                     var advancedForRule = showAdvancedSet && showAdvancedSet.has(ri);
                     var presetTips = {
                       'long-stable': '长任务·稳定同模型：保留同模型跨供应商为备用，单次自动跑满首选。推荐长会话、长文档。',
                       'short-fast': '短问·快切免费：首选 free-tier，备用自动同供应商换模型 + 同模型跨供应商。',
                       'cold-start': '冷启动·全注册表：自动排除当前已选模型，把注册表全跑一遍（去重）。',
                     };
                    return h("div", { key: "r" + ri, style: styles.ruleCard },
                      // 行 1：策略（默认显示 explicit 一行；场景预设按钮 + 高级切换）
                      h("div", { style: styles.row, key: "strat" + ri },
                        h("span", { style: styles.meta }, "候选链规则："),
                        h("select", {
                          style: styles.narrowSelect,
                          value: strat,
                          onChange: function (ev) { setStrategy(ri, ev.target.value); }
                        }, Object.keys(STRATEGY_LABELS).map(function (k) {
                          return h("option", { key: k, value: k }, STRATEGY_LABELS[k]);
                        })),
                        // 场景预设（覆盖当前 rule.strategy；不触碰其它规则）
                        h("button", {
                          style: styles.button,
                          title: presetTips['long-stable'],
                          onClick: function () { applyPreset(ri, 'long-stable'); }
                        }, "场景预设：长任务·稳定同模型"),
                        h("button", {
                          style: styles.button,
                          title: presetTips['short-fast'],
                          onClick: function () { applyPreset(ri, 'short-fast'); }
                        }, "短问·快切免费"),
                        h("button", {
                          style: styles.button,
                          title: presetTips['cold-start'],
                          onClick: function () { applyPreset(ri, 'cold-start'); }
                        }, "冷启动·全注册表"),
                        h("button", {
                          style: Object.assign({}, styles.button, { fontSize: "11px" }),
                          onClick: function () { toggleAdvanced(ri); }
                        }, advancedForRule ? "收起高级" : "高级选项（mode / 时序参数）")),
                      // 行 4：候选链
                      h("div", { key: "hops" + ri },
                        (rule.route || []).map(function (hop, hi) {
                          var reg = registry.providers.find(function (x) { return x.provider === hop.provider; });
                          var known = !!reg && !reg.dormant;
                          var label = reg ? providerLabel(reg) : hop.provider;
                          return h("div", { key: "h" + hi, style: styles.row },
                            h("span", { style: styles.mono },
                              (hi === 0 ? "① 首选 " : "   ↑" + (hi + 1) + " ") + label + " / " + hop.model),
                            known ? null : h("span", { style: styles.warn }, "⚠ 未注册"),
                            h("button", { style: styles.button, disabled: hi === 0,
                              onClick: function () { moveHop(ri, hi, -1); } }, "↑"),
                            h("button", { style: styles.button,
                              disabled: hi === (rule.route || []).length - 1,
                              onClick: function () { moveHop(ri, hi, 1); } }, "↓"),
                            h("button", { style: styles.button,
                              onClick: function () { removeHop(ri, hi); } }, "移除"));
                        })),
                      // 行 5：追加候选（v0.9.4 UX 清理：作用域已废除，全量列出）
                      (function () {
                        var hopPool = activeProviders
                          .filter(function (p) { return p.models.length > 0; })
                          .flatMap(function (p) {
                            return p.models.map(function (mo) {
                              var v = p.provider + "|" + mo.id;
                              var taken = (rule.route || []).some(function (x) {
                                return x.provider === p.provider && x.model === mo.id;
                              });
                              return h("option", { key: v, value: v, disabled: taken },
                                p.provider + (p.displayName ? "（" + p.displayName + "）" : "") + " / " + mo.id);
                            });
                          });
                        return h("div", { style: styles.row, key: "add" + ri },
                          h("select", {
                            style: styles.narrowSelect,
                            value: "",
                            onChange: function (ev) {
                              var v = ev.target.value;
                              if (!v) return;
                              var parts = v.split("|");
                              addHop(ri, parts[0], parts[1]);
                              ev.target.value = "";
                            }
                          }, [h("option", { key: "ph", value: "" }, "＋ 追加候选…")].concat(hopPool)),
                          hopPool.length === 0
                            ? h("span", { style: styles.warn }, "当前无可追加候选——请检查注册表目录")
                            : null);
                      })(),
                      // 行 6：删除规则
                      h("div", { style: styles.row, key: "rm" + ri },
                        h("button", {
                          style: styles.button,
                          onClick: function () { removeRule(ri); }
                        }, "删除此规则")));
                  }),
              activeProviders.some(function (p) { return p.models.length > 0; })
                ? h("button", { key: "addrule", style: styles.button, onClick: addRule }, "＋ 添加规则")
                : null)
          );

          // v0.7.0 优先模式切换 + 提议总开关 + 保存/恢复
          var MODE_DEFS = [
            { key: "stable", label: "稳定优先", desc: "长线任务不中断第一：挂起 60 秒才切换，单次请求上限 5 分钟。等待更长，但误切最少、token 重发最少。适合训练、批量调研等无人值守任务。" },
            { key: "balanced", label: "平衡（默认）", desc: "大多数交互任务的折中：挂起 30 秒切换，单次请求上限 90 秒。兼顾稳定与速度。" },
            { key: "fast", label: "极速优先", desc: "即时任务尽快出结果：挂起 15 秒即切，上限 45 秒，停用更早解除。代价：慢启动模型可能被误判切换（重发消耗 token），切换更频繁。" },
            { key: "free-tier", label: "免费额度模式", desc: "免费/低价额度优先：挂起 60 秒才切（避免误切烧重发），候选间间隔 2 秒，单次上限 90 秒（balanced 基准）。适合预算敏感任务。" },
            { key: "custom", label: "自定义", desc: "用户自行配置预算 / 看门狗 / 冷却：本档不套用任何预设，保持你的显式参数。适合对参数有精确控制要求的高级场景。" },
          ];
          var curMode = edit.mode || "balanced";
          var modeDesc = (MODE_DEFS.filter(function (m) { return m.key === curMode; })[0] || MODE_DEFS[1]).desc;
          children.push(
            h("div", { key: "mode", style: styles.section },
              h("div", { style: styles.row },
                h("span", { style: styles.meta }, "优先模式："),
                MODE_DEFS.map(function (m) {
                  var active = m.key === curMode;
                  return h("button", {
                    key: m.key,
                    style: Object.assign({}, styles.button, active
                      ? { background: "#0969da", color: "#fff", borderColor: "#0969da", fontWeight: 600 }
                      : {}),
                    onClick: function () {
                      setEdit(function (prev) { return prev ? Object.assign({}, prev, { mode: m.key, dirty: true }) : prev; });
                    }
                  }, m.label + (active ? " ✓" : ""));
                })),
              h("div", { style: styles.hint }, modeDesc),
              h("div", { style: styles.hint },
                "模式只影响等待与切换的激进程度；模型停用（10 分钟自动回归）、首选跳过、总预算保护在所有模式下都自动生效，无需理解模型差异。")),
            // v0.9.4 UX 清理：「开场改派」开关已取消——v0.9.1 起 propose 语义被移除，
            // 规则启用来自会话模型选择器（选模型包即规则生效、选普通直连模型即直连）。
            // 故此处不再保留 checkbox + 提示段落。
            h("div", { style: styles.row, key: "tz" },
              h("span", { style: styles.meta }, "时间窗时区："),
              (function () {
                var TZ_COMMON = [
                  "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Macau", "Asia/Taipei",
                  "Asia/Tokyo", "Asia/Singapore", "UTC",
                  "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Berlin",
                ];
                var all = [];
                try { all = Intl.supportedValuesOf("timeZone"); } catch (e) { all = []; }
                var cur = edit.timeZone || "";
                // 当前值不在列表（如手填过）时置顶补一项，保证回显
                if (cur && TZ_COMMON.indexOf(cur) === -1 && all.indexOf(cur) === -1) TZ_COMMON.unshift(cur);
                var opt = function (tz) {
                  return h("option", { key: tz, value: tz }, tz);
                };
                return h("select", {
                  style: Object.assign({}, styles.narrowSelect, { maxWidth: "260px" }),
                  value: cur,
                  onChange: function (ev) {
                    var v = ev.target.value;
                    setEdit(function (prev) { return prev ? Object.assign({}, prev, { timeZone: v, dirty: true }) : prev; });
                  }
                }, [
                  h("option", { key: "sys", value: "" }, "系统时区（跟随设备）"),
                ].concat(
                  all.length > 0
                    ? [
                        h("optgroup", { key: "common", label: "常用" }, TZ_COMMON.map(opt)),
                        h("optgroup", { key: "all", label: "全部 IANA 时区" },
                          all.filter(function (tz) { return TZ_COMMON.indexOf(tz) === -1; }).map(opt)),
                      ]
                    : TZ_COMMON.map(opt)
                ));
              })()),
            h("div", { key: "save", style: styles.row },
              h("button", {
                style: Object.assign({}, styles.primaryButton, saving ? { opacity: 0.5 } : {}),
                disabled: saving,
                onClick: save
              }, saving ? "保存中…" : "保存并即时生效（免重启）"),
              h("button", { style: styles.button, disabled: saving, onClick: resetEdit }, "恢复服务器状态"),
              edit.dirty ? h("span", { style: styles.warn }, "有未保存修改") : null,
              feedback
                ? h("span", { style: { color: feedback.ok ? "#1a7f37" : "#cf222e", fontWeight: 600 } }, feedback.message)
                : null),
            h("div", { style: styles.hint },
              "多条件作用域为「同时满足」；候选顺序即切换顺序。保存写入 ~/.deepseek-harness/home/model-router-state.json。"),
            h("div", { style: styles.hint },
              "切换全自动，无需理解模型差异：某模型 429 配额耗尽 → 一次失败即自动停用 10 分钟（期满自动试探回归）；挂起不响应 → 30 秒内切换；单次请求总耗时上限 90 秒；首选被停用时直接从下一可用模型开始。"),
          );
        }

        // ============ 页签 3：切换日志（统计 + Cooldown + L3 工具折叠区） ============
        if (activeTab === "logs") {
          var w = status.wrapper || {};
          children.push(
            h("div", { key: "stats", style: styles.section },
              h("div", { style: styles.sectionTitle }, "切换统计"),
              h("div", { style: styles.meta },
                "包装调用 " + fmtInt(w.wraps) + " · 透传 " + fmtInt(w.passthroughs) +
                " · 故障切换 " + fmtInt(w.failovers) + " · 看门狗超时 " + fmtInt(w.timeouts) +
                " · 强制重试 " + fmtInt(w.forced) + " · 链耗尽 " + fmtInt(w.exhaustions) +
                " · 用户取消 " + fmtInt(w.userAborts)))
          );
          var cooldownEntries = Object.entries(status.cooldown || {});
          children.push(
            h("div", { key: "cd", style: styles.section },
              h("div", { style: styles.sectionTitle }, "Cooldown 熔断"),
              cooldownEntries.length === 0
                ? h("div", { style: styles.meta }, "无失败记录")
                : cooldownEntries.map(function (pair) {
                    var badge = stateBadge(pair[1]);
                    return h("div", { key: pair[0], style: styles.row },
                      h("span", { style: styles.mono }, pair[0]),
                      h("span", { style: Object.assign({}, styles.badge, { color: badge.color, background: badge.bg }) }, badge.text),
                      h("span", { style: styles.meta },
                        "连续失败 " + pair[1].failures + " 次" + (pair[1].lastErrorCode ? " · 末次 " + pair[1].lastErrorCode : "")));
                  }))
          );

          // —— L3 工具折叠区（探测 / 压测 / 用量窗口）——
          var probeEntries = status.probe ? Object.entries(status.probe.entries || {}) : [];
          children.push(
            h("div", { key: "tool-fold", style: styles.section },
              h("div", { style: styles.sectionTitle }, "工具"),
              h("details", { key: "fold-probe", style: styles.fold },
                h("summary", { style: styles.foldSummary },
                  "健康探测" + (probeEntries.length > 0 ? "（" + probeEntries.length + "）" : "") +
                  (status.probe && status.probe.enabled ? "" : " · 周期未开启")),
                h("div", { style: styles.foldBody },
                  probeEntries.length === 0
                    ? h("div", { style: styles.meta }, "暂无探测记录——点「立即探测」跑一轮")
                    : probeEntries.map(function (pair) {
                        var hb = probeBadge(pair[1]);
                        return h("div", { key: pair[0], style: styles.row },
                          h("span", { style: styles.mono }, pair[0]),
                          h("span", { style: Object.assign({}, styles.badge, { color: hb.color, background: hb.bg }) }, hb.text),
                          h("span", { style: styles.meta },
                            (typeof pair[1].p95TtftMs === "number" ? "P95 " + pair[1].p95TtftMs + "ms" : "") +
                            (pair[1].lastError ? " · 末次 " + pair[1].lastError : "") +
                            (pair[1].lastProbeAt ? " · " + fmtLogTime(pair[1].lastProbeAt) : "")));
                      }),
                  h("div", { style: styles.row },
                    h("button", { style: styles.button, onClick: probeAll }, "立即探测全部"),
                    h("span", { style: styles.meta }, "探测结果作为候选排序的健康度参考（down 排末、延迟低优先）")))),

              h("details", { key: "fold-bench", style: styles.fold },
                h("summary", { style: styles.foldSummary }, "TRM 压测（QPS 阶梯找 RPM 边界）"),
                h("div", { style: styles.foldBody },
                  h("div", { style: styles.row },
                    h("span", { style: styles.meta }, "目标："),
                    h("select", {
                      style: styles.narrowSelect,
                      value: (bench && bench.provider) || "",
                      onChange: function (ev) {
                        var v = ev.target.value;
                        var opts = bench ? Object.assign({}, bench) : {};
                        opts.provider = v;
                        opts.model = "";
                        opts.result = null;
                        opts.error = null;
                        setBench(opts);
                      }
                    }, [h("option", { key: "ph", value: "" }, "选择供应商…")].concat(
                      activeProviders.map(function (p) {
                        return h("option", { key: p.provider, value: p.provider }, providerLabel(p));
                      }))),
                    h("select", {
                      style: styles.narrowSelect,
                      value: (bench && bench.model) || "",
                      onChange: function (ev) {
                        var opts = bench ? Object.assign({}, bench) : {};
                        opts.model = ev.target.value;
                        opts.result = null;
                        opts.error = null;
                        setBench(opts);
                      }
                    }, [h("option", { key: "ph", value: "" }, "选择模型…")].concat(
                      activeProviders
                        .filter(function (p) { return !bench || !bench.provider || p.provider === bench.provider; })
                        .flatMap(function (p) {
                          return p.models.map(function (mo) {
                            return h("option", { key: p.provider + "/" + mo.id, value: mo.id },
                              p.provider + (p.displayName ? "（" + p.displayName + "）" : "") + " / " + mo.id);
                          });
                        }))),
                    h("button", {
                      style: styles.button,
                      disabled: !bench || !bench.provider || !bench.model || bench.running,
                      onClick: runBenchmark
                    }, bench && bench.running ? "压测中…" : "开始压测")),
                  bench && bench.error
                    ? h("div", { style: { color: "#cf222e", marginTop: "6px", fontSize: "12px" } }, bench.error)
                    : null,
                  bench && bench.result
                    ? h("pre", { style: Object.assign({}, styles.box, { maxHeight: "260px", marginTop: "6px" }) },
                        JSON.stringify(bench.result, null, 2))
                    : null,
                  h("div", { style: styles.hint }, "压测会真实消耗目标模型的 token 配额（安全系数 0.6 起步）。结果写入探测板的 benchmark 条目，可回看。"))),

              h("details", { key: "fold-quota", style: styles.fold },
                h("summary", { style: styles.foldSummary }, "用量窗口（5h / 1w）· 口径：全部调用（含透传）"),
                h("div", { style: styles.foldBody },
                  (function () {
                    var q = status.quota || {};
                    var qKeys = Object.keys(q);
                    if (qKeys.length === 0) return h("div", { style: styles.meta }, "暂无用量记录");
                    return h("table", { style: styles.table },
                      h("thead", null,
                        h("tr", null,
                          h("th", { style: styles.th }, "供应商"),
                          h("th", { style: styles.th }, "5h token"),
                          h("th", { style: styles.th }, "5h 调用"),
                          h("th", { style: styles.th }, "1w token"),
                          h("th", { style: styles.th }, "1w 调用"))),
                      h("tbody", null, qKeys.map(function (k) {
                        var e = q[k] || {};
                        var w5 = e.window5h || {}, w1 = e.window1w || {};
                        return h("tr", { key: k },
                          h("td", { style: styles.td }, h("span", { style: styles.mono }, k)),
                          h("td", { style: styles.td }, fmtTokens(w5.tokens)),
                          h("td", { style: styles.td }, fmtInt(w5.calls)),
                          h("td", { style: styles.td }, fmtTokens(w1.tokens)),
                          h("td", { style: styles.td }, fmtInt(w1.calls)));
                      })));
                  })(),
                  h("div", { style: styles.hint }, "滚动窗口按 provider 粒度记账；口径与每日报告一致（含纯透传调用）。"))),

              h("details", { key: "fold-windows", style: styles.fold },
                h("summary", { style: styles.foldSummary }, "窗口限额（5h / 1周 / 自定义）· 耗尽自动避让、不打上游"),
                h("div", { style: styles.foldBody },
                  (function () {
                    var qw = status.quotaWindows || {};
                    var qwKeys = Object.keys(qw);
                    if (qwKeys.length === 0) {
                      return h("div", { style: styles.meta }, "暂无窗口限额声明（在 providerMeta 或「模型测试」行内「档案」中配置）");
                    }
                    function winRow(pid, title, w) {
                      if (!w || w.limit == null) return null;
                      var ratio = w.usedRatio == null ? null : Math.round(w.usedRatio * 100);
                      var hot = ratio != null && ratio >= 95;
                      var color = ratio == null ? "#6e7781" : hot ? "#cf222e" : ratio >= 60 ? "#bf8700" : "#1a7f37";
                      var statusTxt = ratio == null
                        ? "—"
                        : (hot ? "⚠ " : "") + ratio + "%" +
                          (w.msToReset != null && w.msToReset > 0
                            ? " · 重置 " + (w.msToReset >= 3600000 ? (w.msToReset / 3600000).toFixed(1) + "h" : Math.ceil(w.msToReset / 60000) + "m") + " 后"
                            : " · 可重置");
                      return h("tr", { key: pid + "-" + title },
                        h("td", { style: styles.td }, h("span", { style: styles.mono }, pid)),
                        h("td", { style: styles.td }, title),
                        h("td", { style: styles.td }, fmtInt(w.limit)),
                        h("td", { style: styles.td }, w.used == null ? "—" : fmtInt(w.used)),
                        h("td", { style: styles.td }, h("span", { style: Object.assign({}, styles.mono, hot ? { fontWeight: 600 } : {}, { color: color }) }, statusTxt)));
                    }
                    var allRows = [];
                    qwKeys.forEach(function (k) {
                      var e = qw[k] || {};
                      var added = false;
                      [["5h", e.fiveHour], ["1周", e.weekly]].forEach(function (pair) {
                        var r = winRow(k, pair[0], pair[1]);
                        if (r) { allRows.push(r); added = true; }
                      });
                      (Array.isArray(e.customWindows) ? e.customWindows : []).forEach(function (cw) {
                        var r = winRow(k, cw.id, cw);
                        if (r) { allRows.push(r); added = true; }
                      });
                      if (!added) {
                        allRows.push(h("tr", { key: k }, h("td", { style: styles.td, colSpan: 5 }, h("span", { style: styles.mono }, k), " — 已声明但未设限额")));
                      }
                    });
                    return h("table", { style: styles.table },
                      h("thead", null,
                        h("tr", null,
                          h("th", { style: styles.th }, "供应商"),
                          h("th", { style: styles.th }, "窗口"),
                          h("th", { style: styles.th }, "限额"),
                          h("th", { style: styles.th }, "已用"),
                          h("th", { style: styles.th }, "占比 / 状态"))),
                      h("tbody", null, allRows));
                  })(),
                  h("div", { style: styles.hint }, "窗口耗尽后 wrapper 主动避让（返回 QUOTA，不打实际 API）；「模型测试」行内「档案」按钮可配置与人工重置。"))))
          );

          var recent = (status.metrics && status.metrics.recent) || [];
          children.push(
            h("div", { key: "recent", style: styles.section },
              h("div", { style: styles.sectionTitle }, "最近尝试（新→旧，最多 20 条）"),
              recent.length === 0
                ? h("div", { style: styles.meta }, "暂无记录——发起一次对话后再看")
                : h("pre", { style: styles.box },
                    recent.slice().reverse().slice(0, 20).map(function (r) {
                      return fmtLogTime(r.ts) + "  #" + r.seq +
                        "  " + r.provider + "/" + r.model +
                        "  " + r.outcome +
                        (r.errorCode ? "  " + r.errorCode : "") +
                        (typeof r.ttftMs === "number" ? "  TTFT " + r.ttftMs + "ms" : "") +
                        (typeof r.e2eMs === "number" ? "  E2E " + r.e2eMs + "ms" : "") +
                        (r.sessionId ? "  @" + r.sessionId.slice(0, 8) : "") +
                        "  (UTC: " + r.ts.slice(11, 19) + ")";
                    }).join("\n")))
          );
        }

        // ============ 页签 4：可切换模型 ============
        if (activeTab === "models") {
          var chainPairs = [];
          (edit.rules || []).forEach(function (rule) {
            (rule.route || []).forEach(function (hop) {
              chainPairs.push(hop.provider + "/" + hop.model);
            });
          });
          children.push(
            h("div", { key: "reg", style: styles.section },
              h("div", { style: styles.sectionTitle },
                "全部可切换模型（数据来源：dsh 设置-模型 同源 llm 服务目录）"),
              registry.providers.length === 0
                ? h("div", { style: styles.meta }, "尚未取到——等待目录刷新（默认 5 分钟周期）")
                : registry.providers.map(function (p) {
                    return h("div", { key: p.provider, style: { marginBottom: "8px" } },
                      h("div", { style: styles.row },
                        h("span", { style: styles.mono }, providerLabel(p)),
                        p.dormant ? h("span", { style: styles.warn }, "休眠（未注册路由）") : null,
                        p.models.length === 0 && !p.dormant
                          ? h("span", { style: styles.meta }, "模型目录未就绪")
                          : null),
                      p.models.length > 0
                        ? h("div", { style: styles.row },
                            p.models.map(function (mo) {
                              var inChain = chainPairs.indexOf(p.provider + "/" + mo.id) !== -1;
                              var ph = status.probe ? (status.probe.entries || {})[p.provider + "/" + mo.id] : null;
                              var probeStyle = {};
                              if (ph) {
                                if (ph.status === "down") probeStyle = { borderColor: "#cf222e" };
                                else if (ph.status === "degraded") probeStyle = { borderColor: "#9a6700" };
                                else probeStyle = { borderColor: "#1a7f37" };
                              }
                              var title = mo.name && mo.name !== mo.id ? mo.name : mo.id;
                              if (ph) {
                                title += " · 探测:" + (ph.status === "up" ? "健康" : ph.status === "degraded" ? "降级" : "不可用") +
                                  (ph.lastError ? "(" + ph.lastError + ")" : "");
                              }
                              return h("span", {
                                key: mo.id,
                                style: Object.assign({}, styles.chip, inChain ? { background: "#dafbe1", borderColor: "#1a7f37" } : {}, probeStyle),
                                title: title
                              }, mo.id + (inChain ? " ✓已入链" : ""));
                            }))
                        : null);
                  }),
              h("div", { style: styles.hint }, "✓已入链 = 已在「切换规则」某条候选链中。加入候选链请到「切换规则」页签。"))
          );
        }

        // ============ 页签 5：每日报告（G1 消费端） ============
        if (activeTab === "reports") {
          var dayOptions = [];
          for (var di = 1; di <= REPORT_DAYS_RANGE; di++) dayOptions.push(dayStr(di));
          var selectedDay = (report && report.day) || dayStr(1);
          // v0.9.4 UX 补丁：未启用 daily 时顶部横幅 + 「一键启用」按钮
          var reportsEnabled = status && status.reports && status.reports.enabled;
          if (!reportsEnabled) {
            children.push(
              h("div", { key: "rp-disabled", style: styles.section },
                h("div", { style: styles.sectionTitle }, "每日报告未启用"),
                h("div", { style: styles.meta },
                  "每日报告功能默认关闭（reports.enabled=false）。启用后，wrapper 透传与切换调用都会被记账，" +
                  "凌晨 " + (status && status.reports && status.reports.hour ? status.reports.hour : '01:00') + " 自动生成昨日报告，" +
                  "文件落在 " + (status && status.reports && status.reports.reportDir ? status.reports.reportDir : '~/Documents/dsh-model-router-reports') + "。"),
                h("div", { style: styles.row, key: "rp-enable-row" },
                  h("button", {
                    style: Object.assign({}, styles.button, styles.buttonPrimary || {}),
                    disabled: saving,
                    onClick: enableReports,
                  }, saving ? "启用中…" : "一键启用每日报告"),
                  h("span", { style: styles.meta }, "启用后需重启 dsh 才生效（macOS: launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh）"))
              )
            );
          } else {
            // v0.9.4 UX 清理：报告目录改为可点击的 Finder 链接（macOS 浏览器允许
            // file:// 直链时打开访达；拦截时给文案指引「访达 → 前往 → 文档」）。
            var reportDir = status.reports.reportDir || '';
            // v0.9.4 UX 补丁：reportDir 可能含空格/中文，分片 encodeURIComponent 保证
            // file:// 直链可正确解析（保留首尾斜杠，绝对路径 `file:///` 三段斜杠不变）。
            var fileUrl = "file://" + (reportDir || '').split('/').map(encodeURIComponent).join('/');
            children.push(
              h("div", { key: "rp-enabled-info", style: styles.section },
                h("div", { style: styles.meta },
                  "每日报告已启用 · 报告目录 ",
                  h("a", {
                    href: fileUrl,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    style: { color: "#0969da", textDecoration: "underline" },
                    title: "点击在访达打开（若浏览器拦截，请到访达「前往 → 文档」找目录）"
                  }, reportDir || '~/Documents/dsh-model-router-reports'),
                  " · 自动生成时刻 " + (status.reports.hour || '01:00') + "（面板下方仍可手动生成）"))
            );
          }
          children.push(
            h("div", { key: "rp-toolbar", style: styles.row },
              h("span", { style: styles.meta }, "选择日期："),
              h("select", {
                style: styles.narrowSelect,
                value: selectedDay,
                onChange: function (ev) { loadReport(ev.target.value); }
              }, dayOptions.map(function (d) {
                return h("option", { key: d, value: d }, d);
              })),
              h("button", {
                style: styles.button,
                disabled: generating || !reportsEnabled,
                onClick: generateReport,
                title: !reportsEnabled ? "请先点击上方「一键启用每日报告」" : ""
              }, generating ? "生成中…" : "立即生成昨日报告"),
              h("span", { style: styles.meta }, reportsEnabled ? "每日凌晨 1 点自动生成前一日报告" : "启用后自动生成"))
          );
          if (reportError) {
            children.push(
              h("div", { key: "rp-err", style: styles.section },
                h("div", { style: styles.meta }, reportError),
                h("div", { style: styles.hint },
                  "提示：每日报告默认关闭——需在插件配置中启用 reports.enabled=true（开启后透传与切换调用都会被记账）。" +
                  "也可点上方「立即生成昨日报告」手动补生成。")));
          }
          if (report) {
            var sm = report.summary || {};
            var total = sm.calls || 0;
            var successRate = total > 0 ? Math.round(((total - (sm.failed || 0) - (sm.aborted || 0)) / total) * 100) : 0;
            var byPM = report.byProviderModel || [];
            children.push(
              h("div", { key: "rp-summary", style: styles.section },
                h("div", { style: styles.sectionTitle }, "报告总览 · " + report.day + "（0:00–23:59" + (report.generatedAt ? "）" : "，实时聚合）")),
                h("div", { style: styles.meta },
                  "调用 " + fmtInt(total) + " · 成功 " + fmtInt(sm.succeeded) +
                  " · 失败 " + fmtInt(sm.failed) + " · 取消 " + fmtInt(sm.aborted) +
                  " · 成功率 " + successRate + "%" +
                  " · 切换调用 " + fmtInt(sm.switchedCalls) + " 次（序列内切换 " + fmtInt(sm.switchCount) + " 次）" +
                  " · 序列内调用 " + fmtInt(sm.inSequenceCalls))),
              h("div", { key: "rp-table", style: styles.section },
                h("div", { style: styles.sectionTitle }, "按供应商 × 模型"),
                byPM.length === 0
                  ? h("div", { style: styles.meta }, "该日无调用记录")
                  : h("table", { style: styles.table },
                      h("thead", null,
                        h("tr", null,
                          h("th", { style: styles.th }, "供应商/模型"),
                          h("th", { style: styles.th }, "评级"),
                          h("th", { style: styles.th }, "调用"),
                          h("th", { style: styles.th }, "失败"),
                          h("th", { style: styles.th }, "成功率"),
                          h("th", { style: styles.th }, "TTFT 均值"),
                          h("th", { style: styles.th }, "P95 TTFT"),
                          h("th", { style: styles.th }, "token (入/出)"),
                          h("th", { style: styles.th }, "切换调用"),
                          h("th", { style: styles.th }, "主要错误"))),
                      h("tbody", null, byPM.map(function (g) {
                        return h("tr", { key: g.provider + "/" + g.model },
                          h("td", { style: styles.td }, h("span", { style: styles.mono }, g.provider + " / " + g.model)),
                          h("td", { style: styles.td }, gradeBadge(g.grade)),
                          h("td", { style: styles.td }, fmtInt(g.calls)),
                          h("td", { style: styles.td }, fmtInt(g.failed)),
                          h("td", { style: styles.td }, (typeof g.failRate === "number" ? Math.round((1 - g.failRate) * 100) : "—") + "%"),
                          h("td", { style: styles.td }, g.avgTtftMs !== null ? g.avgTtftMs + "ms" : "—"),
                          h("td", { style: styles.td }, g.p95TtftMs !== null ? g.p95TtftMs + "ms" : "—"),
                          h("td", { style: styles.td }, fmtTokens(g.inputTokens) + " / " + fmtTokens(g.outputTokens)),
                          h("td", { style: styles.td }, fmtInt(g.switchedCalls)),
                          h("td", { style: styles.td },
                            (g.topErrors && g.topErrors.length > 0
                              ? g.topErrors.map(function (e) { return e.code + "×" + e.count; }).join("、")
                              : "—")));
                      }))),
              h("div", { key: "rp-errs", style: styles.section },
                h("div", { style: styles.sectionTitle }, "错误码分布"),
                (report.errors || []).length === 0
                  ? h("div", { style: styles.meta }, "无错误")
                  : report.errors.map(function (e) {
                      return h("div", { key: e.code, style: styles.row },
                        h("span", { style: styles.mono }, e.code),
                        h("span", { style: styles.meta }, "×" + e.count));
                    }))),
              h("div", { style: styles.hint },
                "评级规则：样本 <3 为 N/A；失败率 0% = S、<2% = A、<5% = B、<15% = C、其余 = D。失败 = 报错结尾；用户取消（aborted）不计失败。"),
              // v0.9.5：Markdown 视图切换
              h("div", { key: "rp-md-toggle", style: Object.assign({}, styles.row, { marginTop: "8px" }) },
                h("button", {
                  style: styles.button,
                  disabled: !markdown,
                  onClick: function () { setShowMd(function (v) { return !v; }); },
                  title: !markdown ? "需先点击「立即生成昨日报告」生成 md 文件" : ""
                }, showMd ? "隐藏 Markdown" : "查看 Markdown")),
              showMd && markdown
                ? h("div", { key: "rp-md", style: Object.assign({}, styles.box, { whiteSpace: "pre-wrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", maxHeight: "400px", overflow: "auto" }) }, markdown)
                : null);
          }
        }

        // ============ 页签 6：模型测试（v0.9.5 §9） ============
        if (activeTab === "modelTest") {
          children.push(h(ModelTestPanel, { status: status }));
        }
      }

      children.push(
        h("div", { key: "btn", style: { marginTop: "8px" } },
          h("button", { style: styles.button, onClick: function () { refresh(); } }, "立即刷新"))
      );

      // v0.9.4 UX 补丁：浮层 toast——覆盖整个面板顶层，用户不会错过反馈
      if (toast) {
        var toastBg = toast.kind === 'err' ? '#fde7e7'
          : toast.kind === 'warn' ? '#fff7e6'
          : '#e8f7ec';
        var toastBorder = toast.kind === 'err' ? '#e8463a'
          : toast.kind === 'warn' ? '#efaa17'
          : '#1dc981';
        var toastText = toast.kind === 'err' ? '#7a1e18'
          : toast.kind === 'warn' ? '#7a5a00'
          : '#0f6e3f';
        var action = toast.action;
        children.push(
          h("div", {
            key: "toast",
            style: {
              position: "sticky",
              bottom: "12px",
              marginTop: "16px",
              padding: "10px 14px",
              background: toastBg,
              border: "1px solid " + toastBorder,
              borderRadius: "8px",
              color: toastText,
              font: "500 13px/1.5 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
              boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
              zIndex: 10,
            },
          },
            h("div", { key: "t-text" }, toast.text),
            toast.hint ? h("div", {
              key: "t-hint",
              style: { marginTop: "4px", fontSize: "12px", opacity: 0.85 },
            }, toast.hint) : null,
            action ? h("div", { key: "t-action", style: { marginTop: "6px" } },
              h("button", {
                style: Object.assign({}, styles.button, {
                  padding: "4px 12px",
                  fontSize: "12px",
                  background: toastBorder,
                  color: "#fff",
                  border: "none",
                }),
                onClick: function () {
                  if (action && typeof action.onClick === 'function') action.onClick();
                  if (toastTimerRef.current) {
                    clearTimeout(toastTimerRef.current);
                    toastTimerRef.current = null;
                  }
                  setToast(null);
                },
              }, action.label)
            ) : null,
          )
        );
      }

      return h("div", { style: styles.card }, children);
    }

    // ============ 模型测试面板（v0.9.5 §9） ============
    function ModelTestPanel(props) {
      var sList = useState(null); var list = sList[0]; var setList = sList[1];
      var sSnap = useState(null); var snap = sSnap[0]; var setSnap = sSnap[1];
      var sErr = useState(""); var err = sErr[0]; var setErr = sErr[1];
      var sBusy = useState(false); var busy = sBusy[0]; var setBusy = sBusy[1];
      var sForm = useState(false); var formOpen = sForm[0]; var setFormOpen = sForm[1];
      var sProvider = useState(""); var selProvider = sProvider[0]; var setSelProvider = sProvider[1];
      var sModel = useState(""); var selModel = sModel[0]; var setSelModel = sModel[1];
      var sSelRun = useState(null); var selRun = sSelRun[0]; var setSelRun = sSelRun[1];
      // v0.9.5 §11 模型档案抽屉
      var sArch = useState(null); var archProvider = sArch[0]; var setArchProvider = sArch[1];
      var sArchWin = useState(null); var archWin = sArchWin[0]; var setArchWin = sArchWin[1];
      var sArchErr = useState(""); var archErr = sArchErr[0]; var setArchErr = sArchErr[1];
      var sArchBusy = useState(false); var archBusy = sArchBusy[0]; var setArchBusy = sArchBusy[1];
      var sArchSaved = useState(false); var archSaved = sArchSaved[0]; var setArchSaved = sArchSaved[1];

      var load = useCallback(function () {
        fetch(API.modelTest)
          .then(function (r) { return r.json(); })
          .then(function (b) {
            if (!b || !b.ok) { setErr((b && b.error) || "加载失败"); return; }
            setList(b.list || []);
            setSnap({ running: !!b.running, aborted: !!b.aborted, last: b.last || null, reportDir: b.reportDir || null });
            if (!b.running) setBusy(false);
            setErr("");
          })
          .catch(function () { setErr("请求失败"); });
      }, []);
      useEffect(function () { load(); }, [load]);

      function bridge(tr, action) {
        setBusy(true);
        // v0.9.6 修复：原为 fetch(API.state)（GET），但 /state 端点只接受 POST
        // → 恒返 405 {"error":"method not allowed: use POST"}，三个按钮全部失效。
        // 改读 GET /status 的 config 块（routes.js 已回显 rules/providerMeta/timeZone/mode）。
        // 刻意不用 props.status：本组件保存后只调自己的 load()（仅刷新 model-test 数据），
        // 不刷新父组件 status → 连点「加入首选」+「加入备用」时第二次会读到旧 rules 造成丢更新。
        fetch(API.status).then(function (r) { return r.json(); }).then(function (s) {
          if (!s || !s.ok) { setErr("读取状态失败"); setBusy(false); return; }
          var st = s.config || {};
          var rules = (Array.isArray(st.rules) ? st.rules : []).map(function (r) {
            var c = Object.assign({}, r); delete c.match; delete c.scope; return c;
          });
          if (action === "primary" || action === "backup") {
            var r0 = rules.length ? rules[0] : { strategy: "explicit", route: [] };
            if (!Array.isArray(r0.route)) r0.route = [];
            var removed = r0.route.filter(function (h) { return !(h.provider === tr.provider && h.model === tr.model); });
            if (action === "primary") removed.unshift({ provider: tr.provider, model: tr.model });
            else removed.push({ provider: tr.provider, model: tr.model });
            r0.route = removed;
            if (rules.length === 0) rules.push(r0); else rules[0] = r0;
          }
          var body = { rules: rules, providerMeta: st.providerMeta };
          if (action === "exclude") {
            var pm = Object.assign({}, (st.providerMeta || {})[tr.provider] || {});
            pm.exclude = true;
            body.providerMeta = Object.assign({}, st.providerMeta || {});
            body.providerMeta[tr.provider] = pm;
          }
          // 剥离每次都要同步的无关字段避免被回写（timeZone/mode 保持服务端现值）
          if (st.timeZone !== undefined) body.timeZone = st.timeZone;
          if (st.mode !== undefined) body.mode = st.mode;
          fetch(API.state, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          }).then(function (r) { return r.json(); }).then(function (b) {
            setBusy(false);
            if (!b || !b.ok) setErr((b && b.error) || "保存失败");
            else { setErr(""); load(); }
          }).catch(function () { setBusy(false); setErr("保存请求失败"); });
        }).catch(function () { setBusy(false); setErr("读取状态失败"); });
      }

      // v0.9.5 §11 模型档案抽屉：打开 / 编辑 / 保存窗口限额 / 人工重置
      function openArchive(provider) {
        setArchProvider(provider);
        setArchWin(null);
        setArchErr("");
        setArchSaved(false);
        fetch(API.quotaWindows + "?provider=" + encodeURIComponent(provider))
          .then(function (r) { return r.json(); })
          .then(function (b) {
            if (!b || !b.ok) { setArchErr((b && b.error) || "读取窗口失败"); return; }
            setArchWin({
              fiveHour: b.fiveHour ? { limit: b.fiveHour.limit, resetAt: b.fiveHour.resetAt } : null,
              weekly: b.weekly ? { limit: b.weekly.limit, resetAt: b.weekly.resetAt } : null,
              customWindows: Array.isArray(b.customWindows) ? b.customWindows.map(function (w) { return { id: w.id, windowMs: w.windowMs, limit: w.limit }; }) : []
            });
          })
          .catch(function () { setArchErr("请求失败"); });
      }
      function setWindowSlot(slot, field, value) {
        setArchWin(function (cur) {
          if (!cur) return cur;
          var next = Object.assign({}, cur);
          if (slot === "customWindows") { next.customWindows = Array.isArray(value) ? value : []; return next; }
          var w = Object.assign({}, next[slot] || {});
          if (field === "limit" && (value === "" || value === null)) delete w.limit; else w[field] = value;
          next[slot] = w;
          return next;
        });
      }
      function saveArchive() {
        if (!archProvider || !archWin) return;
        setArchBusy(true);
        var windows = {
          fiveHour: archWin.fiveHour && (archWin.fiveHour.limit !== undefined || archWin.fiveHour.limit !== null) ? { limit: archWin.fiveHour.limit, resetAt: archWin.fiveHour.resetAt || null } : null,
          weekly: archWin.weekly && (archWin.weekly.limit !== undefined || archWin.weekly.limit !== null) ? { limit: archWin.weekly.limit, resetAt: archWin.weekly.resetAt || null } : null,
          customWindows: archWin.customWindows || []
        };
        fetch(API.quotaSync, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: archProvider, windows: windows })
        }).then(function (r) { return r.json(); }).then(function (b) {
          setArchBusy(false);
          if (!b || !b.ok) { setArchErr((b && b.error) || "保存失败"); return; }
          setArchErr("");
          setArchSaved(true);
          setArchProvider(null); // 关闭抽屉；保存成功由服务端即时生效
          load();
        }).catch(function () { setArchBusy(false); setArchErr("保存请求失败"); });
      }
      function resetWindow(windowId) {
        if (!archProvider) return;
        setArchBusy(true);
        fetch(API.quotaReset, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: archProvider, windowId: windowId })
        }).then(function (r) { return r.json(); }).then(function (b) {
          setArchBusy(false);
          if (!b || !b.ok) { setArchErr((b && b.error) || "重置失败"); return; }
          setArchErr("");
          openArchive(archProvider);
        }).catch(function () { setArchBusy(false); setArchErr("重置请求失败"); });
      }
      function toLocalDate(iso) {
        if (!iso) return "";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        var p = function (n) { return (n < 10 ? "0" : "") + n; };
        return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
      }
      function toISO(local) {
        if (!local) return null;
        var d = new Date(local);
        return isNaN(d.getTime()) ? null : d.toISOString();
      }
      var archInputStyle = {
        width: "150px", boxSizing: "border-box", marginRight: "6px",
        border: "1px solid #d0d7de", borderRadius: "6px", padding: "4px 8px", fontSize: "12px"
      };
      function archWindowRow(slot, label) {
        var w = (archWin || {})[slot] || {};
        var has = !!archWin && !!(w && (w.limit !== undefined && w.limit !== null));
        return h("div", { key: "row-" + slot, style: styles.section },
          h("div", { style: styles.row },
            h("span", { style: styles.meta }, label + (has ? "：" : "（未启用）")),
            !has ? h("button", { style: styles.button, onClick: function () { setWindowSlot(slot, "limit", 1000000); } }, "启用") : null),
          has ? h("div", { style: styles.row, key: "ed-" + slot },
            h("input", { style: archInputStyle, type: "number", min: 0, placeholder: "限额", value: w.limit == null ? "" : String(w.limit), onChange: function (e) { setWindowSlot(slot, "limit", e.target.value === "" ? null : Number(e.target.value)); } }),
            h("input", { style: archInputStyle, type: "datetime-local", value: toLocalDate(w.resetAt), onChange: function (e) { setWindowSlot(slot, "resetAt", toISO(e.target.value)); } }),
            h("button", { style: styles.button, disabled: archBusy, onClick: function () { resetWindow(slot); } }, "重置"),
            h("button", { style: styles.button, onClick: function () { setWindowSlot(slot, "limit", null); } }, "删除")) : null);
      }
      function addCustomWindow() {
        setWindowSlot("customWindows", null, ((archWin && archWin.customWindows) || []).concat([{ id: "custom" + ((archWin && archWin.customWindows.length) || 0) + 1, windowMs: 3600000, limit: 1000 }]));
      }
      function setCustomField(idx, field, value) {
        setArchWin(function (cur) {
          if (!cur) return cur;
          var list = (cur.customWindows || []).slice();
          if (field === "remove") { list.splice(idx, 1); return Object.assign({}, cur, { customWindows: list }); }
          var item = Object.assign({}, list[idx] || {});
          if (field === "windowMs") item.windowMs = value === "" ? null : Number(value);
          else if (field === "limit") item.limit = value === "" ? null : Number(value);
          else item[field] = value;
          list[idx] = item;
          return Object.assign({}, cur, { customWindows: list });
        });
      }

      var registry = (props && props.status && props.status.registry) || null;
      var providers = (registry && registry.providers) || [];
      var providerOptions = [];
      providers.forEach(function (p) {
        if (p.dormant) return;
        (p.models || []).forEach(function (mo) {
          providerOptions.push({ provider: p.provider, model: mo.id });
        });
      });
      var last = snap && snap.last;
      var rows = (last && Array.isArray(last.targets)) ? last.targets : [];
      var children = [];
      children.push(
        h("div", { key: "mt-hdr", style: styles.section },
          h("div", { style: styles.sectionTitle }, "模型全自动测试"),
          h("div", { style: styles.meta },
            "对指定 (provider×model) 串行跑 probe→rpm→context→quotaGroup 四相，产 verdict（首选/备用/排除）" +
            "并落盘 json+md 报告，可一键桥接进规则路由。"),
          h("div", { style: styles.row, key: "mt-toolbar" },
            snap ? h("span", { style: styles.meta },
              (snap.running ? "● 正在运行" : "空闲") + (last ? " · 上次 runId " + (last.runId || "—") : "")) : null,
            h("button", { style: styles.button, disabled: busy, onClick: function () { load(); } }, busy ? "处理中…" : "刷新"),
            h("button", {
              style: styles.button,
              disabled: busy || (snap && snap.running),
              onClick: function () { setFormOpen(!formOpen); }
            }, formOpen ? "收起新建表单" : "＋ 新建测试")))
      );

      if (err) {
        children.push(h("div", { key: "mt-err", style: Object.assign({}, styles.section, { color: "#c42b1c" }) }, err));
      }

      if (formOpen) {
        var ff = h("div", { key: "mt-form", style: styles.section },
          h("div", { style: styles.sectionTitle }, "新建测试（free tier 默认；不选则对全部模型跑）"),
          h("div", { style: styles.row },
            h("select", {
              style: styles.narrowSelect,
              value: selProvider,
              onChange: function (ev) { setSelProvider(ev.target.value); setSelModel(""); }
            }, [h("option", { key: "__all", value: "" }, "全部 provider")].concat(providers.filter(function (p) { return !p.dormant; }).map(function (p) {
              return h("option", { key: p.provider, value: p.provider }, p.provider);
            }))),
            h("select", {
              style: styles.narrowSelect,
              value: selModel,
              disabled: !selProvider,
              onChange: function (ev) { setSelModel(ev.target.value); }
            }, [h("option", { key: "__any", value: "" }, selProvider ? "该 provider 全部模型" : "先选 provider")].concat(
              providers.filter(function (p) { return p.provider === selProvider && !p.dormant; }).length
                ? providers.filter(function (p) { return p.provider === selProvider && !p.dormant; })[0].models.map(function (mo) {
                    return h("option", { key: mo.id, value: mo.id }, mo.id);
                  })
                : []))),
          h("div", { style: styles.row, key: "mt-submit" },
            h("button", { style: styles.button, disabled: busy, onClick: function () {
              setBusy(true);
              var targets = providerOptions
                .filter(function (o) { return (!selProvider || o.provider === selProvider) && (!selModel || o.model === selModel); })
                .map(function (o) { return { provider: o.provider, model: o.model, tier: "free" }; });
              if (!targets.length) { setBusy(false); setErr("无可用模型，请先在「可切换模型」页刷新看是否已装配"); return; }
              fetch(API.modelTest, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ targets: targets })
              }).then(function (r) { return r.json(); }).then(function (b) {
                setBusy(false);
                if (!b || !b.ok) { setErr((b && b.error) || "启动失败"); return; }
                setErr("");
                setFormOpen(false);
                load();
              }).catch(function () { setBusy(false); setErr("启动请求失败"); });
            } }, busy ? "启动中…" : "启动测试"),
            h("span", { style: styles.meta }, "仅测 free tier，不烧付费 token。")));
        children.push(ff);
      }

      // 最近一次报告 / 选中的历史报告：targets 结论 + 桥接按钮
      var displayRows = selRun ? (Array.isArray(selRun.targets) ? selRun.targets : []) : rows;
      var displayTitle = selRun
        ? ("历史报告 · " + selRun.runId + (selRun.aborted ? "（已中断）" : ""))
        : (last ? "最近一次报告 · " + (last.runId || "—") + (last.aborted ? "（已中断）" : "") : null);
      if (displayTitle) {
        children.push(
          h("div", { key: "mt-last", style: styles.section },
            h("div", { style: styles.sectionTitle }, displayTitle),
            displayRows.length === 0
              ? h("div", { style: styles.meta }, "本次跑批无完成样本（可能被中断）")
              : h("table", { style: styles.table },
                  h("thead", null, h("tr", null,
                    h("th", { style: styles.th }, "模型"),
                    h("th", { style: styles.th }, "probe"),
                    h("th", { style: styles.th }, "RPM"),
                    h("th", { style: styles.th }, "Context"),
                    h("th", { style: styles.th }, "verdict"),
                    h("th", { style: styles.th }, "分"),
                    h("th", { style: styles.th }, "操作"))),
                  h("tbody", null, displayRows.map(function (tr) {
                    var v = tr.verdict || { recommend: "—", score: null };
                    var vcolor = v.recommend === "primary" ? "#1dc981" : v.recommend === "backup" ? "#0969da" : "#e8463a";
                    var probe = tr.probe ? (tr.probe.ok ? "OK" : "FAIL(" + (tr.probe.errorCode || "?") + ")") : "—";
                    var rpm = (tr.rpm && tr.rpm.lastOkRpm != null) ? tr.rpm.lastOkRpm : "—";
                    var ctx = (tr.context && tr.context.maxAccepted != null) ? String(tr.context.maxAccepted) + "t" : "—";
                    var cells = [
                      h("td", { style: styles.td }, h("span", { style: styles.mono }, (tr.provider || "?") + " / " + (tr.model || "?"))),
                      h("td", { style: styles.td }, h("span", { style: { color: tr.probe && tr.probe.ok ? "#1a7f37" : "#c42b1c" } }, probe)),
                      h("td", { style: styles.td }, String(rpm)),
                      h("td", { style: styles.td }, ctx),
                      h("td", { style: styles.td }, h("span", { style: Object.assign({}, styles.badge, { color: vcolor, background: vcolor === "#e8463a" ? "#fde7e7" : vcolor === "#0969da" ? "#e8f2fe" : "#e8f7ec" }) }, v.recommend)),
                      h("td", { style: styles.td }, v.score != null ? v.score.toFixed(2) : "—"),
                      h("td", { style: styles.td }, h("div", { style: styles.row },
                        h("button", { style: styles.button, disabled: busy, onClick: function () { openArchive(tr.provider); } }, "档案"),
                        h("button", { style: styles.button, disabled: busy, onClick: function () { bridge(tr, "primary"); } }, "首选"),
                        h("button", { style: styles.button, disabled: busy, onClick: function () { bridge(tr, "backup"); } }, "备用"),
                        h("button", { style: styles.button, disabled: busy, onClick: function () { bridge(tr, "exclude"); } }, "排除")))
                    ];
                    return h("tr", { key: (tr.provider || "") + "/" + (tr.model || "") }, cells);
                  })))));
      }

      // 历史报告列表
      children.push(
        h("div", { key: "mt-hist", style: styles.section },
          h("div", { style: styles.sectionTitle }, "历史报告"),
          (!list || list.length === 0)
            ? h("div", { style: styles.meta }, "暂无历史报告（跑完一次后在此列出）")
            : h("table", { style: styles.table },
                h("thead", null, h("tr", null,
                  h("th", { style: styles.th }, "runId"),
                  h("th", { style: styles.th }, "开始"),
                  h("th", { style: styles.th }, "模型数"),
                  h("th", { style: styles.th }, "状态"))),
                h("tbody", null, list.map(function (m) {
                  return h("tr", {
                    key: m.runId,
                    style: Object.assign({ cursor: "pointer" }, selRun && selRun.runId === m.runId ? { background: "#f0f6ff" } : null),
                    onClick: function () {
                      setSelRun({ runId: m.runId, targets: m.targets || [], aborted: !!m.aborted });
                      setErr("");
                    }
                  }, h("td", { style: styles.td }, h("span", { style: styles.mono }, m.runId)),
                    h("td", { style: styles.td }, m.startedAt ? new Date(m.startedAt).toLocaleString() : "—"),
                    h("td", { style: styles.td }, String(m.targetCount != null ? m.targetCount : "—")),
                    h("td", { style: styles.td }, m.aborted ? "已中断" : "完成"));
                })))));

      // v0.9.5 §11 模型档案抽屉（overlay）
      if (archProvider) {
        var archRows = [];
        var archBody;
        if (archWin) {
          archBody = h("div", null,
            archWindowRow("fiveHour", "5 小时限额"),
            archWindowRow("weekly", "1 周限额"),
            h("div", { key: "row-custom", style: styles.section },
              h("div", { style: styles.row },
                h("span", { style: styles.meta }, "自定义窗口"),
                h("button", { style: styles.button, onClick: addCustomWindow }, "＋ 添加")),
              (archWin.customWindows || []).length === 0
                ? h("div", { style: styles.meta }, "无自定义窗口")
                : archWin.customWindows.map(function (cw, ci) {
                    return h("div", { key: "cw" + ci, style: styles.row },
                      h("input", { style: Object.assign({}, archInputStyle, { width: "90px" }), value: cw.id, onChange: function (e) { setCustomField(ci, "id", e.target.value); } }),
                      h("input", { style: Object.assign({}, archInputStyle, { width: "90px" }), type: "number", placeholder: "毫秒", value: cw.windowMs == null ? "" : String(cw.windowMs), onChange: function (e) { setCustomField(ci, "windowMs", e.target.value); } }),
                      h("input", { style: Object.assign({}, archInputStyle, { width: "90px" }), type: "number", placeholder: "限额", value: cw.limit == null ? "" : String(cw.limit), onChange: function (e) { setCustomField(ci, "limit", e.target.value); } }),
                      h("button", { style: styles.button, disabled: archBusy, onClick: function () { resetWindow("custom:" + cw.id); } }, "重置"),
                      h("button", { style: styles.button, onClick: function () { setCustomField(ci, "remove", true); } }, "删"));
                  })));
        } else {
          archBody = h("div", { style: styles.meta }, "加载窗口信息…");
        }
        archRows.push(h("div", { key: "arch-windows" }, archBody));
        archRows.push(
          archErr ? h("div", { key: "arch-err", style: { color: "#c42b1c", margin: "6px 0" } }, archErr) : null,
          archSaved ? h("div", { key: "arch-ok", style: { color: "#1a7f37", margin: "6px 0" } }, "已保存并即时生效") : null,
          h("div", { key: "arch-actions", style: styles.row },
            h("button", { style: styles.button, disabled: archBusy || !archWin, onClick: saveArchive }, archBusy ? "处理中…" : "保存"),
            h("button", { style: styles.button, onClick: function () { setArchProvider(null); } }, "关闭")));
        children.push(
          h("div", { key: "arch-overlay", style: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.35)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "60px 16px", overflow: "auto" } },
            h("div", { style: { background: "#fff", border: "1px solid #d0d7de", borderRadius: "10px", maxWidth: "620px", width: "100%", padding: "18px 20px", boxShadow: "0 8px 30px rgba(0,0,0,0.2)" } },
              h("div", { style: styles.sectionTitle }, "模型档案 · " + archProvider),
              h("div", { style: styles.meta }, "窗口限额：某窗口耗尽后 wrapper 主动避让、不打上游；留空 limit = 不限制。重置按钮清零 used 并重算 resetAt。"),
              archRows)));
      }

      return h("div", { key: "mt-panel" }, children);
    }

    var CLAIM_KEY = "__dsh_model_router_panel_mounted__";
    function claimApply() {
      if (globalThis[CLAIM_KEY]) return false;
      globalThis[CLAIM_KEY] = true;
      return true;
    }
    function releaseApply() {
      globalThis[CLAIM_KEY] = false;
    }

    var inject = ["slots"];

    function apply(ctx) {
      if (!claimApply()) return;
      ctx.effect(function () { return releaseApply; }, "model-router: apply claim");
      ctx.slots.inject("web-ui.plugin.item", function () {
        try {
          var unregister = ctx.slots.register({
            name: "web-ui.plugin.item",
            id: "web-ui-model-router",
            order: 135,
            label: function () { return "模型路由"; }
          }, ModelRouterPanel);
          return function () { unregister(); };
        } catch {
          return function () {};
        }
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
