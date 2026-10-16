// 抓取目标页面主线程的当前调用栈（用于诊断挂死/死循环）。
// 用法: node tools/cdp-stack.js <debugPort> [targetUrlFilter]
const http = require("node:http");

const port = parseInt(process.argv[2] || "9335", 10);
const filter = process.argv[3] || "127.0.0.1:9345";

function getJson(pathName) {
    return new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: pathName }, (res) => {
            let raw = "";
            res.on("data", (c) => { raw += c; });
            res.on("end", () => resolve(JSON.parse(raw)));
        }).on("error", reject);
    });
}

(async () => {
    const targets = await getJson("/json/list");
    const target = targets.find((t) => t.type === "page" && (t.url || "").includes(filter));
    if (!target) {
        console.error("未找到目标页面: " + filter);
        process.exit(1);
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    let scriptLocations = {};

    function send(method, params) {
        return new Promise((resolve) => {
            const msgId = ++id;
            pending.set(msgId, resolve);
            ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
            setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); resolve({ __timeout: true }); } }, 6000);
        });
    }

    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        } else if (msg.method === "Debugger.scriptParsed") {
            scriptLocations[msg.params.scriptId] = (msg.params.url || "") + "#" + (msg.params.hash || "").slice(0, 6);
        }
    };

    const timeout = setTimeout(() => { console.error("总超时"); process.exit(1); }, 20000);

    await new Promise((r) => { ws.onopen = r; });
    await send("Debugger.enable");
    // 等待脚本解析事件流入
    await new Promise((r) => setTimeout(r, 500));
    const paused = await send("Debugger.pause");
    // 等待暂停事件（事件不带 id，通过轮询 callStack 获取不了；改为监听事件）
    await new Promise((resolvePause) => {
        const waiter = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.method === "Debugger.paused") {
                ws.removeEventListener("message", waiter);
                resolvePause(msg.params);
            }
        };
        ws.addEventListener("message", waiter);
        setTimeout(() => { ws.removeEventListener("message", waiter); resolvePause(null); }, 8000);
    }).then(async (params) => {
        clearTimeout(timeout);
        if (!params) {
            console.log("未收到暂停事件（页面可能在等待，而非死循环）");
        } else {
            console.log("暂停原因:", params.reason);
            console.log("调用栈:");
            for (const frame of params.callFrames) {
                const loc = scriptLocations[frame.location.scriptId] || frame.location.scriptId;
                console.log("  " + frame.functionName + " @ " + loc + ":" + frame.location.lineNumber + ":" + frame.location.columnNumber);
            }
        }
        try { ws.close(); } catch {}
        process.exit(0);
    });
})().catch((err) => { console.error("失败:", err.message); process.exit(1); });
