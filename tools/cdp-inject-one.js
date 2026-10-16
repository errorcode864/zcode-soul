// 向指定 URL 的页面注入一个脚本文件并检查页面是否存活。
// 用法: node tools/cdp-inject-one.js <debugPort> <urlFilter> <scriptFile>
const fs = require("node:fs");
const http = require("node:http");

const port = parseInt(process.argv[2] || "9335", 10);
const filter = process.argv[3] || "";
const scriptFile = process.argv[4];

if (!scriptFile) {
    console.error("用法: node tools/cdp-inject-one.js <debugPort> <urlFilter> <scriptFile>");
    process.exit(1);
}

function getJson(pathName) {
    return new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: pathName }, (res) => {
            let raw = "";
            res.on("data", (c) => { raw += c; });
            res.on("end", () => resolve(JSON.parse(raw)));
        }).on("error", reject);
    });
}

function evaluate(wsUrl, expr) {
    return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { try { ws.close(); } catch {} resolve("TIMEOUT"); }, 8000);
        ws.onopen = () => ws.send(JSON.stringify({
            id: 1, method: "Runtime.evaluate",
            params: { expression: expr, returnByValue: true },
        }));
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id === 1) {
                clearTimeout(timer);
                try { ws.close(); } catch {}
                const detail = msg.result && msg.result.exceptionDetails;
                resolve(detail ? "EXC " + (detail.exception && detail.exception.description || "").slice(0, 160) : "OK");
            }
        };
        ws.onerror = () => { clearTimeout(timer); resolve("WS_ERROR"); };
    });
}

(async () => {
    const source = fs.readFileSync(scriptFile, "utf8");
    const targets = await getJson("/json/list");
    const target = targets.find((t) => t.type === "page" && (t.url || "").includes(filter));
    if (!target) {
        console.error("未找到目标页面: " + filter);
        process.exit(1);
    }
    const before = await evaluate(target.webSocketDebuggerUrl, "typeof window.__heartbeat");
    console.log("注入前探测:", before);
    const injected = await evaluate(target.webSocketDebuggerUrl,
        "window.__ZCODE_SOUL_STATS_PORT__=9340;" + source);
    console.log("注入结果:", injected);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await evaluate(target.webSocketDebuggerUrl, "window.__heartbeat");
    console.log("注入后心跳:", after);
    const after2 = await evaluate(target.webSocketDebuggerUrl, "window.__heartbeat");
    console.log("二次心跳:", after2);
})().catch((err) => { console.error("失败:", err.message); process.exit(1); });
