// 起一个隔离的本地服务实例专供浏览器 fixture 验证：
// 复制 launch.js + plugins + 插件开关到临时目录，端口固定 9341，
// 以 ZCODE_SOUL_NO_APP=1 运行（不拉起 ZCode、不注入、不影响 9340 真实启动器）。
// 常驻直到被终止。用法：node test/serve-fixture-instance.js
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PORT = 9341;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-soul-fixture-"));
fs.copyFileSync(path.join(ROOT, "launch.js"), path.join(tmpDir, "launch.js"));
// launch.js 顶层 require lib 平台模块，临时目录需一并复制
fs.cpSync(path.join(ROOT, "lib"), path.join(tmpDir, "lib"), { recursive: true });
fs.cpSync(path.join(ROOT, "plugins"), path.join(tmpDir, "plugins"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "test"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "test", "fixture.html"), path.join(tmpDir, "test", "fixture.html"));
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
try {
    fs.copyFileSync(path.join(ROOT, "data", "plugins-state.json"), path.join(tmpDir, "data", "plugins-state.json"));
} catch {
    // 无状态文件时全部插件默认启用
}
fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
    zcodePath: "",
    debugPort: 9333,
    statsPort: PORT,
    pollIntervalMs: 5000,
    openManager: false,
}, null, 4));

const child = spawn(process.execPath, ["launch.js"], {
    cwd: tmpDir,
    env: Object.assign({}, process.env, { ZCODE_SOUL_NO_APP: "1" }),
    stdio: ["ignore", "inherit", "inherit"],
});

function stop() {
    try { child.kill(); } catch {}
    process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

(async () => {
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 300));
        try {
            await new Promise((resolve, reject) => {
                http.get({ host: "127.0.0.1", port: PORT, path: "/api/plugins" }, (res) => {
                    res.resume();
                    res.on("end", resolve);
                }).on("error", reject);
            });
            console.log("READY fixture: http://127.0.0.1:" + PORT + "/fixture （临时实例目录: " + tmpDir + "）");
            return;
        } catch {}
    }
    console.error("服务就绪超时");
    stop();
})();
