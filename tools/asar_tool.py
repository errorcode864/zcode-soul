# -*- coding: utf-8 -*-
"""asar 静态分析小工具：list / grep / extract。

用法：
    python asar_tool.py list   <asar路径> [路径过滤前缀]
    python asar_tool.py grep   <asar路径> <关键词> [路径过滤前缀]
    python asar_tool.py extract <asar路径> <包内路径> <输出文件>
"""

import json
import struct
import sys


def load_header(fin):
    """读取 asar 头部 JSON 与数据区起始偏移。"""
    fin.seek(0)
    _, pickle_size, _obj_size, str_size = struct.unpack("<4I", fin.read(16))
    header = json.JSONDecoder().raw_decode(fin.read(str_size).decode("utf-8"))[0]
    return header, 8 + pickle_size


def walk(node, path=""):
    """遍历头节点，产出 (路径, 元数据)。"""
    if "files" in node:
        for name, child in node["files"].items():
            yield from walk(child, path + chr(92) + name)
    else:
        yield path, node


def main():
    mode, asar_path = sys.argv[1], sys.argv[2]
    with open(asar_path, "rb") as fin:
        header, base = load_header(fin)
        items = list(walk(header))

        if mode == "list":
            prefix = sys.argv[3] if len(sys.argv) > 3 else ""
            for path, meta in items:
                if path.startswith(prefix):
                    print(meta.get("size", 0), path)
        elif mode == "grep":
            needle = sys.argv[3].encode("utf-8")
            prefix = sys.argv[4] if len(sys.argv) > 4 else chr(92) + "out" + chr(92) + "renderer"
            for path, meta in items:
                if not path.startswith(prefix) or not path.endswith((".js", ".mjs", ".html", ".css")):
                    continue
                size = meta.get("size", 0)
                if size <= 0 or size > 9000000:
                    continue
                fin.seek(base + int(meta["offset"]))
                if needle in fin.read(size):
                    print("命中:", path, "大小:", size)
        elif mode == "extract":
            inner, out_path = sys.argv[3], sys.argv[4]
            for path, meta in items:
                if path == inner:
                    fin.seek(base + int(meta["offset"]))
                    data = fin.read(meta["size"])
                    with open(out_path, "wb") as fout:
                        fout.write(data)
                    print("已提取:", path, "大小:", meta["size"])
                    return
            print("未找到:", inner)
            sys.exit(1)


if __name__ == "__main__":
    main()
