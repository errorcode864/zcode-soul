// 提示词增强模型来源的端到端验证：
// 复制 launch.js 到临时目录、改端口 9342、以 ZCODE_SOUL_NO_APP=1 运行，
// 依次验证：模型列表接口（不泄漏密钥）、配置保存回读、旧 cli 来源归一、
// 真实改写调用、API Key 打码不回传、/api/* 跨站请求拒绝、上游 User-Agent 复刻。
// 读取真实 ~/.zcode/v2 模型设置，但不拉起 ZCode、不影响 9340 真实启动器；
// 真实模型调用受套餐与网络影响，允许失败（输出「跳过」）。
// CDP 与改写上游均指向本地 mock：不碰 9333 真实客户端，User-Agent 断言完全离线可复现。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PORT = 9342;

// mock CDP /json/version（返回带 ZCode 版本段的 User-Agent）+ OpenAI 兼容改写上游
// （原样记录收到的 User-Agent 供断言），动态端口避免与并行会话冲突
const capturedUserAgent = { value: "" };
const mockServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/json/version") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
            Browser: "Chrome/146.0.7680.80",
            "User-Agent": "Mozilla/5.0 (Mock) AppleWebKit/537.36 " +
                "ZCode/9.9.9-test Chrome/146.0.7680.80 Electron/41.0.3 Safari/537.36",
        }));
        return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
        capturedUserAgent.value = String(req.headers["user-agent"] || "");
        req.resume();
        req.on("end", () => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: "mock 改写结果" } }] }));
        });
        return;
    }
    res.statusCode = 404;
    res.end("{}");
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-soul-pe-"));
fs.copyFileSync(path.join(ROOT, "launch.js"), path.join(tmpDir, "launch.js"));
// launch.js 顶层 require lib 平台模块；提示词增强接口在插件 server.js（启动时加载）
fs.cpSync(path.join(ROOT, "lib"), path.join(tmpDir, "lib"), { recursive: true });
const pePluginDir = path.join(tmpDir, "plugins", "prompt-enhancement-plus");
fs.mkdirSync(pePluginDir, { recursive: true });
for (const f of ["plugin.json", "server.js", "manager.js"]) {
    fs.copyFileSync(path.join(ROOT, "plugins", "prompt-enhancement-plus", f), path.join(pePluginDir, f));
}
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });

let child = null;
let serverErr = "";

function request(method, apiPath, body, origin) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {};
        if (payload) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(payload);
        }
        // 传 origin 模拟浏览器跨站请求，验证 /api/* 同源守卫
        if (origin) headers["Origin"] = origin;
        const req = http.request({
            host: "127.0.0.1", port: PORT, path: apiPath, method, headers,
        }, (res) => {
            let raw = "";
            res.on("data", (d) => { raw += d; });
            res.on("end", () => {
                try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("响应非 JSON: " + raw.slice(0, 200))); }
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
    throw new Error("服务就绪超时。" + (serverErr ? "stderr: " + serverErr.slice(0, 500) : ""));
}

function assert(cond, msg) {
    if (!cond) throw new Error("断言失败: " + msg);
    console.log("  通过 - " + msg);
}

(async () => {
    try {
        await new Promise((resolve, reject) => {
            mockServer.once("error", reject);
            mockServer.listen(0, "127.0.0.1", resolve);
        });
        const mockPort = mockServer.address().port;

        fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
            debugPort: mockPort,
            statsPort: PORT,
            pollIntervalMs: 5000,
            openManager: false,
        }, null, 4));
        child = spawn(process.execPath, ["launch.js"], {
            cwd: tmpDir,
            env: Object.assign({}, process.env, { ZCODE_SOUL_NO_APP: "1" }),
            stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr.on("data", (d) => { serverErr += d; });

        await waitReady();

        console.log("[0] 插件扩展机制（/api/plugins 扩展字段 + 管理页扩展脚本可获取）");
        const pluginList = await request("GET", "/api/plugins");
        assert(pluginList.ok === true, "插件列表接口可用");
        const pe = pluginList.plugins.find((p) => p.id === "prompt-enhancement-plus");
        assert(Boolean(pe), "列表包含 prompt-enhancement-plus");
        assert(pe.hasServer === true && pe.hasManager === true, "hasServer/hasManager 识别扩展文件");
        assert(pe.builtin === true, "builtin 字段生效");
        assert(pluginList.plugins.every((p) => p.dir === undefined), "响应不暴露插件目录路径");
        const mgrJs = await new Promise((resolve, reject) => {
            http.get({ host: "127.0.0.1", port: PORT, path: "/plugin/prompt-enhancement-plus/manager.js" }, (res) => {
                let raw = "";
                res.on("data", (d) => { raw += d; });
                res.on("end", () => resolve({ status: res.statusCode, body: raw }));
            }).on("error", reject);
        });
        assert(mgrJs.status === 200 && mgrJs.body.includes("__zcodeSoulManager"), "manager.js 经 /plugin/ 路由可获取");

        console.log("[1] 模型列表接口 GET /api/prompt-enhancement/zcode-models");
        const models = await request("GET", "/api/prompt-enhancement/zcode-models");
        assert(models.ok === true, "接口返回 ok:true（已读取到模型设置）");
        assert(Array.isArray(models.providers) && models.providers.length > 0, "providers 非空: " + models.providers.length + " 个服务");
        const raw = JSON.stringify(models);
        assert(!/"apiKey"/.test(raw) && !/sk-/.test(raw), "响应不包含 apiKey 字段或密钥内容");
        for (const p of models.providers) {
            console.log("      - " + p.name + " | " + p.kind + " | enabled=" + p.enabled + " | key=" + p.hasApiKey + " | planGateway=" + Boolean(p.planGateway) + " | models=" + p.models.map((m) => m.id).join(","));
        }
        const usable = models.providers.find((p) => p.hasApiKey && !p.planGateway && p.enabled !== false);

        console.log("[2] 配置接口 GET /api/prompt-enhancement/config");
        const config = await request("GET", "/api/prompt-enhancement/config");
        assert(config.ok === true, "接口返回 ok:true");
        assert(typeof config.defaultTemplate === "string" && config.defaultTemplate.includes("{{draft}}"), "默认模板含 {{draft}} 占位符");
        assert(config.config.source === "zcode" || config.config.source === "custom", "默认来源归一为 zcode/custom: " + config.config.source);
        assert(!("cliAvailable" in config), "不再返回 cliAvailable 标记");

        console.log("[3] 保存模型设置来源并回读（仅可选有密钥且已启用的服务）");
        if (!usable) {
            console.log("  跳过 - 没有可直连服务（均为套餐网关、未配置密钥或未启用）");
        } else {
            const saved = await request("POST", "/api/prompt-enhancement/config", {
                source: "zcode",
                zcodeProviderId: usable.id,
                zcodeModel: usable.models[0].id,
            });
            assert(saved.ok === true, "保存成功（服务: " + usable.name + "）");
            assert(saved.config.source === "zcode", "source 已持久化为 zcode");
            assert(saved.config.zcodeProviderId === usable.id, "zcodeProviderId 已持久化: " + usable.id);
        }

        console.log("[3b] 保存不可直连的服务应被拒绝");
        const unusable = models.providers.find((p) => !p.hasApiKey || p.planGateway || p.enabled === false);
        if (!unusable) {
            console.log("  跳过 - 所有服务均可直连");
        } else {
            const rejected = await request("POST", "/api/prompt-enhancement/config", {
                source: "zcode",
                zcodeProviderId: unusable.id,
                zcodeModel: (unusable.models[0] || { id: "x" }).id,
            });
            assert(rejected.ok === false, "不可直连服务被拒绝: " + unusable.name);
            assert(String(rejected.error || "").length > 10, "拒绝原因含引导信息: " + String(rejected.error || "").slice(0, 60));
        }

        console.log("[3c] 旧 cli 来源保存时归一（CLI 来源已移除）");
        const savedCli = await request("POST", "/api/prompt-enhancement/config", { source: "cli" });
        assert(savedCli.ok === true, "保存成功");
        assert(savedCli.config.source === "zcode" || savedCli.config.source === "custom", "旧值 cli 已归一为: " + savedCli.config.source);
        const rereadCli = await request("GET", "/api/prompt-enhancement/config");
        assert(rereadCli.config.source === "zcode" || rereadCli.config.source === "custom", "回读来源仍为归一值: " + rereadCli.config.source);

        console.log("[4] API Key 不回传明文（临时实例内保存自定义配置，不碰真实 data 目录）");
        const savedCustom = await request("POST", "/api/prompt-enhancement/config", {
            source: "custom",
            apiUrl: "https://api.example.com/v1",
            apiKey: "sk-secret-123",
            model: "test-model",
        });
        assert(savedCustom.ok === true, "自定义配置保存成功");
        assert(savedCustom.config.apiKey === "__stored__", "保存响应密钥已打码: " + savedCustom.config.apiKey);
        const reread = await request("GET", "/api/prompt-enhancement/config");
        assert(reread.config.apiKey === "__stored__", "回读密钥为占位符: " + reread.config.apiKey);
        assert(!JSON.stringify(reread).includes("sk-secret-123"), "配置响应不包含明文密钥");
        const resaved = await request("POST", "/api/prompt-enhancement/config", {
            source: "custom",
            apiUrl: "https://api.example.com/v1",
            apiKey: "__stored__",
            model: "test-model",
        });
        assert(resaved.ok === true && resaved.config.apiKey === "__stored__", "占位符保存视为未修改，密钥未丢失");

        console.log("[5] 真实改写调用 POST /api/prompt-enhancement/enhance（切回模型设置来源）");
        if (!usable) {
            console.log("  跳过 - 没有可直连服务");
        } else {
            await request("POST", "/api/prompt-enhancement/config", {
                source: "zcode",
                zcodeProviderId: usable.id,
                zcodeModel: usable.models[0].id,
            });
            const enhanced = await request("POST", "/api/prompt-enhancement/enhance", { draft: "帮我看看这段代码" });
            if (enhanced.ok) {
                assert(typeof enhanced.enhanced === "string" && enhanced.enhanced.length > 0, "改写成功: " + enhanced.enhanced.slice(0, 80));
            } else {
                console.log("  跳过 - 模型调用失败（可能是网络或套餐限制）: " + enhanced.error);
            }
        }

        console.log("[6] /api/* 同源守卫（带 Origin 无令牌的跨站请求应被拒绝）");
        const evilToggle = await request("POST", "/api/plugins/manager-panel-plus/toggle", { enabled: false }, "https://evil.example");
        assert(evilToggle.ok === false, "跨站插件开关被拒绝: " + (evilToggle.error || ""));
        const evilEnhance = await request("POST", "/api/prompt-enhancement/enhance", { draft: "测试" }, "https://evil.example");
        assert(evilEnhance.ok === false, "跨站改写调用被拒绝: " + (evilEnhance.error || ""));

        console.log("[7] 上游 User-Agent 复刻客户端主链路形态（mock CDP + mock 上游）");
        const savedMock = await request("POST", "/api/prompt-enhancement/config", {
            source: "custom",
            apiUrl: "http://127.0.0.1:" + mockPort + "/v1",
            apiKey: "sk-mock",
            model: "mock-model",
        });
        assert(savedMock.ok === true, "自定义 API 指向 mock 上游保存成功");
        const uaResult = await request("POST", "/api/prompt-enhancement/enhance", { draft: "帮我看看这段代码" });
        assert(uaResult.ok === true && uaResult.enhanced === "mock 改写结果", "mock 上游改写成功");
        const expectedRuntime = globalThis.navigator && globalThis.navigator.userAgent
            ? "runtime/" + navigator.userAgent.toLowerCase()
            : "runtime/node.js/" + process.version;
        const expectedUa = "ZCode/9.9.9-test ai-sdk/provider-utils/4.0.39 " + expectedRuntime;
        assert(capturedUserAgent.value === expectedUa,
            "上游 User-Agent 为客户端形态: " + (capturedUserAgent.value || "(空)"));

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
