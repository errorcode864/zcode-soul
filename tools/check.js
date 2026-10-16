// 全仓语法检查（node tools/check.js）：零依赖，用 vm.Script 做编译期检查不执行代码。
// 遍历所有 .js 文件；.html 提取内嵌 <script> 块逐段检查。任一失败退出码为 1。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set([".git", ".idea", ".vscode", ".zcode", "data", "tmp", "node_modules", "reference"]);
const SKIP_FILES = new Set(["IntlProvider.js", "styles-main.js"]); // 逆向参考产物，非本项目源码

const files = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walk(full);
            continue;
        }
        if (SKIP_FILES.has(entry.name)) continue;
        if (/^extracted-.*\.js$/.test(entry.name)) continue; // 逆向解包的 ESM 产物，非本项目源码
        if (entry.name.endsWith(".js") || entry.name.endsWith(".html")) files.push(full);
    }
})(ROOT);

let failed = 0;
for (const file of files) {
    const rel = path.relative(ROOT, file);
    try {
        if (file.endsWith(".html")) {
            const html = fs.readFileSync(file, "utf8");
            const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
            let match;
            let index = 0;
            while ((match = re.exec(html))) {
                const code = match[1].trim();
                if (!code) continue; // 外链 script 标签内容为空
                index += 1;
                new vm.Script(code, { filename: rel + "#script" + index });
            }
        } else {
            new vm.Script(fs.readFileSync(file, "utf8"), { filename: rel });
        }
        console.log("OK    " + rel);
    } catch (err) {
        failed += 1;
        console.log("FAIL  " + rel + ": " + err.message);
    }
}
console.log(failed ? failed + " 个文件语法检查失败" : "全部通过（" + files.length + " 个文件）");
process.exit(failed ? 1 : 0);
