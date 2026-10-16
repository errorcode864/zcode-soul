// manager-panel-plus：在 ZCode 左下角「移动端远程控制」图标左侧注入拼图按钮，
// 点击弹出完全参照「移动端远程控制」原生同款风格的居中 Modal 弹窗（内嵌 manager.html）。
// 弹窗外壳直接用宿主 --color-* 变量，深浅色自动跟随；内嵌 iframe 是跨域文档读不到
// 宿主变量，由本插件读取 <html> 的 dark class 判定主题并解析变量实测值，经 URL 参数
// （首帧预置）+ postMessage（加载后精调与切换跟随）下发给 manager.html。
(function () {
    var ID = "manager-panel-plus";
    var host = window.__zcodeSoul = window.__zcodeSoul || { registry: {} };

    // 已注入过：节点被页面更新移除时重新挂载后返回
    if (host.registry[ID]) {
        var reg0 = host.registry[ID];
        if (reg0.remount) reg0.remount();
        return;
    }

    var PORT = window.__ZCODE_SOUL_STATS_PORT__ || 9340;
    var BASE = "http://127.0.0.1:" + PORT;

    // 宿主以 <html> 的 dark class 切换深浅色（无 class 即浅色）
    function currentTheme() {
        return document.documentElement.classList.contains("dark") ? "dark" : "light";
    }

    // manager.html 消费的主题变量：解析后随 postMessage 下发，空值跳过走页面内置调色板
    var THEME_VARS = [
        "--color-background", "--color-foreground", "--color-foreground-subtle",
        "--color-card", "--color-border", "--color-surface", "--color-hover",
        "--color-primary", "--color-primary-foreground",
        "--color-success", "--color-warning",
    ];

    function readThemeVars() {
        var vars = {};
        var scopes = [];
        if (document.body) scopes.push(window.getComputedStyle(document.body));
        scopes.push(window.getComputedStyle(document.documentElement));
        for (var i = 0; i < THEME_VARS.length; i++) {
            var name = THEME_VARS[i];
            var val = "";
            for (var j = 0; j < scopes.length && !val; j++) {
                val = (scopes[j].getPropertyValue(name) || "").trim();
            }
            if (val) vars[name] = val;
        }
        return vars;
    }

    var BTN_ID = "zcode-soul-btn";
    var DIALOG_ID = "zcode-soul-dialog";
    var TIP_ID = "zcode-soul-manager-tip";
    
    // 拼图图标（Lucide puzzle 线条版，与原生侧栏 Lucide 图标同体系、同描边参数）
    var PUZZLE_PATH = "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682" +
        "a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68" +
        "l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015" +
        "a1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0" +
        " 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z";

    var btnSvgAttrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

    var style = document.createElement("style");
    style.setAttribute("data-zcode-soul-manager-style", "1");
    style.textContent = [
        // 拼图按钮兜底/激活样式
        "#" + BTN_ID + "[data-mode='fixed']{position:fixed;left:10px;bottom:10px;z-index:2147483000;width:34px;height:34px;",
        "border-radius:50%;background:var(--color-popover, rgba(29,31,36,.85));border:1px solid var(--color-popover-border, rgba(255,255,255,.12));",
        "display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:.6;",
        "transition:opacity .15s,background .15s;box-shadow:0 2px 8px rgba(0,0,0,.35)}",
        "#" + BTN_ID + "[data-mode='fixed']:hover{opacity:1;background:var(--color-hover, rgba(42,45,51,.95))}",
        "#" + BTN_ID + ".active{background:var(--color-surface-hover, rgba(255,255,255,0.1)) !important;color:var(--color-foreground, #fff) !important;opacity:1 !important}",
        "#" + BTN_ID + " svg{flex:none}",
        // fixed 兜底模式下无原生尺寸类可镜像，显式定尺寸；作用域限定 data-mode 避免覆盖锚定模式的镜像类
        "#" + BTN_ID + "[data-mode='fixed'] svg{width:16px;height:16px}",
        // 遮罩层 Overlay：仿原生 fixed inset-0 isolate z-50 bg-black/60 backdrop-blur-xs
        "#" + DIALOG_ID + "{position:fixed;inset:0;z-index:2147483600;display:none;align-items:center;justify-content:center;",
        "background:rgba(0,0,0,0.6);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);",
        "opacity:0;transition:opacity 0.15s ease-out}",
        "#" + DIALOG_ID + ".open{display:flex;opacity:1}",
        // 对话框主容器：仿原生 max-h-[calc(100vh-6rem)] max-w-4xl rounded-2xl border border-popover-border bg-popover
        "#" + DIALOG_ID + " .dialog-content{position:relative;width:940px;max-width:calc(100vw - 4rem);",
        "max-height:calc(100vh - 5rem);height:760px;",
        "background:var(--color-popover, #212226);",
        "border:1px solid var(--color-popover-border, rgba(255,255,255,0.12));",
        "border-radius:16px;box-shadow:0 20px 48px rgba(0,0,0,0.5);",
        "display:flex;flex-direction:column;overflow:hidden;",
        "transform:scale(0.97);transition:transform 0.15s cubic-bezier(0.16, 1, 0.3, 1)}",
        "#" + DIALOG_ID + ".open .dialog-content{transform:scale(1)}",
        // 对话框头部：左侧圆角图标 + 标题/副标题，右侧关闭按钮
        "#" + DIALOG_ID + " .dialog-header{display:flex;align-items:center;justify-content:space-between;padding:18px 24px 14px;",
        "border-bottom:1px solid var(--color-border, rgba(255,255,255,0.08));flex:none}",
        "#" + DIALOG_ID + " .dialog-header-left{display:flex;align-items:center;gap:12px}",
        "#" + DIALOG_ID + " .dialog-header-icon{width:40px;height:40px;border-radius:10px;",
        "border:1px solid var(--color-border, rgba(255,255,255,0.1));background:var(--color-surface, rgba(255,255,255,0.05));",
        "display:flex;align-items:center;justify-content:center;color:var(--color-primary, #fff)}",
        "#" + DIALOG_ID + " .dialog-header-icon svg{width:20px;height:20px}",
        "#" + DIALOG_ID + " .dialog-header-title{font-size:16px;font-weight:600;color:var(--color-foreground, #dedede);margin:0 0 2px}",
        "#" + DIALOG_ID + " .dialog-header-desc{font-size:12px;color:var(--color-foreground-subtle, #9a9a9a);margin:0}",
        "#" + DIALOG_ID + " .dialog-header-actions{display:flex;align-items:center;gap:8px}",
        "#" + DIALOG_ID + " .dialog-btn{background:transparent;border:1px solid var(--color-border, rgba(255,255,255,0.1));",
        "color:var(--color-foreground-subtle, #9a9a9a);border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;",
        "display:inline-flex;align-items:center;gap:5px;transition:all 0.15s}",
        "#" + DIALOG_ID + " .dialog-btn:hover{background:var(--color-surface-hover, rgba(255,255,255,0.08));color:var(--color-foreground, #fff)}",
        "#" + DIALOG_ID + " .dialog-close-btn{width:30px;height:30px;padding:0;justify-content:center;border-radius:8px}",
        "#" + DIALOG_ID + " .dialog-close-btn svg{width:16px;height:16px}",
        // 内容 iframe
        "#" + DIALOG_ID + " iframe{flex:1;border:none;width:100%;height:100%;background:transparent}",
        // 复刻原生 Radix tooltip 单行形态（ControlHintTooltip）：bg-tooltip + border-border，
        // 无阴影，px-2.5 py-1，仅显示插件名称；颜色用宿主变量，深浅色自动跟随
        "#" + TIP_ID + "{position:fixed;z-index:2147483600;display:none;align-items:center;",
        "background:var(--color-tooltip, #2b2b2b);color:var(--color-tooltip-foreground, #f8f8f8);padding:4px 10px;border-radius:8px;font-size:12px;line-height:16px;",
        "font-weight:500;border:1px solid var(--color-border, rgba(255,255,255,.1));",
        "white-space:nowrap;pointer-events:none;transform:translateX(-50%)}",
        "#" + TIP_ID + ".show{display:inline-flex}"
    ].join("");

    var dialog = document.createElement("div");
    dialog.id = DIALOG_ID;

    // 复刻原生悬停提示（圆角容器，配色随主题），仅显示插件名称
    var tip = document.createElement("div");
    tip.id = TIP_ID;

    function showTip(label) {
        if (!btn.isConnected) return;
        tip.textContent = "";
        var labelSpan = document.createElement("span");
        labelSpan.textContent = label;
        tip.appendChild(labelSpan);
        var rect = btn.getBoundingClientRect();
        tip.classList.add("show");
        var left = rect.left + rect.width / 2;
        // 入口按钮贴近屏幕左缘，水平居中会让提示左移出屏，钳制到与 Radix 碰撞回避一致的边距
        var half = tip.offsetWidth / 2;
        if (left - half < 8) left = 8 + half;
        // 原生 sideOffset=2：提示紧贴触发器上沿 2px
        var top = rect.top - tip.offsetHeight - 2;
        if (top < 8) top = rect.bottom + 2;
        tip.style.left = left + "px";
        tip.style.top = top + "px";
    }

    function hideTip() {
        tip.classList.remove("show");
    }

    dialog.innerHTML = [
        '<div class="dialog-content">',
        '  <div class="dialog-header">',
        '    <div class="dialog-header-left">',
        '      <div class="dialog-header-icon">',
        '        <svg ' + btnSvgAttrs + '><path d="' + PUZZLE_PATH + '"></path></svg>',
        '      </div>',
        '      <div>',
        '        <div class="dialog-header-title">扩展管理</div>',
        '        <div class="dialog-header-desc">管理本地已发现插件的启用与卸载状态。</div>',
        '      </div>',
        '    </div>',
        '    <div class="dialog-header-actions">',
        '      <button type="button" class="dialog-btn" id="zcode-soul-browser-btn" title="在外部默认浏览器中打开">',
        '        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>',
        '        浏览器打开',
        '      </button>',
        '      <button type="button" class="dialog-btn dialog-close-btn" id="zcode-soul-close-btn" title="关闭 (Esc)">',
        '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
        '      </button>',
        '    </div>',
        '  </div>',
        '  <div id="zcode-soul-frame-wrap" style="flex:1;min-height:0;position:relative;"></div>',
        '</div>'
    ].join("");

    var frameWrap = dialog.querySelector("#zcode-soul-frame-wrap");
    var frame = null;

    // 向 iframe 下发当前主题与宿主变量实测值；iframe 未就绪时静默失败，
    // 由 load 事件后的首次下发兜底
    function postTheme() {
        if (!frame || !frame.contentWindow) return;
        try {
            frame.contentWindow.postMessage({
                type: "zcode-soul:theme",
                theme: currentTheme(),
                vars: readThemeVars()
            }, "*");
        } catch (err) { /* iframe 未就绪/已销毁时忽略 */ }
    }

    function ensureFrame() {
        if (frame) return;
        frame = document.createElement("iframe");
        // URL 参数让 manager.html 首帧即按当前主题套用内置调色板（避免深色闪现），
        // load 后再 postMessage 宿主变量实测值精调
        frame.src = BASE + "/?embed=1&theme=" + currentTheme();
        frame.addEventListener("load", postTheme);
        frameWrap.appendChild(frame);
    }

    function openDialog() {
        if (!document.body) return;
        hideTip();
        ensureFrame();
        if (!dialog.isConnected) {
            document.body.appendChild(dialog);
        }
        dialog.classList.add("open");
        btn.classList.add("active");
    }

    function closeDialog() {
        if (!dialog.classList.contains("open")) return;
        dialog.classList.remove("open");
        btn.classList.remove("active");
        // 关闭即销毁 iframe：页面文档连同其全部运行状态（未关闭的设置弹窗、表单值、
        // 搜索词/筛选页签等）一并丢弃，下次打开由 ensureFrame 重建出全新页面；
        // 否则关闭只是 display:none，重开后设置弹窗等状态原样残留，且隐藏期间
        // iframe 内的轮询仍在空转
        if (frame) {
            frame.remove();
            frame = null;
        }
    }

    function toggleDialog() {
        if (dialog.classList.contains("open")) {
            closeDialog();
        } else {
            openDialog();
        }
    }

    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    // 悬停提示自绘（aria-label 供读屏），不用原生 title 避免双重提示
    btn.setAttribute("aria-label", "zcode-soul 扩展管理");
    btn.setAttribute("data-zcode-soul-btn", "1");

    function createPuzzleSvg(className) {
        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        if (className) svg.setAttribute("class", className);
        var pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
        pathEl.setAttribute("d", PUZZLE_PATH);
        svg.appendChild(pathEl);
        return svg;
    }

    function findAnchor() {
        var exact = document.querySelector('button[aria-label="移动端远程控制"]');
        if (exact) return exact;
        var buttons = document.querySelectorAll("button[aria-label]");
        for (var i = 0; i < buttons.length; i++) {
            var label = buttons[i].getAttribute("aria-label") || "";
            if (/remote control|远程控制/i.test(label)) return buttons[i];
        }
        return null;
    }

    // 原生按钮的状态色类（如远程连接后的 text-warning）与拼图按钮语义无关，
    // 看门狗每轮巡检都会经 remount -> upgradeToAnchor 重新镜像 class，
    // 不剥离的话拼图图标会跟随远程连接状态变色（与原生按钮撞色）
    var STATE_COLOR_CLASS = /(^|\s)text-(warning|destructive|success)(?=\s|$)/g;
    var LUCIDE_ICON_CLASS = /\blucide-[\w-]+/g;

    function stripState(cls) {
        return (cls || "").replace(STATE_COLOR_CLASS, "$1").replace(LUCIDE_ICON_CLASS, "").replace(/\s+/g, " ").trim();
    }

    function upgradeToAnchor() {
        var anchor = findAnchor();
        if (!anchor || !btn.isConnected) return false;
        anchor.parentNode.insertBefore(btn, anchor);
        var nextClass = stripState(anchor.className);
        // className 整体替换会清掉弹窗打开态的高亮，需保留
        if (btn.classList.contains("active")) nextClass += " active";
        btn.className = nextClass;
        btn.removeAttribute("data-mode");
        var nativeSvg = anchor.querySelector("svg");
        var mySvg = btn.querySelector("svg");
        if (nativeSvg && mySvg) mySvg.setAttribute("class", stripState(nativeSvg.getAttribute("class")));
        return true;
    }

    function remount() {
        if (!btn.isConnected) {
            btn.setAttribute("data-mode", "fixed");
            btn.className = "";
            // 重挂后按钮脱离 DOM 时会保留旧子节点，先清空避免 svg 重复堆积
            btn.replaceChildren();
            btn.appendChild(createPuzzleSvg(""));
            document.documentElement.appendChild(btn);
        }
        if (document.body && !dialog.isConnected) {
            document.body.appendChild(dialog);
        }
        if (!tip.isConnected) {
            document.body.appendChild(tip);
        }
        if (!style.isConnected) document.documentElement.appendChild(style);
        return upgradeToAnchor();
    }

    btn.addEventListener("click", toggleDialog);

    // 悬停显示插件名称，移开即隐藏
    btn.addEventListener("mouseenter", function () {
        showTip("扩展管理");
    });
    btn.addEventListener("mouseleave", hideTip);

    // 点击遮罩空白区域关闭弹窗
    dialog.addEventListener("click", function (e) {
        if (e.target === dialog) {
            closeDialog();
        }
    });

    dialog.querySelector("#zcode-soul-close-btn").addEventListener("click", closeDialog);
    dialog.querySelector("#zcode-soul-browser-btn").addEventListener("click", function () {
        // Electron 渲染进程内 window.open 会被主进程拦截，改由本地服务用系统默认浏览器打开；
        // 服务端 /api/* 同源守卫：跨站调用须带注入时下发的随机令牌
        fetch(BASE + "/api/open-browser", {
            headers: { "x-zcode-soul-token": window.__ZCODE_SOUL_TOKEN__ || "" }
        }).catch(function () {});
    });

    // 键盘 Esc 关闭
    function onKeyDown(e) {
        if (e.key === "Escape" && dialog.classList.contains("open")) {
            closeDialog();
        }
    }

    // 监听来自 iframe 内关闭消息
    function onMessage(e) {
        if (e.data && e.data.type === "zcode-soul:close") {
            closeDialog();
        }
    }

    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("message", onMessage);

    // 宿主主题切换（<html> class 变化）时即时跟随：弹窗开着才需要下发，
    // 关着的话下次 open 由 ensureFrame 的 URL 参数带新主题
    var themeObserver = new MutationObserver(function () {
        if (dialog.classList.contains("open")) postTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    remount();

    // 轮询升级到原生侧栏锚点
    (function pollAnchor(tries) {
        if (upgradeToAnchor()) return;
        if (tries <= 0) return;
        setTimeout(function () { pollAnchor(tries - 1); }, 600);
    })(15);

    host.registry[ID] = {
        version: "0.3.5",
        remount: remount,
        open: openDialog,
        close: closeDialog,
        teardown: function () {
            btn.remove();
            dialog.remove();
            style.remove();
            tip.remove();
            themeObserver.disconnect();
            document.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("message", onMessage);
            delete host.registry[ID];
        }
    };
})();
