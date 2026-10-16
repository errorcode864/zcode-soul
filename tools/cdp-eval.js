// 向 ZCode（CDP）的所有页面执行一段 JS 并回传结果，用于排障验证。
// 用法：node tools/cdp-eval.js [debugPort] <表达式或 @表达式文件路径>
// 示例：node tools/cdp-eval.js 9333 "document.title"
const fs = require("node:fs");
const http = require("node:http");

const args = process.argv.slice(2);
const port = args.length > 1 ? parseInt(args[0], 10) : 9333;
const exprArg = args[args.length - 1];
if (!exprArg) {
    console.error("用法: node tools/cdp-eval.js [debugPort] <表达式或 @文件>");
    process.exit(1);
}
const expression = exprArg.startsWith("@")
    ? fs.readFileSync(exprArg.slice(1), "utf-8")
    : exprArg;

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
        const timer = setTimeout(() => { try { ws.close(); } catch {} resolve("timeout"); }, 8000);
        ws.onopen = () => ws.send(JSON.stringify({
            id: 1, method: "Runtime.evaluate",
            params: { expression: expr, returnByValue: true },
        }));
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id === 1) {
                clearTimeout(timer);
                try { ws.close(); } catch {}
                if (msg.result && msg.result.exceptionDetails) {
                    resolve("异常: " + JSON.stringify(msg.result.exceptionDetails.exceptionDescription || msg.result.exceptionDetails).slice(0, 300));
                } else {
                    resolve(msg.result && msg.result.result ? msg.result.result.value : null);
                }
            }
        };
        ws.onerror = () => { clearTimeout(timer); resolve("ws 错误"); };
    });
}

(async () => {
    const targets = await getJson("/json/list");
    for (const t of targets) {
        if (t.type !== "page" || (t.url || "").startsWith("devtools://")) continue;
        const result = await evaluate(t.webSocketDebuggerUrl, expression);
        console.log("[" + t.url.slice(0, 60) + "]");
        console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    }
})().catch((err) => { console.error("失败:", err.message); process.exit(1); });
