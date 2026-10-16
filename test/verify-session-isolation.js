// 会话隔离修复的端到端验证：复制 launch.js 到临时目录、改端口、以 ZCODE_SOUL_NO_APP=1
// 拉起独立服务实例，断言 /stats 与 /stats/stream 按 session 参数精准返回，
// 不触碰 9340 端口的真实启动器。用法：node test/verify-session-isolation.js
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PORT = 9341;
const ROLLOUT_DIR = path.join(os.homedir(), ".zcode", "cli", "rollout");

// 从真实 rollout 目录取两个现存会话 ID 做断言
function pickSessionIds() {
    const names = fs.readdirSync(ROLLOUT_DIR)
        .filter((n) => /^model-io-sess_.*\.jsonl$/.test(n) && !n.includes("subagent"));
    if (names.length < 1) throw new Error("rollout 目录没有主会话记录，无法验证");
    return names.map((n) => n.replace(/^model-io-/, "").replace(/\.jsonl$/, ""));
}

function getJson(urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: PORT, path: urlPath }, (res) => {
            let raw = "";
            res.on("data", (c) => { raw += c; });
            res.on("end", () => {
                try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
            });
        }).on("error", reject);
    });
}

// 读取 SSE 首个 data 帧后立即断开
function getFirstSseFrame(urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port: PORT, path: urlPath }, (res) => {
            let raw = "";
            res.on("data", (c) => {
                raw += c;
                const m = raw.match(/^data: (.+)$/m);
                if (m) {
                    try { res.destroy(); } catch {}
                    try { resolve(JSON.parse(m[1])); } catch (err) { reject(err); }
                }
            });
        });
        req.on("error", (err) => {
            if (!rawDone) reject(err);
        });
        let rawDone = false;
        const orig = req.emit;
        req.emit = function (event, ...args) {
            if (event === "response") rawDone = false;
            return orig.call(this, event, ...args);
        };
        setTimeout(() => {
            try { req.destroy(); } catch {}
            reject(new Error("SSE 首帧超时"));
        }, 5000).unref();
    });
}

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail: detail || "" });
    console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : ""));
}

(async () => {
    const [mainSid, otherSid] = pickSessionIds();
    const missingSid = "sess_00000000-0000-4000-8000-000000000000";

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-soul-verify-"));
    fs.copyFileSync(path.join(ROOT, "launch.js"), path.join(tmpDir, "launch.js"));
    // launch.js 顶层 require lib 平台模块，临时目录需一并复制
    fs.cpSync(path.join(ROOT, "lib"), path.join(tmpDir, "lib"), { recursive: true });
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
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (c) => process.stderr.write("[verify-instance] " + c));

    try {
        // 等待服务就绪
        let ready = false;
        for (let i = 0; i < 20 && !ready; i++) {
            await new Promise((r) => setTimeout(r, 300));
            try { await getJson("/api/plugins"); ready = true; } catch {}
        }
        if (!ready) throw new Error("验证服务启动超时");

        // 1. 指定会话：精准返回该会话数据
        const p1 = await getJson("/stats?session=" + encodeURIComponent(mainSid));
        check("指定会话返回该会话数据",
            p1.ok && p1.sessionId === mainSid && !p1.empty && p1.totals && p1.totals.requests > 0,
            "sessionId=" + p1.sessionId + ", requests=" + (p1.totals && p1.totals.requests));

        // 2. 指定另一会话：返回的是另一会话（而非最新文件）
        let otherDiffers = true;
        if (otherSid) {
            const p2 = await getJson("/stats?session=" + encodeURIComponent(otherSid));
            otherDiffers = p2.ok && p2.sessionId === otherSid;
            check("另一会话返回其自身数据", otherDiffers, "sessionId=" + p2.sessionId);
        }

        // 3. 不存在的会话：空快照，绝不回退到最新文件
        const p3 = await getJson("/stats?session=" + encodeURIComponent(missingSid));
        check("无记录会话返回空快照",
            p3.ok && p3.empty === true && p3.sessionId === missingSid &&
            p3.totals && p3.totals.requests === 0,
            "empty=" + p3.empty + ", requests=" + (p3.totals && p3.totals.requests));

        // 4. 不带 session：保持旧行为兜底（返回最新文件）
        const p4 = await getJson("/stats");
        check("无 session 参数保持兜底行为",
            p4.ok && !p4.empty && typeof p4.sessionId === "string" && p4.sessionId.length > 0,
            "sessionId=" + p4.sessionId);

        // 5. SSE 分流：A 会话连接只收 A 的数据
        const f1 = await getFirstSseFrame("/stats/stream?session=" + encodeURIComponent(mainSid));
        check("SSE 按 session 分流（主会话）",
            f1.ok && f1.sessionId === mainSid,
            "frame sessionId=" + f1.sessionId);

        if (otherSid) {
            const f2 = await getFirstSseFrame("/stats/stream?session=" + encodeURIComponent(otherSid));
            check("SSE 按 session 分流（另一会话）",
                f2.ok && f2.sessionId === otherSid,
                "frame sessionId=" + f2.sessionId);
        }

        // 6. SSE 无记录会话：连接即收空快照帧
        const f3 = await getFirstSseFrame("/stats/stream?session=" + encodeURIComponent(missingSid));
        check("SSE 无记录会话返回空快照帧",
            f3.ok && f3.empty === true && f3.sessionId === missingSid,
            "empty=" + f3.empty);
    } finally {
        child.kill();
    }

    const failed = results.filter((r) => !r.pass);
    console.log(failed.length ? "\n结果: " + failed.length + " 项失败" : "\n结果: 全部通过");
    process.exit(failed.length ? 1 : 0);
})().catch((err) => {
    console.error("验证脚本异常:", err.message);
    process.exit(1);
});
