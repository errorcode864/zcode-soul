// 历史回填端到端验证：复制 launch.js 到临时目录，用假 USERPROFILE（手造 model_usage
// 数据库 + 半截 rollout 文件）拉起独立服务实例，断言文件只剩部分历史时 /stats 会把
// 文件首条之前的数据库请求合并进聚合值，且边界不漏算、不双计。不触碰 9340 端口的
// 真实启动器与真实 ~/.zcode 数据。用法：node test/verify-history-backfill.js
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const PORT = 9343;

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail: detail || "" });
    console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : ""));
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

// 构造 model-io 记录行：与官方文件同 schema（collectStats 只读这些字段）
function record(startedAt, durationSec, usage, toolCalls) {
    return JSON.stringify({
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(startedAt + durationSec * 1000).toISOString(),
        durationMs: durationSec * 1000,
        requestId: "req-" + startedAt + "-" + durationSec,
        model: { modelId: "test-model", providerId: "test" },
        querySource: "main_turn",
        response: { usage, toolCalls: toolCalls || [] },
    });
}

(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-soul-backfill-"));
    const fakeHome = path.join(tmpDir, "home");
    const rolloutDir = path.join(fakeHome, ".zcode", "cli", "rollout");
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.mkdirSync(path.join(fakeHome, ".zcode", "cli", "db"), { recursive: true });
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

    // 时间线（ms）：sess_bf 文件只有 2 条记录（模拟重启续接后重建），
    // 库里有 5 条更早请求 + 1 条落在 2s 边界间隔内的行 + 2 条与文件同源的镜像行；
    // 期望合并为 7 轮：5 条历史计入，边界行与镜像行被间隔守卫排除
    const now = Date.now();
    const fileFirst = now - 3600 * 1000;
    const usage = (i, o, c) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o, cacheReadTokens: c });
    const dbRows = [];
    for (let i = 0; i < 5; i++) {
        dbRows.push({ sid: "sess_bf", qs: "main_turn", startedAt: fileFirst - (9 - i) * 60000,
            completedAt: fileFirst - (9 - i) * 60000 + 20000,
            input: 30000 + i * 100, output: 200 + i, cache: 20000 + i * 64,
            reasoning: 50, tools: 1, duration: 20000 });
    }
    dbRows.push({ sid: "sess_bf", qs: "main_turn", startedAt: fileFirst - 100,
        completedAt: fileFirst + 5000, input: 99999, output: 99999, cache: 0,
        reasoning: 0, tools: 0, duration: 5100 });
    dbRows.push({ sid: "sess_bf", qs: "main_turn", startedAt: fileFirst,
        completedAt: fileFirst + 15000, input: 40000, output: 500, cache: 30000,
        reasoning: 10, tools: 2, duration: 15000 });
    dbRows.push({ sid: "sess_bf", qs: "main_turn", startedAt: fileFirst + 30000,
        completedAt: fileFirst + 45000, input: 41000, output: 600, cache: 31000,
        reasoning: 10, tools: 0, duration: 15000 });
    fs.writeFileSync(path.join(rolloutDir, "model-io-sess_bf.jsonl"),
        record(fileFirst, 15, usage(40000, 500, 30000), [{ name: "Bash" }, { name: "Bash" }]) + "\n" +
        record(fileFirst + 30000, 15, usage(41000, 600, 31000)) + "\n");

    // sess_plain：文件完整、库里没有更早的行 → 不回填，保持纯文件口径
    fs.writeFileSync(path.join(rolloutDir, "model-io-sess_plain.jsonl"),
        record(now - 60000, 10, usage(20000, 300, 15000)) + "\n");
    dbRows.push({ sid: "sess_plain", qs: "main_turn", startedAt: now - 60000,
        completedAt: now - 45000, input: 20000, output: 300, cache: 15000,
        reasoning: 0, tools: 0, duration: 10000 });

    // sess_empty：文件已建但还没记录落盘（续接瞬间）→ 回填全部历史，
    // context.used 用库里最新一行的输入 token 修正
    fs.writeFileSync(path.join(rolloutDir, "model-io-sess_empty.jsonl"), "");
    dbRows.push({ sid: "sess_empty", qs: "main_turn", startedAt: now - 3 * 60000,
        completedAt: now - 2 * 60000, input: 50000, output: 800, cache: 40000,
        reasoning: 0, tools: 0, duration: 60000 });
    dbRows.push({ sid: "sess_empty", qs: "main_turn", startedAt: now - 60000,
        completedAt: now - 30000, input: 52000, output: 900, cache: 41000,
        reasoning: 0, tools: 0, duration: 30000 });

    // 干扰行：别的会话、非 main_turn，都不得计入
    dbRows.push({ sid: "sess_other", qs: "main_turn", startedAt: now - 9 * 60000,
        completedAt: now - 8 * 60000, input: 1, output: 1, cache: 0,
        reasoning: 0, tools: 0, duration: 1000 });
    dbRows.push({ sid: "sess_bf", qs: "title", startedAt: fileFirst - 5 * 60000,
        completedAt: fileFirst - 4 * 60000, input: 2, output: 2, cache: 0,
        reasoning: 0, tools: 0, duration: 1000 });

    const db = new DatabaseSync(path.join(fakeHome, ".zcode", "cli", "db", "db.sqlite"));
    db.exec("CREATE TABLE model_usage (\n" +
        "    session_id TEXT,\n" +
        "    query_source TEXT,\n" +
        "    status TEXT,\n" +
        "    started_at INTEGER,\n" +
        "    completed_at INTEGER,\n" +
        "    duration_ms INTEGER,\n" +
        "    input_tokens INTEGER,\n" +
        "    output_tokens INTEGER,\n" +
        "    reasoning_tokens INTEGER,\n" +
        "    cache_read_input_tokens INTEGER,\n" +
        "    computed_total_tokens INTEGER,\n" +
        "    tool_call_count INTEGER)");
    const ins = db.prepare("INSERT INTO model_usage (session_id, query_source, status," +
        " started_at, completed_at, duration_ms, input_tokens, output_tokens," +
        " reasoning_tokens, cache_read_input_tokens, computed_total_tokens, tool_call_count)" +
        " VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const r of dbRows) {
        ins.run(r.sid, r.qs, r.startedAt, r.completedAt, r.duration,
            r.input, r.output, r.reasoning, r.cache, r.input + r.output, r.tools);
    }
    db.close();

    const child = spawn(process.execPath, ["launch.js"], {
        cwd: tmpDir,
        env: Object.assign({}, process.env, {
            ZCODE_SOUL_NO_APP: "1",
            USERPROFILE: fakeHome,
        }),
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (c) => process.stderr.write("[verify-instance] " + c));

    try {
        let ready = false;
        for (let i = 0; i < 20 && !ready; i++) {
            await new Promise((r) => setTimeout(r, 300));
            try { await getJson("/api/plugins"); ready = true; } catch {}
        }
        if (!ready) throw new Error("验证服务启动超时");

        // 1. 半截历史会话：合并数据库历史
        const p1 = await getJson("/stats?session=sess_bf");
        check("半截历史会话标记 file+sqlite 来源",
            p1.ok && p1.source === "file+sqlite",
            "source=" + p1.source + ", backfill=" + JSON.stringify(p1.backfill));
        check("请求数 = 文件 2 + 库中历史 5（边界行不双计）",
            p1.totals && p1.totals.requests === 7,
            "requests=" + (p1.totals && p1.totals.requests));
        const historyRows = dbRows.filter((r) =>
            r.sid === "sess_bf" && r.qs === "main_turn" && r.startedAt < fileFirst - 2000);
        const expectTokens = historyRows.reduce((s, r) => s + r.input + r.output, 0) +
            (40000 + 500) + (41000 + 600);
        check("总 token = 文件 + 库中历史",
            p1.totals && p1.totals.totalTokens === expectTokens,
            "totalTokens=" + (p1.totals && p1.totals.totalTokens) + ", 期望=" + expectTokens);
        check("回填元数据正确",
            p1.backfill && p1.backfill.requests === 5 &&
            p1.backfill.totalTokens === historyRows.reduce((s, r) => s + r.input + r.output, 0),
            JSON.stringify(p1.backfill));
        const expectSeconds = (fileFirst + 45000 - (fileFirst - 9 * 60000)) / 1000;
        check("会话时长从历史首条起算",
            p1.time && p1.time.sessionSeconds === expectSeconds,
            "sessionSeconds=" + (p1.time && p1.time.sessionSeconds) + ", 期望=" + expectSeconds);
        check("缓存命中率按合并后重算",
            p1.totals && p1.totals.cacheHitRate > 0 && p1.totals.cacheHitRate < 100,
            "cacheHitRate=" + (p1.totals && p1.totals.cacheHitRate));
        check("工具调用次数含历史（库 5 次 + 文件 2 次）",
            p1.tools && p1.tools.calls === 7,
            "calls=" + (p1.tools && p1.tools.calls));

        // 2. 完整会话：不回填，保持纯文件口径
        const p2 = await getJson("/stats?session=sess_plain");
        check("完整会话不回填",
            p2.ok && p2.source === "file" && !p2.backfill &&
            p2.totals && p2.totals.requests === 1,
            "source=" + p2.source + ", requests=" + (p2.totals && p2.totals.requests));

        // 3. 空文件会话（续接瞬间）：回填全部历史并修正 context
        const p3 = await getJson("/stats?session=sess_empty");
        check("空文件会话回填全部历史",
            p3.ok && p3.source === "file+sqlite" && p3.totals && p3.totals.requests === 2,
            "source=" + p3.source + ", requests=" + (p3.totals && p3.totals.requests));
        check("空文件会话 context 用库里最新输入修正",
            p3.context && p3.context.used === 52000,
            "used=" + (p3.context && p3.context.used));

        // 4. SSE 首帧同样带合并结果
        const frame = await new Promise((resolve, reject) => {
            const req = http.get({ host: "127.0.0.1", port: PORT,
                path: "/stats/stream?session=sess_bf" }, (res) => {
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
            req.on("error", reject);
            setTimeout(() => { try { req.destroy(); } catch {} reject(new Error("SSE 首帧超时")); }, 5000).unref();
        });
        check("SSE 首帧带合并结果",
            frame.ok && frame.source === "file+sqlite" &&
            frame.totals && frame.totals.requests === 7,
            "requests=" + (frame.totals && frame.totals.requests));
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
