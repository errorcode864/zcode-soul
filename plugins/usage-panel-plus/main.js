// usage-panel-plus v0.8.3：composer 下方双统计 pill，样式与交互对齐 deepseek harness
// StatsPills（仪表 pill：N 轮 · N tok/s →「会话统计」；数据库 pill：N tok · 缓存命中 N%
// →「Token 用量」）。点击开关对话框（互斥），点击外部/Esc 关闭，面板锚在 pill 上方。
// 配色用宿主 --color-* 变量，深浅色随应用主题自动跟随，深色值为变量缺失时的兜底。
// 数据来源：本地统计服务 /stats/stream（SSE 推送，请求完成即更新，空闲零请求），
// 连接不可用时退回低频轮询；重挂跟随 React 重建事件（MutationObserver），2 秒定时仅兜底。
// 会话隔离：请求携带当前激活会话 ID（DOM [data-session-id]，缺失时由运行时共享工具
// 回退 localStorage zcode-v4-last-session 每工作区键），推送帧按会话校验，
// 会话切换时清空旧数据并重建数据通道，杜绝不同会话数据串台。
// 通用工具（会话读取/数据校验/格式化）来自注入运行时 window.__zcodeSoul.shared。
// 原生「上下文容量」弹层不改动。
(function () {
    "use strict";
    var VERSION = "0.8.3";
    var ID = "usage-panel-plus";
    var host = window.__zcodeSoul = window.__zcodeSoul || { registry: {} };
    var util = window.__zcodeSoul.shared;

    if (host.registry[ID]) {
        if (host.registry[ID].version === VERSION) {
            if (host.registry[ID].remount) host.registry[ID].remount();
            return;
        }
        try {
            if (host.registry[ID].teardown) host.registry[ID].teardown();
        } catch (err) {}
    }

    var PORT = window.__ZCODE_SOUL_STATS_PORT__ || 9340;
    var STATS_BASE = "http://127.0.0.1:" + PORT + "/stats";
    var ROOT_ID = "zcode-soul-usage-row";
    var PANEL_ID = "zcode-soul-usage-panel";
    var PANEL_MARGIN = 12;
    var PANEL_GAP = 8;

    var style = document.createElement("style");
    style.setAttribute("data-zcode-soul-usage-style", "1");
    style.textContent = [
        "#" + ROOT_ID + "{display:flex;justify-content:center;gap:12px;width:100%;box-sizing:border-box;",
        "min-width:0;max-width:100%;margin-top:8px;font-size:13px;line-height:20px}",
        "#" + ROOT_ID + " .pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;",
        "max-width:100%;padding:1px 8px;border:none;border-radius:24px;background:transparent;",
        "color:var(--color-foreground-subtle,#9aa0a8);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}",
        "#" + ROOT_ID + " .pill svg{width:14px;height:14px;flex:none}",
        "#" + ROOT_ID + " .pill:hover,#" + ROOT_ID + " .pill[aria-expanded='true']{",
        "background:var(--color-hover,rgba(255,255,255,.07));color:var(--color-foreground,#c6cad1)}",
        "#" + ROOT_ID + " .label{min-width:0;overflow:hidden;text-overflow:ellipsis}",
        "#" + ROOT_ID + " .sep{color:var(--color-border,#3a3e46);margin:0 6px}",
        "#" + PANEL_ID + "{position:fixed;z-index:1100;box-sizing:border-box;display:none;",
        "width:max-content;min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));",
        "padding:16px;border:0;border-radius:12px;background:var(--color-popover,#1f2126);",
        "box-shadow:0 8px 28px rgba(0,0,0,.5);font-size:12px;line-height:18px;color:var(--color-foreground,#c6cad1);cursor:default}",
        "#" + PANEL_ID + ".open{display:block}",
        "#" + PANEL_ID + " .title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;",
        "color:var(--color-foreground,#e8eaed);font-weight:500}",
        "#" + PANEL_ID + " .title-rule{margin-bottom:10px;border-top:.5px solid var(--color-border,#33363c)}",
        "#" + PANEL_ID + " .title-value{font-variant-numeric:tabular-nums}",
        "#" + PANEL_ID + " .title-label{display:inline-flex;align-items:center;gap:6px;min-width:0}",
        "#" + PANEL_ID + " .title-label svg{width:14px;height:14px;flex:none}",
        "#" + PANEL_ID + " .details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);",
        "gap:6px 16px;margin:0;color:var(--color-foreground-subtle,#9aa0a8)}",
        "#" + PANEL_ID + " .details dt,#" + PANEL_ID + " .details dd{min-width:0;margin:0}",
        "#" + PANEL_ID + " .details dd{color:var(--color-foreground,#c6cad1);font-variant-numeric:tabular-nums;text-align:right}"
    ].join("");

    // deepseek harness 原版图标（dsh-client-ui-primitives，viewBox 0 0 16 16）
    var ICON_GAUGE = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M3.49 13.26A6.375 6.375 0 1 1 12.51 13.26" stroke="currentColor" stroke-width="1.25"/>' +
        '<path d="M8 8.75L11.4 5.35" stroke="currentColor" stroke-width="1.25"/>' +
        '<circle cx="8" cy="8.75" r="1.55" fill="currentColor"/></svg>';
    var ICON_DATABASE = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<ellipse cx="8" cy="3.6" rx="5.75" ry="2.4" stroke="currentColor" stroke-width="1.25"/>' +
        '<path d="M2.25 3.6V12.3A5.75 2.4 0 0 0 13.75 12.3V3.6" stroke="currentColor" stroke-width="1.25"/>' +
        '<path d="M2.25 7.95A5.75 2.4 0 0 0 13.75 7.95" stroke="currentColor" stroke-width="1.25"/></svg>';

    // 紧凑格式化：来自运行时共享工具（deepseek formatTokens 口径）
    var fmtTokens = util.fmtTokens;
    var fmtExact = util.fmtExact;

    // 统计接口地址：pathSuffix 为 ""（快照）或 "/stream"（推送），携带当前会话 ID
    function statsUrl(pathSuffix) {
        var base = STATS_BASE + (pathSuffix || "");
        var sid = util.currentSessionId();
        return sid ? base + "?session=" + encodeURIComponent(sid) : base;
    }

    // 数据帧归属校验：非当前会话的数据一律丢弃，防止并发会话串台（运行时共享工具，
    // 服务端无 sessionId 字段时退回从 sessionFile 文件名判断）

    // 清理历史实例残留的同 id 节点。走到这里说明页面上已无同版本存活实例（首次注入、
    // 卸载或旧版 teardown 之后），现存行/弹层/样式——含旧实例 teardown 后被其已排队
    // rAF 回调重新挂出的僵尸节点——均已无主，一并移除，避免双份叠加
    var staleNodes = document.querySelectorAll(
        "#" + ROOT_ID + ",#" + PANEL_ID + ",style[data-zcode-soul-usage-style]");
    for (var si = 0; si < staleNodes.length; si++) staleNodes[si].remove();

    var root = document.createElement("div");
    root.id = ROOT_ID;

    var timePill = document.createElement("button");
    timePill.type = "button";
    timePill.className = "pill";
    timePill.setAttribute("aria-haspopup", "dialog");
    timePill.innerHTML = ICON_GAUGE + '<span class="label"></span>';

    var usagePill = document.createElement("button");
    usagePill.type = "button";
    usagePill.className = "pill";
    usagePill.setAttribute("aria-haspopup", "dialog");
    usagePill.innerHTML = ICON_DATABASE + '<span class="label"></span>';

    root.appendChild(timePill);
    root.appendChild(usagePill);

    var panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "dialog");

    var stats = null;
    var openPill = null; // 'time' | 'usage' | null
    var stream = null; // SSE 连接
    var fallbackTimer = null; // SSE 不可用时的低频轮询
    var disposed = false; // teardown 置位：作废已排队的延迟回调，防止旧实例卸载后把自己重新挂回页面

    function sepSpan() {
        var s = document.createElement("span");
        s.className = "sep";
        s.setAttribute("aria-hidden", "true");
        s.textContent = "·";
        return s;
    }
    function setLabel(pill, parts) {
        var label = pill.querySelector(".label");
        label.textContent = parts[0];
        for (var i = 1; i < parts.length; i++) {
            label.appendChild(sepSpan());
            label.appendChild(document.createTextNode(parts[i]));
        }
    }

    function cacheHitText(t) {
        if (t.cacheHitRate == null) return null;
        if (t.inputTokens + t.cacheReadTokens <= 0) return null;
        return Math.round(t.cacheHitRate) + "%";
    }

    function renderPills() {
        var s = stats || {};
        var t = s.totals || {};
        var tps = s.speed && s.speed.avg ? Math.round(s.speed.avg) + " tok/s" : null;
        var timeParts = [(t.requests || 0) + " 轮"];
        if (tps) timeParts.push(tps);
        setLabel(timePill, timeParts);

        var hit = cacheHitText(t);
        var usageParts = [fmtTokens(t.totalTokens) + " tok"];
        if (hit !== null) usageParts.push("缓存命中 " + hit);
        setLabel(usagePill, usageParts);

        timePill.setAttribute("aria-label", timeParts.join(" · "));
        usagePill.setAttribute("aria-label", usageParts.join(" · "));
    }

    function renderPanel() {
        var s = stats || {};
        var t = s.totals || {};
        var hit = cacheHitText(t);
        if (openPill === "time") {
            panel.innerHTML =
                '<div class="title"><span class="title-label">' + ICON_GAUGE + "会话统计</span></div>" +
                '<div class="title-rule" aria-hidden="true"></div>' +
                '<dl class="details">' +
                "<dt>模型用时</dt><dd>" + (s.time ? s.time.modelText : "—") + "</dd>" +
                "<dt>工具调用用时</dt><dd>" + (s.time ? s.time.toolText : "—") + "</dd>" +
                "<dt>请求次数</dt><dd>" + (t.requests || 0) + "</dd>" +
                (s.speed && s.speed.avg
                    ? "<dt>输出速度（TPS）</dt><dd>" + Math.round(s.speed.avg) + " tok/s</dd>"
                    : "") +
                "</dl>";
        } else {
            panel.innerHTML =
                '<div class="title"><span class="title-label">' + ICON_DATABASE + "Token 用量</span>" +
                '<span class="title-value">' + fmtExact(t.totalTokens) + " tok</span></div>" +
                '<div class="title-rule" aria-hidden="true"></div>' +
                '<dl class="details">' +
                (hit !== null ? "<dt>缓存命中</dt><dd>" + hit + "</dd>" : "") +
                "<dt>未缓存输入</dt><dd>" + fmtExact(t.inputTokens) + " tok</dd>" +
                "<dt>缓存读取</dt><dd>" + fmtExact(t.cacheReadTokens) + " tok</dd>" +
                "<dt>输出</dt><dd>" + fmtExact(t.outputTokens) + " tok</dd>" +
                "</dl>";
        }
    }

    // 面板锚在 pill 上方，视口内 clamp（deepseek useAnchoredPosition 同款约束）
    function placePanel() {
        var pill = openPill === "time" ? timePill : usagePill;
        if (!pill) return;
        panel.style.left = "0px";
        panel.style.top = "0px";
        var r = pill.getBoundingClientRect();
        var w = panel.offsetWidth;
        var h = panel.offsetHeight;
        var left = Math.min(Math.max(PANEL_MARGIN, r.left + r.width / 2 - w / 2), window.innerWidth - w - PANEL_MARGIN);
        var top = r.top - h - PANEL_GAP;
        if (top < PANEL_MARGIN) top = Math.min(r.bottom + PANEL_GAP, window.innerHeight - h - PANEL_MARGIN);
        panel.style.left = Math.round(left) + "px";
        panel.style.top = Math.round(top) + "px";
    }

    function closePanel() {
        openPill = null;
        panel.classList.remove("open");
        timePill.setAttribute("aria-expanded", "false");
        usagePill.setAttribute("aria-expanded", "false");
    }

    function openPanel(which) {
        openPill = which;
        renderPanel();
        panel.classList.add("open");
        placePanel();
        timePill.setAttribute("aria-expanded", which === "time" ? "true" : "false");
        usagePill.setAttribute("aria-expanded", which === "usage" ? "true" : "false");
    }

    timePill.addEventListener("click", function () {
        openPill === "time" ? closePanel() : openPanel("time");
    });
    usagePill.addEventListener("click", function () {
        openPill === "usage" ? closePanel() : openPanel("usage");
    });

    function onDocPointerDown(e) {
        if (!openPill) return;
        if (root.contains(e.target) || panel.contains(e.target)) return;
        closePanel();
    }
    function onDocKeyDown(e) {
        if (e.key === "Escape" && openPill) closePanel();
    }
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown);

    function applyStats(s) {
        if (!s || !s.ok) return;
        // 丢弃其他会话的数据帧（SSE 连接建立早于会话切换时可能出现）
        if (!util.isForCurrentSession(s)) return;
        stats = s;
        renderPills();
        if (openPill) {
            renderPanel();
            placePanel();
        }
    }

    function refresh() {
        fetch(statsUrl())
            .then(function (res) { return res.json(); })
            .then(applyStats)
            .catch(function () { /* 服务未就绪时保持占位 */ });
    }

    function startFallbackPolling() {
        if (fallbackTimer) return;
        fallbackTimer = setInterval(refresh, 5000);
    }

    function closeStatsStream() {
        if (stream) {
            try { stream.close(); } catch (err) {}
            stream = null;
        }
    }

    // 数据通道：SSE 推送，服务端在会话记录变化时主动下发；连接即收到当前快照。
    // 连接 URL 携带会话 ID，服务端只为该会话推送数据
    function startStatsStream() {
        if (typeof EventSource === "undefined") {
            startFallbackPolling();
            return;
        }
        try {
            stream = new EventSource(statsUrl("/stream"));
        } catch (err) {
            startFallbackPolling();
            return;
        }
        stream.onmessage = function (event) {
            try { applyStats(JSON.parse(event.data)); } catch (err) { /* 忽略坏帧 */ }
        };
        stream.onerror = function () {
            // 断开时 EventSource 会自动重连；彻底关闭（服务无此路由）时退回轮询
            if (stream && stream.readyState === 2) startFallbackPolling();
        };
    }

    // 输入框卡片（rounded-2xl border，内含 textarea 区 + group/toolbar 工具行）。
    // deepseek 的统计行在输入框卡片外下方独立居中，因此锚定卡片的父容器、插到卡片之后
    function locateComposer() {
        var toolbar = document.querySelector('div[class*="group/toolbar"]');
        var found = toolbar ? toolbar.parentElement : null;
        return found ? { card: found, parent: found.parentElement } : null;
    }

    // 新会话首页（还没有任何消息）不显示统计——deepseek 同款行为：
    // 此时 /stats 只有上一个会话的数据，显示出来是误导。
    // 首选结构信号：草稿态 SessionPane 把 data-session-id 标为 "draft"（上游
    // SessionPane.tsx 的 sessionId ?? "draft"，全仓唯一渲染点），不依赖任何异步内容；
    // 输入框是 Lexical contenteditable，页面无 textarea，文案判定只剩异步加载的
    // 快捷按钮在撑，首页挂载到按钮渲染之间会误判成会话页而闪出 0轮 0tok
    function isNewChatPage() {
        var pane = document.querySelector("[data-session-id]");
        var sid = pane ? pane.getAttribute("data-session-id") : null;
        if (sid) return sid === "draft";
        // 旧版客户端无该属性：退回文案/快捷按钮启发式
        var ta = document.querySelector("textarea");
        if (ta && /向 ZCode 提问|描述你想要/.test(ta.placeholder || "")) return true;
        var shortcuts = ["周报总结", "报错修复", "PPT 制作", "闲时任务"];
        var buttons = document.querySelectorAll("button");
        for (var i = 0; i < buttons.length; i++) {
            if (shortcuts.indexOf((buttons[i].textContent || "").trim()) !== -1) return true;
        }
        return false;
    }

    // 低频清扫（随可见性复核节流）：移除历史实例僵尸回调可能重新挂出的同 id 节点，
    // 本实例是页面唯一存活者，见到他者即无主
    function sweepStale() {
        var nodes = document.querySelectorAll("#" + ROOT_ID + ",#" + PANEL_ID);
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i] !== root && nodes[i] !== panel) nodes[i].remove();
        }
    }

    function updateVisibility() {
        lastVisibilityAt = Date.now();
        sweepStale();
        root.style.display = isNewChatPage() ? "none" : "";
    }

    // 结构快照：快路径只读这几个缓存，全部命中时不发起任何查询与 DOM 操作
    var card = null;
    var lastVisibilityAt = 0;

    function remount() {
        var spot = locateComposer();
        if (spot) {
            card = spot.card;
            // 排在输入框卡片正后方（父容器里还有 absolute 定位的浮层兄弟，不能简单 append）
            if (root.previousElementSibling !== card) {
                if (card.nextSibling) spot.parent.insertBefore(root, card.nextSibling);
                else spot.parent.appendChild(root);
            }
        }
        if (!panel.isConnected) document.body.appendChild(panel);
        if (!style.isConnected) document.head.appendChild(style);
        updateVisibility();
        return root.isConnected;
    }

    // React 会随会话切换重建输入框：结构断了立即重挂；否则只低频复核可见性。
    // 同时侦测会话切换（data-session-id 变化）：清空旧会话数据并重建数据通道
    var lastSessionId = util.currentSessionId();

    function handleSessionChange() {
        stats = null;
        closePanel();
        renderPills();
        // SSE 按连接建立时的会话分流，切换后必须重连；轮询模式下 refresh 动态取当前会话，无需处理
        closeStatsStream();
        startStatsStream();
        refresh();
    }

    function sync() {
        var sid = util.currentSessionId();
        if (sid !== lastSessionId) {
            lastSessionId = sid;
            handleSessionChange();
        }
        if (!root.isConnected || !card || !card.isConnected || root.previousElementSibling !== card) {
            remount();
            return;
        }
        if (Date.now() - lastVisibilityAt >= 250) updateVisibility();
    }

    var syncQueued = false;
    function scheduleSync() {
        if (disposed || syncQueued) return;
        syncQueued = true;
        var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
        raf(function () {
            syncQueued = false;
            if (disposed) return; // teardown 前已入队的回调：实例已卸载，不得再重挂
            try { sync(); } catch (err) { /* 静默失败，不影响宿主页面 */ }
        });
    }

    remount();
    refresh();
    startStatsStream();

    // 观察结构变化即时重挂，替代 1.5s 轮询；事件按帧合并，快路径为 O(1) 属性读取。
    // 同时监听 data-session-id 属性变化：会话容器原地改属性（而非重建节点）时也能触发切换检测
    var observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-session-id"],
    });

    // 低频兜底：会话切换只落在 localStorage（DOM 无 data-session-id 属性的窗口）时
    // MutationObserver 不会触发，定时器保证切换最迟 2 秒被感知并重建数据通道
    var syncTimer = setInterval(scheduleSync, 2000);

    host.registry[ID] = {
        version: VERSION,
        remount: remount,
        teardown: function () {
            disposed = true;
            root.remove();
            panel.remove();
            style.remove();
            document.removeEventListener("pointerdown", onDocPointerDown, true);
            document.removeEventListener("keydown", onDocKeyDown);
            observer.disconnect();
            if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
            closeStatsStream();
            if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
            delete host.registry[ID];
        }
    };
})();
