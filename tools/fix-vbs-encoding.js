// 把指定 .vbs 转成 WSH 支持的 UTF-16 LE（带 BOM）+ CRLF 编码。
// wscript 按 ANSI(GBK) 读取无 BOM 的 UTF-8 脚本，中文注释会破坏解析（报 800A0401 语句未结束）。
// 幂等：对已是 UTF-16 LE 的输入直接规范化，避免把 UTF-16 当 UTF-8 二次转码
// （曾因此产出"每个字符后夹两个 0x00"的坏文件，wscript 报 800A0408 无效字符）；
// 若解码后字符间仍夹 NUL，判定为历史双重编码产物，剥离 NUL 修复结构。
// 用法：node tools/fix-vbs-encoding.js <vbs 路径> [更多路径...]
const fs = require("node:fs");
const path = require("node:path");

const files = process.argv.slice(2);
if (!files.length) {
    console.error("用法: node tools/fix-vbs-encoding.js <vbs 路径> [更多路径...]");
    process.exit(1);
}

for (const file of files) {
    const p = path.resolve(file);
    const raw = fs.readFileSync(p);
    let text;
    if (raw[0] === 0xFF && raw[1] === 0xFE) {
        text = raw.subarray(2).toString("utf16le");
        if (text.includes("\u0000")) {
            text = text.replace(/\u0000/g, "");
            console.warn("检测到双重编码残留（字符间夹 NUL），已剥离修复：", p);
        }
    } else {
        text = raw.toString("utf8").replace(/^\ufeff/, "");
    }
    text = text.replace(/\r?\n/g, "\r\n");
    const bom = Buffer.from([0xFF, 0xFE]);
    fs.writeFileSync(p, Buffer.concat([bom, Buffer.from(text, "utf16le")]));
    console.log("已转码(UTF-16 LE BOM + CRLF):", p);
}
