// usage-popup-plus v0.5.2：在原生「上下文容量」弹层内追加会话用量统计区块（灵感来源：pi-desktop）。
// 优化：内存常驻预热 + 跨插件数据共享 + rAF 合并注入（MutationObserver 回调内不改 DOM）。
// 会话隔离：请求携带当前激活会话 ID（DOM [data-session-id]，缺失时由运行时共享工具
// 回退 localStorage zcode-v4-last-session 每工作区键），推送帧按会话校验，
// 会话切换时清空旧数据并重建数据通道，杜绝不同会话数据串台。
// 通用工具（会话读取/数据校验/格式化）来自注入运行时 window.__zcodeSoul.shared。
(function () {
    "use strict";
    var ID = "usage-popup-plus";
    var host = window.__zcodeSoul = window.__zcodeSoul || {};
    host.registry = host.registry || {};
    var util = window.__zcodeSoul.shared;

    var VERSION = "0.5.2";
    if (host.registry[ID]) {
        if (host.registry[ID].version !== VERSION && host.registry[ID].teardown) {
            try { host.registry[ID].teardown(); } catch (e) {}
        } else {
            if (host.registry[ID].remount) host.registry[ID].remount();
            return;
        }
    }

    var PORT = window.__ZCODE_SOUL_STATS_PORT__ || 9340;
    var STATS_BASE = "http://127.0.0.1:" + PORT + "/stats";
    var STREAM_BASE = STATS_BASE + "/stream";
    var SECTION_ATTR = "data-zcode-soul-section";
    var CONTAINER_ATTR = "data-zcode-soul-container";

    // 行标签双语表：默认中文，弹层出现英文文案时切换
    var LABELS = {
        zh: {
            title: "会话用量",
            total: "本轮合计",
            speed: "生成速度",
            session: "会话耗时",
            model: "模型响应耗时",
            tool: "工具调用耗时",
            usage: "模型用量",
            reasoning: "推理（估算）",
            calls: "工具调用",
            subagent: "子代理",
            remaining: "剩余 tokens"
        },
        en: {
            title: "Session usage",
            total: "Total this session",
            speed: "Output speed",
            session: "Session time",
            model: "Model time",
            tool: "Tool time",
            usage: "Token usage",
            reasoning: "Reasoning (est.)",
            calls: "Tool calls",
            subagent: "Subagents",
            remaining: "Remaining tokens"
        }
    };

    // 当前激活会话 ID：运行时共享工具从 [data-session-id] 节点读取
    // 统计快照地址：带 subagents 明细，携带当前会话 ID
    function statsUrl() {
        var sid = util.currentSessionId();
        var q = "?subagents=1";
        if (sid) q += "&session=" + encodeURIComponent(sid);
        return STATS_BASE + q;
    }

    // 推送流地址：携带当前会话 ID，服务端只为该会话推送数据
    function streamUrl() {
        var sid = util.currentSessionId();
        return sid ? STREAM_BASE + "?session=" + encodeURIComponent(sid) : STREAM_BASE;
    }

    // 数据帧归属校验：非当前会话的数据一律丢弃，防止并发会话串台（运行时共享工具）

    // 跨插件共享快照：记录归属会话，读取时校验，避免复用到别的会话
    function loadShared() {
        var cached = host.sharedStats;
        if (!cached || !cached.data) return null;
        if (cached.sessionId && cached.sessionId !== util.currentSessionId()) return null;
        return cached.data;
    }
    function saveShared(data) {
        host.sharedStats = { sessionId: util.currentSessionId(), data: data, at: Date.now() };
    }

    var shared = loadShared();
    var stats = shared || null;          // 优先复用同会话的全局已有快照
    var statsAt = (host.sharedStats && host.sharedStats.at) || (stats ? Date.now() : 0);
    var lastSessionId = util.currentSessionId();
    var inFlight = false;                 // 防止并发抓取
    var stream = null;                    // SSE 连接
    var refreshTimer = null;              // 后台静默刷新计时器

    // 紧凑格式化：来自运行时共享工具；百分比本插件专用
    var fmtTokens = util.fmtTokens;
    var fmtExact = util.fmtExact;
    function fmtPct(value) {
        return (Math.round(value * 10) / 10) + "%";
    }

    // 弹层根：class 含 !w-80 的 popover 容器
    function findPopup() {
        var nodes = document.getElementsByClassName("!w-80");
        if (!nodes || !nodes.length) {
            nodes = document.querySelectorAll("div[class*='!w-80']");
        }
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (el.getAttribute(CONTAINER_ATTR) || el.querySelector("[" + SECTION_ATTR + "]")) return el;
            // 尚未注入过的弹层需确认是「上下文容量」而非其他 !w-80 弹层
            if (findAnchor(el)) return el;
        }
        return null;
    }

    // 注入锚点：优先「平均缓存命中率」行，回退「上下文来源」明细块
    function findAnchor(popup) {
        var nodes = popup.querySelectorAll("span,div");
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (el.children.length) continue;
            var text = (el.textContent || "").trim();
            if (text === "平均缓存命中率" || text === "Average cache hit rate") {
                var row = el.closest("div.flex") || el.parentElement;
                if (row) return row;
            }
        }
        return popup.querySelector('[aria-label="上下文来源"], [aria-label="Context sources"]');
    }

    function detectLang(popup) {
        var text = popup.textContent || "";
        return text.indexOf("Average cache hit rate") !== -1 ? "en" : "zh";
    }

    // 单行或双行数值行：左标签禁止收缩，右侧支持两行或单行，防止长文本挤压标签
    function row(label, value, subValue) {
        var div = document.createElement("div");
        div.className = "flex min-w-0 " + (subValue ? "items-center" : "items-center") + " justify-between gap-2.5 text-ui-sm";
        var l = document.createElement("span");
        l.className = "shrink-0 text-foreground-subtle";
        l.textContent = label;

        var v;
        if (subValue) {
            v = document.createElement("div");
            v.className = "ml-auto flex flex-col items-end font-mono text-ui-sm tabular-nums text-foreground";
            var line1 = document.createElement("span");
            line1.className = "text-foreground leading-tight";
            line1.textContent = value;
            var line2 = document.createElement("span");
            line2.className = "text-foreground-subtle leading-tight mt-0.5 opacity-80";
            if (line2.style) line2.style.fontSize = "11px";
            line2.textContent = subValue;
            v.appendChild(line1);
            v.appendChild(line2);
        } else {
            v = document.createElement("span");
            v.className = "ml-auto min-w-10 shrink-0 text-right font-mono text-ui-sm tabular-nums text-foreground";
            v.textContent = value;
        }
        div.appendChild(l);
        div.appendChild(v);
        return div;
    }

    function buildSection(data, lang) {
        var t = LABELS[lang] || LABELS.zh;
        var s = data || {};
        var totals = s.totals || {};
        var speed = s.speed || {};
        var time = s.time || {};
        var tools = s.tools || {};
        var ctx = s.context || {};
        var sub = s.subagent || null;

        var section = document.createElement("div");
        section.setAttribute(SECTION_ATTR, "1");
        section.className = "space-y-1.5 border-t border-border pt-3";

        // 标题行样式对齐「剩余额度」块标题
        var title = document.createElement("div");
        title.className = "flex min-w-0 flex-wrap items-center gap-1";
        var h4 = document.createElement("h4");
        h4.className = "text-ui-base font-medium text-foreground";
        h4.textContent = t.title;
        title.appendChild(h4);
        section.appendChild(title);

        section.appendChild(row(t.total,
            fmtTokens(totals.totalTokens) + " tok · " + (totals.requests || 0) + " 轮"));
        var tps = speed.avg || speed.last;
        if (tps) section.appendChild(row(t.speed, Math.round(tps) + " tok/s"));
        if (time.sessionText) section.appendChild(row(t.session, time.sessionText));
        if (time.modelText) {
            section.appendChild(row(t.model, time.modelText + "（" + fmtPct(time.modelPct || 0) + "）"));
        }
        if (time.toolText) {
            section.appendChild(row(t.tool, time.toolText + "（" + fmtPct(time.toolPct || 0) + "）"));
        }

        // 模型用量拆为两行：输入/输出为主行，缓存读取与命中率为副行，彻底避免挤压标签
        var isZh = lang !== "en";
        var inOut = (isZh ? "输入 " : "In ") + fmtTokens(totals.inputTokens) +
            " · " + (isZh ? "输出 " : "Out ") + fmtTokens(totals.outputTokens);
        var cacheInfo = (isZh ? "缓存 " : "Cache ") + fmtTokens(totals.cacheReadTokens) +
            "（" + fmtPct(totals.cacheHitRate || 0) + "）";
        section.appendChild(row(t.usage, inOut, cacheInfo));

        if (totals.reasoningTokensEst) {
            section.appendChild(row(t.reasoning, fmtTokens(totals.reasoningTokensEst) + " tok"));
        }
        section.appendChild(row(t.calls,
            (tools.calls || 0) + " 次 · " + (tools.kinds || 0) + " 种"));
        if (sub) {
            section.appendChild(row(t.subagent,
                (sub.requests || 0) + " 轮 · " + fmtTokens(sub.totalTokens) + " tok"));
        }
        if (ctx.remaining != null) {
            section.appendChild(row(t.remaining,
                fmtExact(ctx.remaining) + " tok（已用 " + fmtPct(ctx.percent || 0) + "）"));
        }
        return section;
    }

    function insertSection(popup, section) {
        var anchor = findAnchor(popup);
        if (!anchor || !anchor.parentElement) return false;
        if (anchor.nextSibling) anchor.parentElement.insertBefore(section, anchor.nextSibling);
        else anchor.parentElement.appendChild(section);
        popup.setAttribute(CONTAINER_ATTR, "1");
        return true;
    }

    function syncPopup(popup) {
        if (!popup) return;
        var currentStats = stats || loadShared();
        if (!currentStats) return;
        var lang = detectLang(popup);
        var built = buildSection(currentStats, lang);
        var sec = popup.querySelector("[" + SECTION_ATTR + "]");
        if (sec) {
            sec.replaceWith(built);
        } else {
            insertSection(popup, built);
        }
    }

    function fetchStats(force) {
        if (inFlight) return;
        if (!force && stats && (Date.now() - statsAt < 2000)) return;
        inFlight = true;
        fetch(statsUrl())
            .then(function (res) { return res.json(); })
            .then(function (data) {
                inFlight = false;
                if (!data || !data.ok) return;
                // 丢弃其他会话的数据（会话切换瞬间的迟到响应）
                if (!util.isForCurrentSession(data)) return;
                stats = data;
                statsAt = Date.now();
                saveShared(data);
                var p = findPopup();
                if (p) syncPopup(p);
            })
            .catch(function () {
                inFlight = false;
            });
    }

    // 后台长连接监听：会话有新活动时即时更新内存快照
    function startStatsStream() {
        if (typeof EventSource === "undefined") return;
        try {
            stream = new EventSource(streamUrl());
            stream.onmessage = function (event) {
                try {
                    var data = JSON.parse(event.data);
                    if (!data || !data.ok) return;
                    // 丢弃非当前会话的帧（SSE 建立于会话切换之前时）
                    if (!util.isForCurrentSession(data)) return;
                    // SSE 提供基础快照；若本地无 subagents 或需要补全，静默触发一次完整 fetch
                    if (!stats || !stats.subagent) {
                        stats = data;
                        statsAt = Date.now();
                        saveShared(data);
                    }
                    var p = findPopup();
                    if (p) syncPopup(p);
                    // 数据有变动时触发一次带 subagents 的静默拉取
                    fetchStats(false);
                } catch (err) {}
            };
        } catch (err) {}
    }

    // 会话切换：丢弃旧会话数据，按新会话重建数据通道
    function handleSessionChange() {
        stats = null;
        statsAt = 0;
        host.sharedStats = null;
        if (stream) {
            try { stream.close(); } catch (e) {}
            stream = null;
        }
        startStatsStream();
        fetchStats(true);
    }

    // DOM 侦测：捕获弹层挂载时机即时注入；回调内不改 DOM，统一 rAF 让出事件循环后执行，
    // 避免「观察器内同步改 DOM → 再触发观察器」的微任务风暴（与 usage-panel-plus 同模式）
    function checkAndInjectSync() {
        // 会话切换侦测：data-session-id 变化即重置数据
        var sid = util.currentSessionId();
        if (sid !== lastSessionId) {
            lastSessionId = sid;
            handleSessionChange();
        }
        var popup = findPopup();
        if (!popup) return;
        var existing = popup.querySelector("[" + SECTION_ATTR + "]");
        if (existing) return; // 已注入，无需重复

        var currentStats = stats || loadShared();
        if (currentStats) {
            // 内存已有缓存：本帧内同步构建并注入 DOM，首帧即完整展现
            var lang = detectLang(popup);
            insertSection(popup, buildSection(currentStats, lang));
            // 若缓存超过 2 秒，后台发起静默校验更新
            if (Date.now() - statsAt > 2000) {
                fetchStats(true);
            }
        } else {
            // 冷启动未就绪时立即请求，不再延时
            fetchStats(true);
        }
    }

    var disposed = false; // teardown 置位：作废已排队的延迟回调，防止旧实例卸载后再改写弹层
    var syncQueued = false;
    function scheduleSync() {
        if (disposed || syncQueued) return;
        syncQueued = true;
        var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
        raf(function () {
            syncQueued = false;
            if (disposed) return; // teardown 前已入队的回调：实例已卸载，不得再动弹层
            try { checkAndInjectSync(); } catch (err) { /* 静默失败，不影响宿主页面 */ }
        });
    }

    var observer = new MutationObserver(scheduleSync);
    // 监听 data-session-id 属性变化：会话容器原地改属性（而非重建节点）时也能触发切换检测
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-session-id"],
    });

    // 初始化：启动后台长连接与静默预热，同时进行一次初次探测
    startStatsStream();
    fetchStats(true);
    checkAndInjectSync();

    // 弹层若常开，每 5 秒在后台静默轮询更新一次；顺带跑一次会话切换侦测，
    // 覆盖切换只落在 localStorage（无 DOM 属性变化）的窗口
    refreshTimer = setInterval(function () {
        scheduleSync();
        var p = findPopup();
        if (p) fetchStats(false);
    }, 5000);

    host.registry[ID] = {
        version: VERSION,
        remount: function () {
            checkAndInjectSync();
            fetchStats(true);
        },
        teardown: function () {
            disposed = true;
            observer.disconnect();
            if (stream) {
                try { stream.close(); } catch (err) {}
                stream = null;
            }
            if (refreshTimer) {
                clearInterval(refreshTimer);
                refreshTimer = null;
            }
            var sections = document.querySelectorAll("[" + SECTION_ATTR + "]");
            for (var i = 0; i < sections.length; i++) sections[i].remove();
            var marked = document.querySelectorAll("[" + CONTAINER_ATTR + "]");
            for (var j = 0; j < marked.length; j++) marked[j].removeAttribute(CONTAINER_ATTR);
            delete host.registry[ID];
        }
    };
})();
