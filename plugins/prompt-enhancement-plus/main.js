// prompt-enhancement-plus: 在输入框发送按钮旁增加「增强提示词」按钮（Alt+E）
// 灵感来源：workbuddy。遵循严格的提示词工程改写规范，并支持单步撤销。
// 按钮/悬停提示/toast 配色用宿主 --color-* 变量，深浅色随应用主题自动跟随。
(function () {
    "use strict";
    var ID = "prompt-enhancement-plus";
    var VERSION = "1.1.4";
    var host = window.__zcodeSoul = window.__zcodeSoul || { registry: {} };

    if (host.registry[ID]) {
        var existing = host.registry[ID];
        if (existing.version === VERSION) {
            if (existing.remount) existing.remount();
            return;
        }
        try {
            if (existing.teardown) existing.teardown();
        } catch (e) {}
    }

    var PORT = window.__ZCODE_SOUL_STATS_PORT__ || 9340;
    var BASE = "http://127.0.0.1:" + PORT;
    var BTN_ID = "zcode-soul-enhance-btn";
    var TOAST_ID = "zcode-soul-enhance-toast";
    var TIP_ID = "zcode-soul-enhance-tip";

    // 清理历史实例残留的同 id 节点。走到这里说明页面上已无同版本存活实例（首次注入、
    // 卸载或旧版 teardown 之后），现存节点——含旧实例 teardown 后被其已排队 rAF 回调
    // 重新挂出的僵尸节点——均已无主，一并移除，避免按钮/提示叠加
    var staleNodes = document.querySelectorAll(
        "#" + BTN_ID + ",#" + TOAST_ID + ",#" + TIP_ID + ",style[data-zcode-soul-enhance-style]");
    for (var si = 0; si < staleNodes.length; si++) staleNodes[si].remove();

    // 增强图标（Lucide sparkles 线条版，与宿主原生 Lucide 图标同体系、同描边参数）
    var ICON_SPARKLES = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/>' +
        '<path d="M20 2v4"/>' +
        '<path d="M22 4h-4"/>' +
        '<circle cx="4" cy="20" r="2"/>' +
        '</svg>';

    var ICON_UNDO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" width="13" height="13" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 6.5h7a3.5 3.5 0 1 1 0 7H9"/>' +
        '<path d="M6 3.5 3 6.5l3 3"/>' +
        '</svg>';

    var ICON_LOADING = '<svg class="animate-spin" viewBox="0 0 16 16" fill="none" width="13" height="13">' +
        '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-opacity="0.25"/>' +
        '<path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '</svg>';

    // 注入样式：颜色用宿主 --color-* 变量，深浅色随应用主题自动跟随，
    // 写死深色值仅作变量缺失时的兜底
    var style = document.createElement("style");
    style.setAttribute("data-zcode-soul-enhance-style", "1");
    style.textContent = [
        "#" + BTN_ID + "{position:relative;display:inline-flex;align-items:center;justify-content:center;",
        "border:1px solid transparent;background:transparent;cursor:pointer;user-select:none;",
        "transition:all .15s ease;color:var(--color-foreground-subtle,#9aa0a8);padding:0;outline:none}",
        "#" + BTN_ID + ":hover{background:var(--color-hover,rgba(255,255,255,.08));color:var(--color-foreground,#e8eaed)}",
        "#" + BTN_ID + "[data-state='undo']{color:#3b82f6;background:rgba(59,130,246,.1)}",
        "#" + BTN_ID + "[data-state='undo']:hover{background:rgba(59,130,246,.2);color:#60a5fa}",
        "#" + BTN_ID + "[data-loading='true']{pointer-events:none;opacity:.65}",
        "@keyframes zc-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}",
        "#" + BTN_ID + " .animate-spin{animation:zc-spin .9s linear infinite}",
        "#" + TOAST_ID + "{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:2147483600;",
        "background:var(--color-popover,#1f2126);color:var(--color-foreground,#e8eaed);padding:8px 14px;border-radius:8px;font-size:12px;line-height:16px;",
        "border:1px solid var(--color-border,#33363c);box-shadow:0 6px 20px rgba(0,0,0,.45);opacity:0;pointer-events:none;",
        "transition:opacity .2s ease,transform .2s ease;max-width:400px;text-align:center}",
        "#" + TOAST_ID + ".show{opacity:1;transform:translateX(-50%) translateY(-6px)}",
        // 复刻原生 Radix tooltip（ControlHintTooltip 单行形态）：bg-tooltip + border-border，
        // 无阴影，标签 + kbd 徽标（bg-tooltip-tag）
        "#" + TIP_ID + "{position:fixed;z-index:2147483600;display:none;align-items:center;gap:8px;",
        "background:var(--color-tooltip,#2b2b2b);color:var(--color-tooltip-foreground,#f8f8f8);padding:4px 10px;border-radius:8px;font-size:12px;line-height:16px;",
        "font-weight:500;border:1px solid var(--color-border,rgba(255,255,255,.1));",
        "white-space:nowrap;pointer-events:none;transform:translateX(-50%)}",
        "#" + TIP_ID + ".show{display:inline-flex}",
        "#" + TIP_ID + " kbd{display:inline-flex;align-items:center;height:16px;padding:0 6px;",
        "border-radius:4px;background:var(--color-tooltip-tag,#363636);",
        "color:var(--color-tooltip-tag-foreground,#adadad);font-size:10px;font-weight:500;font-family:inherit}"
    ].join("");

    var toast = document.createElement("div");
    toast.id = TOAST_ID;
    var toastTimer = null;

    // 复刻原生「思考级别 Ctrl+1+T」样式的悬停提示（深色容器 + 标签 + kbd 徽标）
    var tip = document.createElement("div");
    tip.id = TIP_ID;

    function showTip(label, shortcut) {
        if (!btn.isConnected) return;
        tip.textContent = "";
        var labelSpan = document.createElement("span");
        labelSpan.textContent = label;
        tip.appendChild(labelSpan);
        if (shortcut) {
            var kbd = document.createElement("kbd");
            kbd.textContent = shortcut;
            tip.appendChild(kbd);
        }
        var rect = btn.getBoundingClientRect();
        tip.classList.add("show");
        var left = rect.left + rect.width / 2;
        // 原生 sideOffset=2：提示紧贴触发器上沿 2px
        var top = rect.top - tip.offsetHeight - 2;
        if (top < 8) top = rect.bottom + 2;
        tip.style.left = left + "px";
        tip.style.top = top + "px";
    }

    function hideTip() {
        tip.classList.remove("show");
    }

    function showToast(msg, isError) {
        toast.textContent = msg;
        // 错误态走主题的 destructive 色（浅色下为深红，保证可读），常态回归样式表变量
        if (isError) {
            toast.style.borderColor = "var(--color-destructive, #ef4444)";
            toast.style.color = "var(--color-destructive, #f87171)";
        } else {
            toast.style.borderColor = "";
            toast.style.color = "";
        }
        toast.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.classList.remove("show");
        }, 3200);
    }

    // 撤销状态缓存
    var undoState = {
        canUndo: false,
        previousText: "",
        enhancedText: ""
    };

    // 从 DOM 中获取 Lexical 的 inputApiRef
    function getInputApi() {
        var el = document.querySelector('div[contenteditable="true"]');
        if (!el) return null;
        var fiberKey = Object.keys(el).find(function (k) { return k.startsWith("__reactFiber"); });
        if (!fiberKey) return null;
        var cur = el[fiberKey];
        while (cur) {
            if (cur.memoizedProps && (cur.memoizedProps.inputApiRef || cur.memoizedProps.editorApiRef)) {
                var api = (cur.memoizedProps.inputApiRef && cur.memoizedProps.inputApiRef.current) ||
                          (cur.memoizedProps.editorApiRef && cur.memoizedProps.editorApiRef.current);
                if (api) return api;
            }
            cur = cur.return;
        }
        return null;
    }

    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.className = "group/button inline-flex items-center justify-center border border-transparent bg-clip-padding whitespace-nowrap transition-colors outline-none select-none size-7 shrink-0 rounded-lg text-ui-base";

    // 视觉状态键：相同状态不重写 DOM。innerHTML 重写属于子树变更，
    // 若发生在 MutationObserver 回调内会自我触发观察器形成微任务风暴挂死页面
    var lastVisualKey = "";

    function updateButtonVisual() {
        var key;
        if (btn.getAttribute("data-loading") === "true") {
            key = "loading";
        } else if (undoState.canUndo) {
            key = "undo";
        } else {
            key = "idle";
        }
        if (key === lastVisualKey) return;
        lastVisualKey = key;

        // 悬停提示自绘（aria-label 供读屏），不再用原生 title 兜底
        if (key === "loading") {
            btn.innerHTML = ICON_LOADING;
            btn.setAttribute("aria-label", "正在改写提示词");
            hideTip();
        } else if (key === "undo") {
            btn.setAttribute("data-state", "undo");
            btn.innerHTML = ICON_UNDO;
            btn.setAttribute("aria-label", "撤销提示词增强");
        } else {
            btn.removeAttribute("data-state");
            btn.innerHTML = ICON_SPARKLES;
            btn.setAttribute("aria-label", "增强提示词");
        }
    }

    // 监听输入框变化，若用户手动修改了增强后的文本，则撤销状态自动失效
    function checkTextSync() {
        var api = getInputApi();
        if (!api) return;
        var cur = api.getText();
        if (undoState.canUndo && cur !== undoState.enhancedText) {
            undoState.canUndo = false;
            updateButtonVisual();
        }
    }

    // 读取输入框上方当前显示的模型标签（形如「供应商名/模型名」），供「跟随当前模型」
    // 来源在服务端解析直连目标；读不到返回空串，由服务端给出明确错误
    function readCurrentModelLabel() {
        var selectors = ['[data-testid="chat-model-select-trigger"]', '[data-testid="v4-model-config"]'];
        for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            var label = ((el && el.textContent) || "").trim();
            if (label && label.length < 80) return label;
        }
        return "";
    }

    async function handleEnhanceOrUndo() {
        var api = getInputApi();
        if (!api) {
            showToast("未找到输入框", true);
            return;
        }

        // 如果当前处于可撤销状态，执行撤销
        if (undoState.canUndo) {
            api.setText(undoState.previousText);
            if (api.focus) api.focus();
            undoState.canUndo = false;
            updateButtonVisual();
            showToast("已恢复原提示词草稿");
            return;
        }

        var draft = (api.getText() || "").trim();
        if (!draft) {
            showToast("请先在输入框中输入提示词草稿", true);
            return;
        }

        btn.setAttribute("data-loading", "true");
        updateButtonVisual();

        try {
            var res = await fetch(BASE + "/api/prompt-enhancement/enhance", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    // 服务端 /api/* 同源守卫：跨站调用须带注入时下发的随机令牌
                    "x-zcode-soul-token": window.__ZCODE_SOUL_TOKEN__ || ""
                },
                body: JSON.stringify({ draft: draft, modelLabel: readCurrentModelLabel() })
            });
            var data = await res.json();
            if (!data.ok) {
                throw new Error(data.error || "提示词增强失败");
            }

            var enhanced = data.enhanced;
            undoState.canUndo = true;
            undoState.previousText = draft;
            undoState.enhancedText = enhanced;

            api.setText(enhanced);
            if (api.focus) api.focus();
            showToast("提示词增强完成，点击按钮可撤销");
        } catch (err) {
            showToast(err.message, true);
        } finally {
            btn.removeAttribute("data-loading");
            updateButtonVisual();
        }
    }

    btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        handleEnhanceOrUndo();
    });

    // 悬停显示与原生一致的提示（标签 + Alt+E 徽标）
    btn.addEventListener("mouseenter", function () {
        if (btn.getAttribute("data-loading") === "true") {
            showTip("正在改写提示词");
            return;
        }
        if (undoState.canUndo) {
            showTip("撤销提示词增强", "Alt+E");
        } else {
            showTip("增强提示词", "Alt+E");
        }
    });
    btn.addEventListener("mouseleave", hideTip);

    // 全局快捷键 Alt+E
    function onKeyDown(e) {
        if (e.altKey && (e.key === "e" || e.key === "E")) {
            e.preventDefault();
            handleEnhanceOrUndo();
        }
    }

    // 挂载逻辑
    // 生成期间发送按钮会被「停止生成」替换，两者占同一位置，都可作为锚点，
    // 否则生成中按钮会消失、无法增强正在输入的草稿
    function locateSendButton() {
        var sendBtn = document.querySelector('button[aria-label="发送"], button[aria-label="停止生成"]');
        if (sendBtn) return sendBtn;
        return Array.from(document.querySelectorAll("button")).find(function (b) {
            var t = (b.textContent || "").trim();
            return t === "发送" || t === "停止生成";
        }) || null;
    }

    function remount() {
        // 早期注入时 document.body/head 可能尚未就绪，跳过等待下轮巡检
        if (!document.body || !document.head) return;
        if (!document.head.querySelector("style[data-zcode-soul-enhance-style]")) {
            document.head.appendChild(style);
        }
        if (!toast.isConnected) {
            document.body.appendChild(toast);
        }
        if (!tip.isConnected) {
            document.body.appendChild(tip);
        }

        var sendBtn = locateSendButton();
        if (sendBtn && sendBtn.parentElement) {
            var container = sendBtn.parentElement;
            if (btn.parentElement !== container || btn.nextElementSibling !== sendBtn) {
                container.insertBefore(btn, sendBtn);
            }
        }
        updateButtonVisual();
    }

    // 观察器回调内禁止同步改 DOM：变更必须让出事件循环后再执行，
    // 否则插入操作会再次触发观察器，微任务队列永不排空（挂死页面）
    var disposed = false; // teardown 置位：作废已排队的延迟回调，防止旧实例卸载后把自己重新挂回页面
    var remountQueued = false;
    function scheduleRemount() {
        if (disposed || remountQueued) return;
        remountQueued = true;
        var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
        raf(function () {
            remountQueued = false;
            if (disposed) return; // teardown 前已入队的回调：实例已卸载，不得再重挂
            try { remount(); } catch (err) { /* 静默失败，不影响宿主页面 */ }
        });
    }

    var observer = new MutationObserver(function () {
        scheduleRemount();
        try { checkTextSync(); } catch (err) { /* 读取失败静默 */ }
    });

    function start() {
        remount();
        document.addEventListener("keydown", onKeyDown, true);
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        } else if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", function () {
                if (document.body) observer.observe(document.body, { childList: true, subtree: true });
            });
        }
    }

    function teardown() {
        disposed = true;
        observer.disconnect();
        document.removeEventListener("keydown", onKeyDown, true);
        if (style.parentNode) style.parentNode.removeChild(style);
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        if (tip.parentNode) tip.parentNode.removeChild(tip);
        if (btn.parentElement) btn.parentElement.removeChild(btn);
        else if (btn.parentNode) btn.parentNode.removeChild(btn);
        delete host.registry[ID];
    }

    start();

    host.registry[ID] = {
        version: VERSION,
        remount: remount,
        teardown: teardown
    };
})();
