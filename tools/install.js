// zcode-soul 一键安装：定位 ZCode → 写入本机配置 → 创建桌面快捷方式
//
// 用法：双击根目录 install.bat，或命令行执行 node tools/install.js
// 前置条件：Windows + Node.js 22+（建议 22.5+）+ 已安装 ZCode 桌面版
//
// 配置说明：config.json 为入库默认值；本机私有值（如 ZCode 安装在非默认位置时的
// zcodePath）写入 config.local.json（已被 .gitignore 忽略），launch.js 读取时覆盖合并。

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const LOCAL_CONFIG_FILE = path.join(ROOT, "config.local.json");
const SHORTCUT_SCRIPT = path.join(ROOT, "tools", "create-shortcut.ps1");

function readJsonIfExists(file) {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// 与 launch.js 的探测逻辑保持一致：仅覆盖常见安装位置，其余靠 config.local.json
function zcodePathCandidates() {
    const candidates = [];
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "ZCode", "ZCode.exe"));
    if (process.env.PROGRAMFILES) candidates.push(path.join(process.env.PROGRAMFILES, "ZCode", "ZCode.exe"));
    return candidates;
}

function saveLocalConfig(update) {
    const current = readJsonIfExists(LOCAL_CONFIG_FILE) || {};
    const merged = Object.assign({}, current, update);
    fs.writeFileSync(LOCAL_CONFIG_FILE, JSON.stringify(merged, null, 4) + "\n", "utf-8");
}

// 交互输入 ZCode.exe 完整路径，校验存在；直接回车返回空表示跳过
async function promptZcodePath() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        while (true) {
            const answer = (await rl.question("请输入 ZCode.exe 完整路径（直接回车跳过，稍后手动编辑 config.local.json）: "))
                .trim()
                .replace(/^"|"$/g, "");
            if (!answer) return "";
            if (fs.existsSync(answer)) return answer;
            console.log("  路径不存在，请重新输入。");
        }
    } finally {
        rl.close();
    }
}

async function main() {
    // 控制台切到 UTF-8，保证中文输出在默认 GBK 代码页的 cmd 窗口不乱码（无控制台的环境忽略失败）
    try { execSync("chcp.com 65001", { stdio: "ignore" }); } catch {}

    console.log("=== zcode-soul 安装 ===");
    console.log("");

    const [major] = process.versions.node.split(".").map(Number);
    if (major < 22) {
        console.log(`[x] Node 版本过低（当前 ${process.versions.node}），启动器需要 Node 22+，请先升级：https://nodejs.org/`);
        process.exit(1);
    }
    console.log(`[1/3] Node ${process.versions.node} 满足要求`);

    let zcodeExe = "";
    const baseConfig = readJsonIfExists(path.join(ROOT, "config.json")) || {};
    const localConfig = readJsonIfExists(LOCAL_CONFIG_FILE) || {};
    const configured = String(localConfig.zcodePath || baseConfig.zcodePath || "").trim();
    if (configured && fs.existsSync(configured)) {
        zcodeExe = configured;
        console.log(`[2/3] 使用已配置的 ZCode 路径: ${configured}`);
    } else {
        if (configured) console.log(`[!] 已配置的路径不存在: ${configured}`);
        const found = zcodePathCandidates().find((candidate) => fs.existsSync(candidate));
        if (found) {
            zcodeExe = found;
            console.log(`[2/3] 在常见安装位置找到 ZCode: ${found}`);
        } else if (!process.stdin.isTTY) {
            console.log("[2/3] 未在常见安装位置找到 ZCode，且当前为非交互环境");
            console.log("    请手动编辑 config.local.json 填入 zcodePath 后重新运行本脚本。");
        } else {
            console.log("[2/3] 未在常见安装位置找到 ZCode");
            const input = await promptZcodePath();
            if (input) {
                zcodeExe = input;
                saveLocalConfig({ zcodePath: input });
                console.log(`    已写入 ${path.basename(LOCAL_CONFIG_FILE)}: zcodePath = ${input}`);
            }
        }
    }

    console.log("[3/3] 创建桌面快捷方式");
    try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${SHORTCUT_SCRIPT}"`, { stdio: "inherit" });
    } catch (err) {
        console.log(`[x] 创建快捷方式失败：${err.message}`);
        console.log(`    可手动执行：powershell -NoProfile -ExecutionPolicy Bypass -File "${SHORTCUT_SCRIPT}"`);
        process.exit(1);
    }

    console.log("");
    console.log("安装完成：");
    if (zcodeExe) {
        console.log(`- ZCode: ${zcodeExe}`);
    } else {
        console.log("- ZCode 路径未确定：请编辑 config.local.json 填入 zcodePath 后重新运行本脚本。");
    }
    console.log("- 双击桌面「ZCode (soul)」启动 ZCode 并自动注入插件");
    console.log("- 扩展管理页: http://127.0.0.1:9340/");
}

main().catch((err) => {
    console.error(`[x] 安装失败：${err && err.stack ? err.stack : err}`);
    process.exit(1);
});
