/**
 * @botton/dsh-model-router 插件浏览器半（client）v0.3。
 *
 * 手写 ModuleLoader 包装格式（无构建链、无 JSX，与 @botton/dsh-guardian 同款）：
 * 注册到 "web-ui.plugin.item" slot（WebUI 插件管理页卡片列表）。
 *
 * v0.3（面板重构）：
 * - 四页签：接入现状 / 切换规则 / 切换日志 / 可切换模型
 * - 作用域结构化编辑：全部会话 / 指定模型 / 指定供应商 / 指定会话（下拉 + 点选，
 *   不再依赖大段说明文字）。会话 ID 来自插件记录的最近活跃会话。
 * - match 多条件为 AND（可组合「某模型 × 某会话」）；带会话限定的规则不参与
 *   会话级提议（dsh agent/request 载荷不含 sessionId，平台事实）。
 * - 追加候选下拉限宽；保存成功清 dirty。
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
      probe: "/api/model-router/probe"
    };
    var POLL_INTERVAL_MS = 5000;

    var STRATEGY_LABELS = {
      explicit: "手工列表（按下方顺序）",
      "same-model": "同模型跨供应商（自动）",
      "same-provider": "同供应商换模型（自动）",
      "exclude-current": "排除当前·注册表全部（自动）"
    };

    var TABS = [
      { key: "overview", label: "接入现状" },
      { key: "rules", label: "切换规则" },
      { key: "logs", label: "切换日志" },
      { key: "models", label: "可切换模型" }
    ];

    var styles = {
      card: {
        border: "1px solid #d0d7de",
        borderRadius: "8px",
        padding: "16px",
        maxWidth: "760px",
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
      tabbar: { display: "flex", gap: "2px", borderBottom: "1px solid #d0d7de", margin: "4px 0 12px" },
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
      divider: { borderTop: "1px solid #eaeef2", margin: "10px 0" }
    };

    function routeBadge(converged) {
      return converged
        ? { text: "链耗尽收敛中", color: "#9a6700", bg: "#fff8c5" }
        : { text: "正常监听", color: "#1a7f37", bg: "#dafbe1" };
    }

    function proposeBadge(propose) {
      return propose
        ? { text: "开场改派：开", color: "#0969da", bg: "#ddf4ff" }
        : { text: "开场改派：关（仅故障切换）", color: "#57605a", bg: "#eaeef2" };
    }

    function modeBadge(mode) {
      var text = mode === "stable" ? "模式：稳定优先" : mode === "fast" ? "模式：极速优先" : "模式：平衡";
      var color = mode === "stable" ? "#0969da" : mode === "fast" ? "#9a6700" : "#57605a";
      var bg = mode === "stable" ? "#ddf4ff" : mode === "fast" ? "#fff8c5" : "#eaeef2";
      return { text: text, color: color, bg: bg };
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

    function providerLabel(p) {
      return p.displayName && p.displayName !== p.provider
        ? p.provider + "（" + p.displayName + "）"
        : p.provider;
    }

    /** 规则 match → 短文案（结构化作用域的只读呈现） */
    function matchText(m) {
      if (!m) return "";
      if (m.default) return "全部会话";
      var parts = [];
      if (m.provider) parts.push("供应商 = " + m.provider);
      if (m.model) parts.push("模型 = " + m.model);
      if (Array.isArray(m.sessionIds)) parts.push(m.sessionIds.length ? "会话 ×" + m.sessionIds.length : "会话（未添加，暂不命中）");
      if (m.hours && m.hours.start && m.hours.end) parts.push("时间 " + m.hours.start + "–" + m.hours.end);
      return parts.length ? parts.join(" 且 ") : "未限定";
    }

    /** 规则 match → 作用域下拉值 */
    function scopeOf(m) {
      if (!m) return "all";
      if (m.default) return "all";
      // 关键：sessionIds 键存在即视为「指定会话」进行中——哪怕是空数组。
      // setScope("session") 先写入空数组、用户再逐个添加会话；若这里要求
      // length>0，切换后首次重渲染下拉就会弹回「全部会话」（v0.4.1 修复）。
      var hasSids = Array.isArray(m.sessionIds);
      var dims =
        (m.provider ? 1 : 0) +
        (m.model ? 1 : 0) +
        (hasSids && m.sessionIds.length ? 1 : 0);
      if (dims > 1) return "custom";
      if (hasSids) return "session";
      if (m.provider) return "provider";
      if (m.model) return "model";
      return "all";
    }

    var SCOPE_LABELS = {
      all: "生效范围：全部会话",
      model: "生效范围：指定模型…",
      provider: "生效范围：指定供应商…",
      session: "生效范围：指定会话…",
      custom: "生效范围：自定义组合"
    };

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
      var s6 = useState("overview");
      var activeTab = s6[0];
      var setActiveTab = s6[1];
      var mountedRef = useRef(true);

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

      useEffect(function () {
        mountedRef.current = true;
        refresh();
        var timer = setInterval(refresh, POLL_INTERVAL_MS);
        return function () {
          mountedRef.current = false;
          clearInterval(timer);
        };
      }, [refresh]);

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
        fetch(API.state, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ propose: edit.propose, rules: edit.rules, timeZone: edit.timeZone ? edit.timeZone : null, mode: edit.mode || "balanced" })
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
      function setRuleMatch(ri, match) {
        mutate(function (next) { next.rules[ri].match = match; });
      }
      function setScope(ri, scope) {
        var current = edit && edit.rules[ri] ? edit.rules[ri].match || {} : {};
        if (scope === "all") { setRuleMatch(ri, { default: true }); return; }
        if (scope === "model") {
          var keepModel = current.model || (modelOptions.length > 0 ? modelOptions[0].model : undefined);
          setRuleMatch(ri, { model: keepModel });
          return;
        }
        if (scope === "provider") {
          var keepProvider = current.provider || (providerOptions.length > 0 ? providerOptions[0].provider : undefined);
          setRuleMatch(ri, { provider: keepProvider });
          return;
        }
        if (scope === "session") {
          setRuleMatch(ri, { sessionIds: current.sessionIds || [] });
          return;
        }
        // custom（v0.4.2）：自定义组合 = ≥2 个条件同时满足。预填 供应商×模型 两个
        // 维度（缺失的用注册表首项补），保证 scopeOf 判为 custom、下拉不再弹回；
        // 会话维度可继续在 custom 编辑器里追加。注册表未就绪时退回「全部会话」防空 match。
        if (scope === "custom") {
          var cProvider = current.provider || (providerOptions.length > 0 ? providerOptions[0].provider : undefined);
          var cModel = current.model || (modelOptions.length > 0 ? modelOptions[0].model : undefined);
          var nextMatch = {};
          if (cProvider) nextMatch.provider = cProvider;
          if (cModel) nextMatch.model = cModel;
          if (Array.isArray(current.sessionIds) && current.sessionIds.length > 0) nextMatch.sessionIds = current.sessionIds;
          if (!nextMatch.provider && !nextMatch.model && !nextMatch.sessionIds) nextMatch = { default: true };
          setRuleMatch(ri, nextMatch);
          return;
        }
      }
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
      /** 时间窗单边设置（v0.5.0）：清空一侧且另一侧也空 → 整个移除 hours 条件 */
      function setHours(ri, side, v) {
        mutate(function (next) {
          var mm = next.rules[ri].match = next.rules[ri].match || {};
          var hours = Object.assign({}, mm.hours || {});
          if (v) hours[side] = v; else delete hours[side];
          if (!hours.start && !hours.end) delete mm.hours;
          else mm.hours = hours;
        });
      }
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
          next.rules.push({ match: { model: seed.model }, strategy: "explicit", route: [seed] });
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
          h("span", { style: Object.assign({}, styles.badge, proposeBadge(status && status.config && status.config.propose)) }),
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
        // ============ 页签 1：接入现状 ============
        if (activeTab === "overview") {
          children.push(
            h("div", { key: "ov", style: styles.section },
              h("div", { style: styles.sectionTitle }, "已接入的模型供应商"),
              activeProviders.length === 0
                ? h("div", { style: styles.meta }, "尚未取到——等待目录刷新（默认 5 分钟周期）")
                : activeProviders.map(function (p) {
                    return h("div", { key: p.provider, style: styles.row },
                      h("span", { style: styles.mono }, providerLabel(p)),
                      h("span", { style: styles.meta },
                        p.models.length > 0
                          ? p.models.map(function (mo) { return mo.id; }).join("、")
                          : "模型目录未就绪"));
                  }))
          );
          children.push(
            h("div", { key: "ov-chain", style: styles.section },
              h("div", { style: styles.sectionTitle }, "当前生效的切换规则"),
              (edit.rules || []).length === 0
                ? h("div", { style: styles.meta }, "未配置规则——纯透传模式（不改任何行为）")
                : edit.rules.map(function (rule, ri) {
                    var chain = (rule.route || []).map(function (hop) {
                      var p = registry.providers.find(function (x) { return x.provider === hop.provider; });
                      return hop.provider +
                        (p && p.displayName && p.displayName !== hop.provider ? "（" + p.displayName + "）" : "") +
                        "/" + hop.model;
                    }).join("  →  ");
                    return h("div", { key: "c" + ri, style: { marginBottom: "6px" } },
                      h("div", { style: styles.meta },
                        "规则 " + (ri + 1) + " · " + matchText(rule.match) + " · " + (STRATEGY_LABELS[rule.strategy || "explicit"])),
                      h("div", { style: styles.mono }, chain || "（无候选）"));
                  }),
              h("div", { style: styles.hint }, "详细编辑见「切换规则」页签"))
          );
          var w0 = status.wrapper || {};
          children.push(
            h("div", { key: "ov-stats", style: styles.section },
              h("div", { style: styles.sectionTitle }, "运行统计"),
              h("div", { style: styles.meta },
                "包装调用 " + fmtInt(w0.wraps) + " · 透传 " + fmtInt(w0.passthroughs) +
                " · 故障切换 " + fmtInt(w0.failovers) + " · 看门狗超时 " + fmtInt(w0.timeouts) +
                " · 链耗尽 " + fmtInt(w0.exhaustions) + " · 用户取消 " + fmtInt(w0.userAborts)))
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
              (edit.rules || []).length === 0
                ? h("div", { style: styles.meta, key: "none" }, "无规则——纯透传模式")
                : edit.rules.map(function (rule, ri) {
                    var scope = scopeOf(rule.match || {});
                    var m = rule.match || {};
                    return h("div", { key: "r" + ri, style: styles.ruleCard },
                      // 行 1：作用域
                      h("div", { style: styles.row, key: "cfg" + ri },
                        h("select", {
                          style: styles.narrowSelect,
                          value: scope,
                          onChange: function (ev) { setScope(ri, ev.target.value); }
                        }, Object.keys(SCOPE_LABELS).map(function (k) {
                          return h("option", { key: k, value: k }, SCOPE_LABELS[k]);
                        }))),
                      // 行 2：作用域细节（custom = 三类编辑器同时显示，自由组合；
                      // 某个下拉选回占位项即清除该条件，v0.4.2）
                      (scope === "model" || scope === "custom")
                        ? h("div", { style: styles.row, key: "mm" + ri },
                            h("span", { style: styles.meta }, "模型："),
                            h("select", {
                              style: styles.narrowSelect,
                              value: m.model || "",
                              onChange: function (ev) {
                                var v = ev.target.value || undefined;
                                setRuleMatch(ri, Object.assign({}, m, { default: false, model: v }));
                              }
                            }, [h("option", { key: "ph", value: "" }, "选择模型…")].concat(
                              modelOptions.map(function (o) {
                                return h("option", { key: o.provider + "/" + o.model, value: o.model }, o.label);
                              }))))
                        : null,
                      (scope === "provider" || scope === "custom")
                        ? h("div", { style: styles.row, key: "mp" + ri },
                            h("span", { style: styles.meta }, "供应商："),
                            h("select", {
                              style: styles.narrowSelect,
                              value: m.provider || "",
                              onChange: function (ev) {
                                var v = ev.target.value || undefined;
                                setRuleMatch(ri, Object.assign({}, m, { default: false, provider: v }));
                              }
                            }, [h("option", { key: "ph", value: "" }, "选择供应商…")].concat(
                              providerOptions.map(function (o) {
                                return h("option", { key: o.provider, value: o.provider }, o.label);
                              }))))
                        : null,
                      (scope === "session" || scope === "custom")
                        ? h("div", { key: "ms" + ri },
                            h("div", { style: styles.row },
                              (m.sessionIds || []).length === 0
                                ? h("span", { style: styles.meta }, "尚未指定会话（不加会话 = 该维度不限定）")
                                : (m.sessionIds || []).map(function (sid) {
                                    return h("span", { key: sid, style: styles.chip, title: sessionTitleById[sid] ? sessionTitleById[sid] + "（" + sid + "）" : sid },
                                      sessionLabel(sid),
                                      h("button", {
                                        style: { border: "none", background: "transparent", cursor: "pointer", padding: "0 2px", color: "#cf222e" },
                                        onClick: function () {
                                          setRuleMatch(ri, Object.assign({}, m, {
                                            sessionIds: m.sessionIds.filter(function (x) { return x !== sid; })
                                          }));
                                        }
                                      }, "✕"));
                                })),
                            h("div", { style: styles.row },
                              recentSessions.length > 0
                                ? h("select", {
                                    style: styles.narrowSelect,
                                    value: "",
                                    onChange: function (ev) {
                                      var v = ev.target.value;
                                      if (!v) return;
                                      var cur = edit.rules[ri].match || {};
                                      var sids = (cur.sessionIds || []).slice();
                                      if (sids.indexOf(v) === -1) sids.push(v);
                                      setRuleMatch(ri, Object.assign({}, cur, { sessionIds: sids }));
                                      ev.target.value = "";
                                    }
                                  }, [h("option", { key: "ph", value: "" }, "＋ 从最近活跃会话点选…")].concat(
                                    recentSessions.map(function (s) {
                                      var label = s.title
                                        ? (s.title.length > 24 ? s.title.slice(0, 24) + "…" : s.title) + "（" + s.id.slice(0, 10) + "…）"
                                        : s.id;
                                      return h("option", { key: s.id, value: s.id }, label);
                                    })))
                                : h("span", { style: styles.meta }, "暂无捕捉到的会话（服务重启后清零）——发起一次对话后回来点选"),
                              h("input", {
                                style: styles.input,
                                placeholder: "或粘贴完整会话 ID"
                              }),
                              h("button", {
                                style: styles.button,
                                onClick: function (ev) {
                                  // 就近取本规则的输入框（多规则并存时不能共用 ref）
                                  var input = ev.target.parentElement
                                    ? ev.target.parentElement.querySelector("input")
                                    : null;
                                  var v = input ? input.value.trim() : "";
                                  if (!v) return;
                                  var cur = edit.rules[ri].match || {};
                                  var sids = (cur.sessionIds || []).slice();
                                  if (sids.indexOf(v) === -1) sids.push(v);
                                  setRuleMatch(ri, Object.assign({}, cur, { sessionIds: sids }));
                                  if (input) input.value = "";
                                }
                              }, "添加")))
                        : null,
                      scope === "custom"
                        ? h("div", { style: styles.warn, key: "mc" + ri },
                            "自定义组合：" + matchText(m) + "（多条件同时满足才命中）")
                        : null,
                      // 行 3：策略
                      h("div", { style: styles.row, key: "strat" + ri },
                        h("span", { style: styles.meta }, "切换逻辑："),
                        h("select", {
                          style: styles.narrowSelect,
                          value: rule.strategy || "explicit",
                          onChange: function (ev) { setStrategy(ri, ev.target.value); }
                        }, Object.keys(STRATEGY_LABELS).map(function (k) {
                          return h("option", { key: k, value: k }, STRATEGY_LABELS[k]);
                        }))),
                      // 行 3.5：时间窗（v0.5.0，峰谷定价，可选；所有作用域均可叠加）
                      h("div", { style: styles.row, key: "tw" + ri },
                        h("span", { style: styles.meta }, "时间窗（峰谷定价，可选）："),
                        h("input", {
                          type: "time", style: { width: "110px" },
                          value: (m.hours && m.hours.start) || "",
                          onChange: function (ev) { setHours(ri, "start", ev.target.value); }
                        }),
                        h("span", { style: styles.meta }, "→"),
                        h("input", {
                          type: "time", style: { width: "110px" },
                          value: (m.hours && m.hours.end) || "",
                          onChange: function (ev) { setHours(ri, "end", ev.target.value); }
                        }),
                        (m.hours && m.hours.start && m.hours.end)
                          ? h("span", { style: styles.meta }, "仅窗口内命中，跨零点自动支持")
                          : h("span", { style: styles.meta }, "不填 = 全天生效")),
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
                      // 行 5：追加候选（限宽）
                      // 行 5：追加候选（v0.4.2：按作用域过滤——指定供应商只列该供应商
                      // 的模型；指定模型只列该模型跨供应商条目；其余范围列全部）
                      (function () {
                        var phLabel = "＋ 追加候选…";
                        if (scope === "provider" && m.provider) phLabel = "＋ 追加候选（仅 " + m.provider + " 的模型）…";
                        if (scope === "model" && m.model) phLabel = "＋ 追加候选（仅模型 " + m.model + "，跨供应商）…";
                        var hopPool = activeProviders
                          .filter(function (p) { return p.models.length > 0; })
                          .flatMap(function (p) {
                            return p.models
                              .filter(function (mo) {
                                if (scope === "provider" && m.provider) return p.provider === m.provider;
                                if (scope === "model" && m.model) return mo.id === m.model;
                                return true;
                              })
                              .map(function (mo) {
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
                          }, [h("option", { key: "ph", value: "" }, phLabel)].concat(hopPool)),
                          hopPool.length === 0
                            ? h("span", { style: styles.warn }, "当前作用域下无可追加候选——请检查作用域选择或注册表目录")
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
            h("label", { key: "propose", style: styles.row },
              h("input", {
                type: "checkbox",
                checked: !!edit.propose,
                onChange: function (ev) {
                  var v = ev.target.checked;
                  setEdit(function (prev) { return Object.assign({}, prev, { propose: v, dirty: true }); });
                }
              }),
              h("span", null, "开场改派模型（新对话开始时，按上方规则自动改用规则指定的首个模型；关 = 不主动改模型，只在报错时切换）")),
            h("div", { key: "proposeHint", style: styles.hint },
              "两种工作方式：① 故障切换（始终生效）——对话进行中某模型报错（429 限额/超时/断流），自动换链上下一个模型重试，回答不中断；" +
              "② 开场改派（本开关）——点「发送」的那一刻就按规则把请求派给规则指定的模型，而不是用会话当前选中的模型。" +
              "只想「坏了才换」就把开关关着；想「每次都从规则链首开始」就打开。"),
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

        // ============ 页签 3：切换日志 ============
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
          var probeEntries = status.probe ? Object.entries(status.probe.entries || {}) : [];
          children.push(
            h("div", { key: "probe", style: styles.section },
              h("div", { style: styles.sectionTitle },
                "健康探测" + (status.probe && status.probe.enabled ? "" : "（周期未开启，点「立即探测」可手动跑一轮）")),
              probeEntries.length === 0
                ? h("div", { style: styles.meta }, "暂无探测记录")
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
                h("span", { style: styles.meta }, "探测结果作为候选排序的健康度参考（down 排末、延迟低优先）"))),
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
      }

      children.push(
        h("div", { key: "btn", style: { marginTop: "8px" } },
          h("button", { style: styles.button, onClick: function () { refresh(); } }, "立即刷新"))
      );

      return h("div", { style: styles.card }, children);
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
