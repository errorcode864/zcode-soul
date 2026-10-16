// 注入计划（探测热更）单元验证：require 复制的 launch.js，对 buildInjectPlan 的纯逻辑
// 与全部生成产物（runtime/注入/卸载/探测代码）做断言，不启动服务、不依赖 CDP。
// 临时目录残留由系统 temp 自动清理。用法：node test/verify-inject-plan.js
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-soul-plan-"));
fs.copyFileSync(path.join(ROOT, "launch.js"), path.join(tmpDir, "launch.js"));
// launch.js 顶层 require lib 平台模块，临时目录需一并复制
fs.cpSync(path.join(ROOT, "lib"), path.join(tmpDir, "lib"), { recursive: true });
fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
    zcodePath: "",
    debugPort: 9333,
    statsPort: 9340,
    pollIntervalMs: 5000,
    openManager: false,
}, null, 4));
const launcher = require(path.join(tmpDir, "launch.js"));

const PLUGINS_DIR = path.join(ROOT, "plugins");
const PLUGIN_IDS = [
    "usage-popup-plus",
    "usage-panel-plus",
    "manager-panel-plus",
    "prompt-enhancement-plus",
];
const plugins = PLUGIN_IDS.map((id) => ({ id, dir: path.join(PLUGINS_DIR, id), inject: ["main.js"] }));

function check(name, cond, detail) {
    console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : ""));
    if (!cond) process.exitCode = 1;
}

// 构造「全部插件已注入且 hash 一致」的页面状态
function freshPage() {
    const hashes = {};
    for (const p of plugins) hashes[p.id] = launcher.buildPluginInject(p).hash;
    return {
        version: launcher.RUNTIME_VERSION,
        registryIds: [...PLUGIN_IDS],
        hashes,
    };
}

// [1] 探测失败回退全量
const full = launcher.buildInjectPlan(plugins, {}, null);
check("探测失败回退全量计划（runtime + 4 个插件）", full.length === 5,
    "plan=" + full.map((p) => p.label).join(","));

// [2] 页面状态与期望一致 → 空计划（稳态零注入）
const steady = launcher.buildInjectPlan(plugins, {}, freshPage());
check("状态一致时计划为空（跳过注入）", steady.length === 0,
    "plan=" + JSON.stringify(steady.map((p) => p.label)));

// [3] 源码变化（hash 失配）→ 先卸载旧实例再注入新代码（热更）
const staleHashes = freshPage().hashes;
staleHashes["usage-panel-plus"] = "outdated000";
const hot = launcher.buildInjectPlan(plugins, {}, {
    version: launcher.RUNTIME_VERSION,
    registryIds: [...PLUGIN_IDS],
    hashes: staleHashes,
});
const hotLabels = hot.map((p) => p.label);
check("hash 失配生成热更卸载", hotLabels.includes("usage-panel-plus(热更卸载)"), hotLabels.join(","));
check("热更卸载后跟新版注入", hotLabels.indexOf("usage-panel-plus(热更卸载)") < hotLabels.indexOf("usage-panel-plus"),
    hotLabels.join(","));
check("未变化的插件不产生计划", !hotLabels.includes("usage-popup-plus"), hotLabels.join(","));

// [4] 已注入的插件被禁用 → 卸载
const off = launcher.buildInjectPlan(plugins, { "usage-panel-plus": false }, freshPage());
check("禁用已注入插件生成卸载计划", off.length === 1 && off[0].label === "usage-panel-plus(卸载)",
    "plan=" + off.map((p) => p.label).join(","));

// [5] 注册表残留已删除的插件 → 清理卸载
const ghost = launcher.buildInjectPlan(plugins, {}, {
    ...freshPage(),
    registryIds: [...PLUGIN_IDS, "ghost-plus"],
});
check("已删除插件的残留注册被清理", ghost.length === 1 && ghost[0].label === "ghost-plus(卸载)",
    "plan=" + ghost.map((p) => p.label).join(","));

// [6] runtime 版本不匹配 → 重注入运行时
const oldRuntime = launcher.buildInjectPlan(plugins, {}, { ...freshPage(), version: "0.2.0" });
check("runtime 版本不匹配触发重注入", oldRuntime.some((p) => p.label === "runtime"),
    "plan=" + oldRuntime.map((p) => p.label).join(","));

// [7] hash 相同但注册表缺失（上次注入中断）→ 补注入
const broken = launcher.buildInjectPlan(plugins, {}, {
    version: launcher.RUNTIME_VERSION,
    registryIds: PLUGIN_IDS.filter((id) => id !== "usage-popup-plus"),
    hashes: freshPage().hashes,
});
check("注册缺失的插件被补注入", broken.length === 1 && broken[0].label === "usage-popup-plus",
    "plan=" + broken.map((p) => p.label).join(","));

// [8] 生成产物必须可被引擎解析：生成代码的语法错误（如对象字面量里混入分号）
// 是计划结构断言拦不住的类别，必须对所有下发代码做 vm 解析
function parseable(code) {
    try {
        new vm.Script(code);
        return true;
    } catch {
        return false;
    }
}
check("runtime 代码可解析", parseable(launcher.RUNTIME_SNIPPET));
check("探测代码可解析", parseable(launcher.PROBE_SNIPPET));
for (const p of plugins) {
    const built = launcher.buildPluginInject(p);
    check(p.id + " 注入代码可解析", parseable(built.code));
    check(p.id + " 卸载代码可解析", parseable(launcher.buildUnloader(p.id)));
}

// [9] 注入代码首行（prefix + hash 登记）在裸 window 上下文执行后须完成登记，
// 保证 runtime 缺席时插件 prefix 也能自建 __zcodeSoul 骨架
for (const p of plugins) {
    const built = launcher.buildPluginInject(p);
    const line0 = built.code.slice(0, built.code.indexOf("\n"));
    const fakeWindow = {};
    try {
        vm.runInNewContext(line0, { window: fakeWindow });
        const registered = !!(fakeWindow.__zcodeSoul && fakeWindow.__zcodeSoul.hashes
            && fakeWindow.__zcodeSoul.hashes[p.id] === built.hash);
        check(p.id + " prefix 执行完成 hash 登记", registered);
    } catch (err) {
        check(p.id + " prefix 执行完成 hash 登记", false, err.message);
    }
}

// [10] 语法损坏的插件源码：buildPluginInject 返回 null，计划跳过且不卸载页面旧实例
//（旧版继续显示，文件写完后的巡检轮按 hash 失配自动补注入）
const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-soul-broken-"));
fs.writeFileSync(path.join(brokenDir, "plugin.json"),
    JSON.stringify({ id: "broken-plus", inject: ["main.js"] }));
fs.writeFileSync(path.join(brokenDir, "main.js"), "(function(){var x=;})();");
const brokenPlugins = [{ id: "broken-plus", dir: brokenDir, inject: ["main.js"] }];
check("语法损坏插件 buildPluginInject 返回 null", launcher.buildPluginInject(brokenPlugins[0]) === null);
const brokenFull = launcher.buildInjectPlan(brokenPlugins, {}, null);
check("全量计划跳过语法损坏插件", brokenFull.length === 1 && brokenFull[0].label === "runtime",
    "plan=" + brokenFull.map((p) => p.label).join(","));
const brokenHot = launcher.buildInjectPlan(brokenPlugins, {}, {
    version: launcher.RUNTIME_VERSION,
    registryIds: ["broken-plus"],
    hashes: { "broken-plus": "old000000" },
});
check("热更计划跳过语法损坏插件且不卸载旧实例", brokenHot.length === 0,
    "plan=" + brokenHot.map((p) => p.label).join(","));

// [11] runtime 共享工具 currentSessionId：DOM 属性优先；缺失时回退 localStorage
// 每工作区键（zcode-v4-last-session:*），多键值冲突或值非法时保守返回 null
function evalCurrentSessionId(doc, lsStore) {
    const keys = Object.keys(lsStore);
    const stub = {
        length: keys.length,
        key: (i) => (i >= 0 && i < keys.length ? keys[i] : null),
        getItem: (k) => (Object.prototype.hasOwnProperty.call(lsStore, k) ? lsStore[k] : null),
    };
    const fakeWindow = {};
    vm.runInNewContext(launcher.RUNTIME_SNIPPET, {
        window: fakeWindow,
        document: doc,
        localStorage: stub,
    });
    return fakeWindow.__zcodeSoul.shared.currentSessionId();
}
const domHit = { querySelector: () => ({ getAttribute: () => "sess_dom" }) };
check("currentSessionId：DOM 属性优先", evalCurrentSessionId(domHit, {
    "zcode-v4-last-session:v1:C:\\ws": "sess_ls",
}) === "sess_dom");
const domMiss = { querySelector: () => null };
check("currentSessionId：DOM 无值回退 localStorage 单键", evalCurrentSessionId(domMiss, {
    "zcode-v4-last-session:v1:C:\\ws": "sess_a",
}) === "sess_a");
check("currentSessionId：多键同值返回该值", evalCurrentSessionId(domMiss, {
    "zcode-v4-last-session:v1:C:\\ws1": "sess_a",
    "zcode-v4-last-session:v1:C:\\ws2": "sess_a",
}) === "sess_a");
check("currentSessionId：多键异值保守返回 null", evalCurrentSessionId(domMiss, {
    "zcode-v4-last-session:v1:C:\\ws1": "sess_a",
    "zcode-v4-last-session:v1:C:\\ws2": "sess_b",
}) === null);
check("currentSessionId：非法字符值被忽略", evalCurrentSessionId(domMiss, {
    "zcode-v4-last-session:v1:C:\\ws": "bad sid!",
}) === null);
check("currentSessionId：非目标键被忽略", evalCurrentSessionId(domMiss, {
    "other-key": "sess_x",
}) === null);
check("currentSessionId：DOM 属性为空串时走兜底", evalCurrentSessionId(
    { querySelector: () => ({ getAttribute: () => "" }) },
    { "zcode-v4-last-session:v1:C:\\ws": "sess_a" }
) === "sess_a");

console.log(process.exitCode ? "结果: 存在失败项" : "结果: 全部通过");
