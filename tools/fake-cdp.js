// 假 CDP 服务器：模拟 ZCode 调试端口，用于验证 launch.js 的 CDP 复用路径（不拉起真实 ZCode）
const http = require("node:http");

const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/json/version") {
        res.end(JSON.stringify({ Browser: "fake-cdp/0.0.1", webSocketDebuggerUrl: "" }));
        return;
    }
    if (req.url === "/json/list" || req.url === "/json") {
        res.end("[]");
        return;
    }
    res.statusCode = 404;
    res.end("{}");
});

server.listen(9333, "127.0.0.1", () => {
    console.log("fake CDP listening on 127.0.0.1:9333");
});
