// 插件服务端扩展机制验证：ctx.registerRoute 约束（/api/ 前缀强制、插件间冲突拒绝、
// 内置接口不可覆盖）、插件路由端到端调用（GET/POST）、ctx 数据文件读写、坏扩展不拖垮启动。
// 复制 launch.js + lib + 三个临时插件到临时目录，以 ZCODE_SOUL_NO_APP=1 运行并断言接口行为；
// 固定空闲高位端口，不影响 9340 真实启动器。用法：node test/verify-plugin-mechanism.js
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PORT = 9345;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-soul-mech-"));
fs.copyFileSync(path.join(ROOT, "launch.js"), path.join(tmpDir, "launch.js"));
fs.cpSync(path.join(ROOT, "lib"), path.join(tmpDir, "lib"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
    zcodePath: "",
    debugPort: 9333,
    statsPort: PORT,
    pollIntervalMs: 5000,
    openManager: false,
}, null, 4));

// 插件 A：正常注册路由 + 越界注册尝试 + 数据文件读写
const pluginA = {
    "plugin.json": JSON.stringify({
        id: "mech-a", name: "机制验证A", version: "0.0.1", description: "",
        inject: [], builtin: true, server: "server.js",
    }),
    "server.js": [
        "module.exports = function (ctx) {",
        "    // 正常路由：GET 回显插件 id，POST 回显请求体",
        "    ctx.registerRoute('GET', '/api/mech-a/ping', (req, res) => {",
        "        ctx.sendJson(res, { ok: true, plugin: ctx.pluginId });",
        "    });",
        "    ctx.registerRoute('POST', '/api/mech-a/echo', (req, res) => {",
        "        ctx.readBody(req).then((body) => ctx.sendJson(res, { ok: true, echo: body }, true));",
        "    });",
        "    // 数据文件：加载时写入，经路由读回校验往返一致",
        "    const file = ctx.dataFile('mech-a-data.json');",
        "    ctx.writeJson(file, { hello: 'mech-a' });",
        "    ctx.registerRoute('GET', '/api/mech-a/data', (req, res) => {",
        "        ctx.sendJson(res, { ok: true, data: ctx.readJson(file, null) });",
        "    });",
        "    // 越界注册尝试：非 /api/ 前缀应被拒绝（日志留痕，不抛出）",
        "    ctx.registerRoute('GET', '/metrics', (req, res) => ctx.sendJson(res, { ok: true }));",
        "    // 覆盖内置接口的尝试：允许入表但分发时被内置路由优先拦截",
        "    ctx.registerRoute('GET', '/api/plugins', (req, res) => ctx.sendJson(res, { ok: true, hijacked: true }));",
        "    ctx.log('mech-a 就绪');",
        "};",
    ].join("\n"),
};

// 插件 B：注册与 A 冲突的路径应被拒绝，自身路由不受影响
const pluginB = {
    "plugin.json": JSON.stringify({
        id: "mech-b", name: "机制验证B", version: "0.0.1", description: "",
        inject: [], server: "server.js",
    }),
    "server.js": [
        "module.exports = function (ctx) {",
        "    // 与 mech-a 冲突：应被拒绝（谁先加载谁持有）",
        "    ctx.registerRoute('GET', '/api/mech-a/ping', (req, res) => ctx.sendJson(res, { ok: true, plugin: 'mech-b' }));",
        "    ctx.registerRoute('GET', '/api/mech-b/ping', (req, res) => ctx.sendJson(res, { ok: true, plugin: ctx.pluginId }));",
        "};",
    ].join("\n"),
};

// 插件 C：导出非函数，加载应报错日志且不影响启动与其他插件
const pluginC = {
    "plugin.json": JSON.stringify({
        id: "mech-c", name: "机制验证C", version: "0.0.1", description: "",
        inject: [], server: "server.js",
    }),
    "server.js": "module.exports = { not: 'a function' };",
};

for (const [id, files] of [["mech-a", pluginA], ["mech-b", pluginB], ["mech-c", pluginC]]) {
    const dir = path.join(tmpDir, "plugins", id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
}

let child = null;

function request(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {};
        if (payload) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(payload);
        }
        const req = http.request({
            host: "127.0.0.1", port: PORT, path: apiPath, method, headers,
        }, (res) => {
            let raw = "";
            res.on("data", (d) => { raw += d; });
            res.on("end", () => {
                try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, json: null, raw }); }
            });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function waitReady() {
    for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try { return await request("GET", "/api/plugins"); } catch {}
    }
    throw new Error("服务就绪超时");
}

function assert(cond, msg) {
    if (!cond) throw new Error("断言失败: " + msg);
    console.log("  通过 - " + msg);
}

(async () => {
    try {
        child = spawn(process.execPath, ["launch.js"], {
            cwd: tmpDir,
            env: Object.assign({}, process.env, { ZCODE_SOUL_NO_APP: "1" }),
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d; });

        await waitReady();

        console.log("[1] /api/plugins 扩展字段");
        const list = await request("GET", "/api/plugins");
        assert(list.json.ok === true, "内置插件列表接口正常");
        const ids = list.json.plugins.map((p) => p.id);
        assert(ids.includes("mech-a") && ids.includes("mech-b") && ids.includes("mech-c"), "三个临时插件均被发现: " + ids.join(","));
        const pa = list.json.plugins.find((p) => p.id === "mech-a");
        assert(pa.hasServer === true && pa.builtin === true, "mech-a 的 hasServer/builtin 字段正确");
        const pb = list.json.plugins.find((p) => p.id === "mech-b");
        assert(pb.hasServer === true && pb.builtin === false, "mech-b 的 hasServer/builtin 字段正确");

        console.log("[2] 插件路由端到端");
        const ping = await request("GET", "/api/mech-a/ping");
        assert(ping.json.ok === true && ping.json.plugin === "mech-a", "mech-a GET 路由可用");
        const echo = await request("POST", "/api/mech-a/echo", { hello: "世界", n: 1 });
        assert(echo.json.ok === true && echo.json.echo.hello === "世界" && echo.json.echo.n === 1, "mech-a POST 路由回显请求体");
        const pingB = await request("GET", "/api/mech-b/ping");
        assert(pingB.json.ok === true && pingB.json.plugin === "mech-b", "mech-b 自身路由可用");

        console.log("[3] 注册约束");
        const metrics = await request("GET", "/metrics");
        assert(metrics.status === 404, "非 /api/ 前缀路由注册被拒绝（/metrics 404）");
        const conflict = await request("GET", "/api/mech-a/ping");
        assert(conflict.json.plugin === "mech-a", "插件间路由冲突被拒绝（先注册者持有）");
        assert(list.json.plugins && !list.json.hijacked, "内置 /api/plugins 不可被插件覆盖");

        console.log("[4] ctx 数据文件读写");
        const data = await request("GET", "/api/mech-a/data");
        assert(data.json.ok === true && data.json.data && data.json.data.hello === "mech-a", "writeJson/readJson 往返一致");

        console.log("[5] 坏扩展隔离与日志");
        await new Promise((r) => setTimeout(r, 300));
        const logText = fs.readFileSync(path.join(tmpDir, "data", "launcher.log"), "utf-8");
        assert(logText.includes("[mech-a] mech-a 就绪"), "ctx.log 带插件 id 前缀");
        assert(logText.includes("仅允许 /api/ 前缀"), "越界注册留有拒绝日志");
        assert(logText.includes("路径已被占用"), "冲突注册留有拒绝日志");
        assert(logText.includes("加载插件服务扩展失败 mech-c") || logText.includes("格式无效"), "坏扩展留有失败日志");
        assert(!stderr.includes("launch.js"), "启动进程无未捕获异常: " + stderr.slice(0, 200));

        console.log("全部验证通过");
    } finally {
        try { child.kill(); } catch {}
    }
    process.exit(0);
})().catch((err) => {
    console.error("验证失败: " + err.message);
    try { child.kill(); } catch {}
    process.exit(1);
});
