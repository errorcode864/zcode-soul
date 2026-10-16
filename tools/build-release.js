// zcode-soul 发行包构建：组装免安装的 Windows 分发包（内嵌 Node 运行时，用户机器无需安装 Node）
//
// 用法：node tools/build-release.js
// 前置条件：打包机已安装 Node 22+（内嵌的 node.exe 复制自当前运行的 process.execPath，
// 官方发行版的 node.exe 为单文件可独立运行；需要嵌入指定版本时先用该版本 Node 运行本脚本）
// 产物（dist/，已 gitignore）：
//   zcode-soul-v<版本>-win-x64/      发行目录：node.exe + 全部运行文件 + install.bat
//   zcode-soul-v<版本>-win-x64.zip   Release 附件（PowerShell Compress-Archive）
//
// 发行包使用方式：解压到任意固定目录 → 双击 install.bat（用包内 node.exe 完成定位 ZCode、
// 写入 config.local.json、创建桌面快捷方式）→ 双击桌面「ZCode (soul)」。

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

// 版本单一来源：launch.js 的 APP_VERSION，避免多处维护漏同步
const VERSION = (fs.readFileSync(path.join(ROOT, "launch.js"), "utf8")
    .match(/const APP_VERSION = "([^"]+)"/) || [])[1];
if (!VERSION) throw new Error("launch.js 中未找到 APP_VERSION，构建中止");

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.isDirectory()) copyDir(path.join(src, entry.name), path.join(dest, entry.name));
        else fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
    }
}

function main() {
    const [major] = process.versions.node.split(".").map(Number);
    if (major < 22) {
        throw new Error("打包机 Node 版本过低（当前 " + process.versions.node +
            "）：内嵌的 node.exe 随包分发，请用 Node 22+ 运行本脚本");
    }

    const appDir = path.join(DIST, "zcode-soul-v" + VERSION + "-win-x64");
    // 不先清空目录（可能被占用），逐文件覆盖写入
    fs.mkdirSync(appDir, { recursive: true });

    // 1) 内嵌 Node 运行时（发行包双击即用、无需用户安装 Node）
    fs.copyFileSync(process.execPath, path.join(appDir, "node.exe"));

    // 2) 运行文件：启动器 / 管理页 / 配置模板 / 插件 / 启动入口 / 安装入口
    for (const file of ["launch.js", "manager.html", "config.json", "zcode-soul.vbs",
        "install.bat", "README.md", "LICENSE"]) {
        fs.copyFileSync(path.join(ROOT, file), path.join(appDir, file));
    }
    copyDir(path.join(ROOT, "lib"), path.join(appDir, "lib"));
    copyDir(path.join(ROOT, "plugins"), path.join(appDir, "plugins"));
    fs.mkdirSync(path.join(appDir, "tools"), { recursive: true });
    for (const file of ["install.js", "create-shortcut.ps1"]) {
        fs.copyFileSync(path.join(ROOT, "tools", file), path.join(appDir, "tools", file));
    }

    // 3) 打 zip（PowerShell Compress-Archive，Windows 自带，无第三方依赖）
    const zipPath = path.join(DIST, "zcode-soul-v" + VERSION + "-win-x64.zip");
    const ps = "Compress-Archive -Path '" + appDir.replace(/'/g, "''") + "\\*' -DestinationPath '" +
        zipPath.replace(/'/g, "''") + "' -Force";
    execSync("powershell -NoProfile -Command \"" + ps + "\"", { stdio: "inherit" });

    const sizeMB = (fs.statSync(zipPath).size / 1048576).toFixed(1);
    console.log("构建完成：");
    console.log("  " + appDir + "（发行目录，双击 install.bat 安装）");
    console.log("  " + zipPath + "（" + sizeMB + " MB，Release 附件；内嵌 Node " + process.versions.node + "）");
}

main();
