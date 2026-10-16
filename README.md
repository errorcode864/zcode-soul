<div align="center">
  <br />
  <br />
  <img src="assets/icon.svg" width="112" alt="zcode-soul 图标" />
  <h1 style="margin: 8px 0 0">zcode-soul</h1>
  <h3 style="margin: 20px 0 10px">给 ZCode 注入灵魂</h3>
  <p style="margin: 0 0 14px"><strong>ZCode 桌面版 CDP 注入式插件框架：不修改 ZCode 安装文件（不改 app.asar），<br />
  通过 CDP 向渲染进程注入插件脚本，ZCode 升级不受影响</strong></p>
  <p style="margin: 0 0 12px">零依赖启动器 · 插件热更新 · 应用内管理面板 · 会话级用量统计 · Windows</p>
  <br />
  <p><a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a></p>
</div>

> **本项目属个人自用性质**：功能围绕作者自身的 ZCode 使用场景打磨与取舍，
> 不承诺长期维护与全环境兼容。如您有类似需求，欢迎 Fork 或参考。

---

## 为什么选择 zcode-soul

ZCode 桌面版已有官方插件机制，但它面向 AI 能力扩展（技能、斜杠命令、MCP、hooks、子代理），不涉及客户端界面；想在界面层做扩展只能直接修改 `app.asar`，又会在每次升级后被覆盖、需要重新打补丁。

zcode-soul 换了一条实现路径：

> **以 `--remote-debugging-port` 参数启动 ZCode，通过 Chrome DevTools Protocol（CDP）向渲染进程注入插件脚本。安装文件保持原样，升级、重装均不受影响。**

<table>
<tr>

<td width="25%" valign="top">

### 无侵入

不修改 ZCode 任何安装文件，客户端升级后无需任何处理，插件照常工作。

</td>

<td width="25%" valign="top">

### 零依赖

启动器是单个零依赖 Node 脚本，不安装任何 npm 包，拿到代码即可运行。

</td>

<td width="25%" valign="top">

### 热更新

插件脚本改动由看门狗巡检自动感知，约 5 秒内生效，无需重启 ZCode。

</td>

<td width="25%" valign="top">

### 应用内管理

左下角拼图按钮弹出扩展管理面板，开关即时生效；也可在浏览器直接访问管理页。

</td>

</tr>
</table>

---

## 工作原理

```text
zcode-soul.vbs（隐藏控制台，桌面快捷方式入口）
        │
        ▼
    launch.js 启动器（零依赖 Node 脚本）
        │
        ├── 以 --remote-debugging-port=9333 启动 ZCode.exe
        ├── 经 CDP 向所有页面注入运行时与启用插件的脚本
        ├── 启动内置服务 http://127.0.0.1:9340（管理页 / 统计接口 / SSE 推送）
        ├── 加载插件服务端扩展（plugin.json 声明 "server" 的，注册 /api/ 路由）
        └── 看门狗巡检（默认 5 秒一轮）
              ├── 页面刷新、新窗口 → 自动补注入
              ├── 插件开关切换 → 即时注入 / 卸载
              └── 插件源码变化 → 热更新
```

- 插件完全自包含：注入脚本、服务端扩展（自有 `/api/` 接口）、管理页扩展（管理页卡片
  钩子）全部内聚在插件目录，新增或修改插件无需改动 `launch.js` / `manager.html`；
  平台能力（模型设置读取、上游模型调用）由 `lib/` 经插件上下文统一提供。
- 启动器检测到已带调试端口运行的 ZCode 时直接复用，不会重复拉起第二个实例，并尝试把 ZCode 窗口带到前台。
- 每轮巡检先向各页面下发轻量探测（比对 runtime 版本、插件注册表与源码 hash），状态一致则跳过；有差异才生成注入计划：缺失的插件直接注入、源码 hash 变化的插件先卸载旧实例再注入新代码（热更）、禁用或已删除的插件下发 `teardown` 卸载。探测失败时回退全量注入，保证可靠性。
- ZCode 关闭或 CDP 短暂不可达时，启动器只暂停注入并记日志（`launcher.log` 可见最后错误），进程与服务不退出；残留进程由下次启动时的 PID 接管兜底。

---

## 内置插件

| 插件 | 功能 | 灵感来源 |
| --- | --- | --- |
| `usage-popup-plus` 会话用量面板 | 在原生「上下文容量」弹层内（平均缓存命中率行之后）追加会话用量统计区块：本轮合计、生成速度、会话耗时、模型响应耗时、工具调用耗时、模型用量（输入/输出/缓存/命中率）、推理估算、工具调用、子代理（无数据时隐藏）、剩余 tokens；与原生弹层同风格 | pi-desktop |
| `usage-panel-plus` 会话用量指示 | composer 下方双统计 pill（输入框卡片外居中）：仪表 pill（`N 轮 · N tok/s`）点击弹出会话统计（模型用时/工具用时/TPS），Token pill（`N tok · 缓存命中 N%`）点击弹出 Token 用量（缓存命中/未缓存输入/缓存读取/输出）；数据经 `/stats/stream`（SSE）实时推送，请求完成即更新；新会话首页不显示（避免展示上一会话的数据）；点击外部或 Esc 关闭；原生「上下文容量」弹层保持原样 | dsh（deepseek harness） |
| `manager-panel-plus` 应用内扩展管理 | 在左下角「移动端远程控制」图标左侧注入拼图按钮（克隆原生按钮类名，大小/间距一致），点击弹出扩展管理面板（内嵌管理页 embed 模式），无需再开浏览器页面 | — |
| `prompt-enhancement-plus` 提示词增强 | 在输入框发送按钮旁注入「增强提示词」按钮（快捷键 Alt+E），基于内置提示词工程规范改写当前草稿，完成后按钮变为撤销，一键恢复原稿；模型来源支持「模型设置」（复用 ZCode 客户端已配置的服务与模型）与「自定义 API」两种 | workbuddy |

> 两个用量插件（`usage-popup-plus` 与 `usage-panel-plus`）二选一启用。

---

## 快速开始

### 环境要求

- Windows（启动脚本 `zcode-soul.vbs` 与快捷方式工具基于 Windows 环境）
- Node.js 22+（建议 22.5+，历史会话统计的 SQLite 兜底依赖内置 `node:sqlite`，低版本其余功能不受影响）；
  **使用发行包时无需安装 Node**（包内嵌 Node 运行时）
- ZCode 桌面版

### 安装（一键）

**方式一：发行包（推荐，零依赖）**

1. 从 Releases 下载 `zcode-soul-v<版本>-win-x64.zip`，解压到任意固定目录。
2. 双击目录内 `install.bat`：脚本用包内 node.exe 完成定位 ZCode、写入本机配置、创建桌面
   「ZCode (soul)」快捷方式（探测不到 ZCode 时按提示输入路径）。
3. 双击桌面「ZCode (soul)」，像日常一样使用 ZCode，插件自动注入。

**方式二：从源码运行**

1. 将本仓库克隆或下载到本地固定目录（桌面快捷方式会指向其中的启动脚本）。
2. 双击 `install.bat`（或命令行执行 `node tools/install.js`），脚本会依次完成：
   - 检查 Node 版本（需 22+）；
   - 定位 ZCode：优先使用已配置的 `zcodePath`，其次探测常见安装位置
     （`%LOCALAPPDATA%\Programs\ZCode`、`%ProgramFiles%\ZCode`）；都找不到时按提示输入
     `ZCode.exe` 完整路径，写入 `config.local.json`；
   - 创建桌面「ZCode (soul)」快捷方式（自动绕过 PowerShell 执行策略限制）。
3. 双击桌面「ZCode (soul)」，像日常一样使用 ZCode，插件自动注入。

> ZCode 安装在非常见位置时，路径保存在 `config.local.json`（已被 `.gitignore` 忽略）；
> 仓库内的 `config.json` 保持默认值，本机私有配置不会误提交。项目整体移动后重跑
> `install.bat` 重建快捷方式即可。

---

## 使用说明

### 随 ZCode 启动自动注入（推荐）

桌面的「ZCode (soul)」快捷方式即日常 ZCode 入口：双击后由 `zcode-soul.vbs` 隐藏拉起启动器，启动器带 `--remote-debugging-port` 启动 ZCode 并自动注入插件，全程无黑窗口。

- 调试端口只能在 ZCode 进程启动时传入，因此自动注入依赖从该快捷方式启动 ZCode；从原始 `ZCode.exe` 启动的实例无法被注入（启动器会提示）。
- VBS 隐藏了控制台，日志见 `data/launcher.log`（超过 512KB 自动清空重写）；Node 不可用时 VBS 会弹窗提示。
- VBS 不做输出重定向——残留实例的 cmd 会占用重定向文件句柄，导致下次双击静默失败。
- 退出启动器不影响已启动的 ZCode，仅停止自动补注入。

### 手动启动

1. 完全退出 ZCode（托盘图标也要退出）。
2. 双击 `start-zcode-soul.bat`（或命令行 `node launch.js`；也可双击 `zcode-soul.vbs` 隐藏运行）。
3. 管理页自动在默认浏览器打开（`config.json` 的 `openManager` 控制，默认关），也可手动访问 `http://127.0.0.1:9340/`。
4. ZCode 启动后正常使用；已启用插件的注入内容按插件各自位置呈现。

### 应用内管理面板

`manager-panel-plus` 把拼图按钮注入到左下角「移动端远程控制」图标左侧（通过
`aria-label="移动端远程控制"` 锚定；其他语言 UI 按 "remote control" 关键词兜底，
找不到锚点时先在左下角占位、侧栏就绪后自动归位）。点击弹出扩展管理面板：插件开关一目了然，
开关即时生效（约 5 秒内注入/卸载）。面板高度不超过按钮上方可用空间，面板顶部「浏览器打开」
可跳转完整管理页。

### 提示词增强设置

`prompt-enhancement-plus` 的模型来源在扩展管理页 → 提示词增强卡片 →「打开提示词增强设置」中选择：

- **跟随当前模型**：自动读取输入框上方当前显示的模型标签（形如「供应商名/模型名」），在可直连
  复用的服务中匹配对应供应商与模型，改写用模型随会话当前选择自动切换，无需手动配置；读不到
  模型标签或匹配不到服务时给出明确提示。
- **模型设置（有可用服务时的默认）**：下拉列出 ZCode「设置 → 模型」中**可直连复用**的服务与模型
  （有静态 API Key、已启用；账号套餐网关、未配置密钥、未启用的服务不展示）。
  数据源为客户端真实数据目录（由 `~/.zcode/v2/setting.json` 的 `dataBaseDir` 指定，
  默认 `~/.zcode`）下的 `provider_config.json`（自定义供应商及其展示顺序、模型清单）与
  `config.json`（内置套餐服务）；密钥由启动器服务端读取使用，**接口不下发、设置弹窗
  无需填写**。Anthropic 协议（BigModel / Z.ai / 自建 anthropic 兼容网关）自动走
  `/v1/messages`，其余走 OpenAI 兼容 `/chat/completions`。
  - 注意：账号登录的套餐网关（`zcode.z.ai` 的 zcode-plan 端点）凭据由客户端持有并被服务端
    限制为仅 ZCode 客户端调用（直调 401/405），插件无法复用；如需在该渠道使用，请在套餐
    控制台生成 Coding Plan API Key 填入 ZCode「模型设置」的对应服务（BigModel 套餐入口：
    bigmodel.cn → Coding Plan → API Key）。
  - 模型列表每次打开设置时实时读取，ZCode 里新增/切换服务后无需重启。
- **自定义 API**：手动填 OpenAI 兼容 API 地址、API Key 与模型名称
  （`data/prompt-enhancement-config.json`，仅本地存储）。

三种来源的上游请求统一携带与 ZCode 客户端主链路一致的 User-Agent
（`ZCode/<客户端版本> ai-sdk/provider-utils/<版本> runtime/node.js/<Node 主版本>`）；
改写模板可自定义（须含 `{{draft}}` 占位符），留空用内置默认模板。

---

## 项目结构

```
zcode-soul/
├── install.bat                     # 一键安装入口（定位 ZCode、写入本机配置、创建快捷方式）
├── launch.js                       # 零依赖 Node 启动器（CDP 注入 + 内置服务 + 看门狗 + 插件宿主）
├── zcode-soul.vbs                  # 隐藏控制台启动器（桌面快捷方式指向它）
├── start-zcode-soul.bat            # 带控制台的手动启动入口
├── manager.html                    # 扩展管理页（插件列表 + 启用开关 + 管理页扩展点）
├── config.json                     # 全局配置（入库默认值）
├── config.local.json               # 本机私有配置，覆盖 config.json（不入库，自动生成）
├── data/                           # 自动生成：插件开关、launcher.log、launcher.pid、插件数据文件
├── lib/                             # 平台能力模块（启动器加载，经插件上下文暴露给服务端扩展复用）
│   ├── zcode-providers.js          # 读取 ZCode「模型设置」服务清单与密钥（密钥仅服务端使用）
│   └── upstream.js                 # 上游模型调用（anthropic/openai 分发 + 客户端 User-Agent 对齐）
├── plugins/                         # 插件目录，每个子目录一个插件
│   ├── usage-popup-plus/
│   │   ├── plugin.json              # 插件清单 {id,name,version,description,inject}
│   │   └── main.js                  # 插件脚本
│   ├── usage-panel-plus/
│   │   ├── plugin.json
│   │   └── main.js
│   ├── manager-panel-plus/
│   │   ├── plugin.json
│   │   └── main.js
│   └── prompt-enhancement-plus/
│       ├── plugin.json              # 含 server/manager/builtin 扩展声明
│       ├── main.js                  # 注入脚本
│       ├── server.js                # 服务端扩展：配置/改写接口（启动器启动时加载）
│       └── manager.js               # 管理页扩展：配置弹窗（管理页动态加载）
├── test/                            # 端到端/单元验证脚本（独立端口或纯函数断言）
├── reference/                       # 逆向解包的 ZCode 原生静态文件（仅本地参考，不入库）
└── tools/
    ├── asar_tool.py                 # app.asar 静态分析（list/grep/extract）
    ├── check.js                     # 全仓 JS/HTML 语法检查（node tools/check.js）
    ├── cdp-eval.js                  # 向 ZCode 页面执行 JS 并回传结果（排障验证）
    ├── cdp-inject-one.js            # 向指定页面注入单个脚本并检查页面存活（调试）
    ├── cdp-stack.js                 # 抓取目标页面主线程调用栈（诊断挂死/死循环）
    ├── create-shortcut.ps1          # 创建桌面「ZCode (soul)」快捷方式
    ├── install.js                   # 一键安装主逻辑（install.bat 的实现）
    ├── build-release.js             # 构建发行包（复制当前 node.exe + 运行文件 → dist/ zip）
    ├── fix-vbs-encoding.js          # 把 .vbs 转成 UTF-16 LE BOM + CRLF（wscript 编码要求）
    ├── vbs-encoding-selftest.vbs    # VBS 编码/语法自检替身（不启动任何程序）
    └── fake-cdp.js                  # 假 CDP 服务器（验证启动器复用路径，不拉起真实 ZCode）
```

---

## 插件开发

每个插件是 `plugins/` 下的一个子目录，**新增或修改插件只需要改动插件目录内的文件**，
通用文件（`launch.js` / `manager.html`）无需任何改动：

```json
// plugins/<id>/plugin.json
{
    "id": "usage-popup-plus",
    "name": "会话用量面板",
    "version": "0.2.0",
    "description": "一句话说明",
    "inject": ["main.js"],
    "builtin": false,
    "server": "",
    "manager": ""
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` / `name` / `version` / `description` / `inject` | 是 | 基础元数据；`inject` 为要注入 ZCode 页面的脚本列表 |
| `builtin` | 否 | 管理页卡片显示「内置」徽标 |
| `server` | 否 | Node 侧服务端扩展文件名（见下文「服务端扩展」） |
| `manager` | 否 | 管理页扩展脚本文件名（见下文「管理页扩展」） |

### 注入脚本（inject）

插件脚本约定：

```javascript
(function () {
    var ID = "你的插件id";
    var host = window.__zcodeSoul = window.__zcodeSoul || { registry: {} };
    if (host.registry[ID]) return;          // 幂等保护

    // ...初始化、DOM 操作、事件监听...

    host.registry[ID] = {
        version: "0.0.1",
        teardown: function () {             // 禁用时由启动器下发执行
            // 断开监听、移除注入的节点、清理标记
            delete host.registry[ID];
        }
    };
})();
```

### 服务端扩展（server，可选）

插件需要自有 HTTP 接口（读写配置、调用模型等）时，在 `plugin.json` 声明
`"server": "server.js"` 并在插件目录提供该文件，导出一个接收宿主上下文的函数：

```javascript
// plugins/<id>/server.js —— 启动器启动阶段加载，本文件不 require 启动器
module.exports = function (ctx) {
    // ctx.pluginId / ctx.pluginDir / ctx.ports / ctx.config
    // ctx.log(msg)                          带插件 id 前缀的日志
    // ctx.dataFile(name)                    data/ 目录下的插件数据文件路径
    // ctx.readJson(file, fallback) / ctx.writeJson(file, value)
    // ctx.readBody(req) / ctx.sendJson(res, payload, cors)
    // ctx.registerRoute(method, path, handler)
    //     仅允许 /api/ 前缀（自动纳入跨站守卫、令牌校验与 CORS 预检）；
    //     插件间路径冲突时拒绝注册并留日志；分发在内置接口之后，内置不可覆盖
    // ctx.zcodeProviders.list() / readSecret(id) / resolveTarget(cfg) /
    //     resolveTargetByLabel(label) / hasUsable() / planApiKeyUrl(id)
    //     ZCode「模型设置」服务清单与密钥（密钥仅限服务端使用，不回传前端）
    // ctx.callModel({ kind, baseURL, apiKey, model, systemPrompt, userPrompt,
    //                 temperature?, maxTokens?, signal? }, env 由宿主注入)
    //     统一上游模型调用：anthropic / openai 协议分发，自动对齐客户端 User-Agent

    ctx.registerRoute("GET", "/api/<id>/hello", (req, res) => {
        ctx.sendJson(res, { ok: true, data: ctx.readJson(ctx.dataFile("<id>-cfg.json"), {}) });
    });
};
```

注意：路由表随启动器启动加载，**新增带 `server` 的插件或修改 `server.js` 需重启启动器**
（注入脚本与管理页扩展不受影响，仍热更新）；运行中检测到新扩展时启动日志会提示。

### 管理页扩展（manager，可选）

插件需要在扩展管理页展示自定义 UI（配置按钮、设置弹窗等）时，在 `plugin.json` 声明
`"manager": "manager.js"`。管理页按 `/api/plugins` 返回的 `hasManager` 以同源 script
动态加载该文件，脚本向 `window.__zcodeSoulManager` 注册卡片钩子：

```javascript
// plugins/<id>/manager.js —— 运行于管理页（含应用内面板 iframe），同源可直调 /api/*
(function () {
    var Mgr = window.__zcodeSoulManager;
    // actions: 卡片操作区按钮（在「全局」标签与开关之间）；detail: 详情区附加内容
    Mgr.register("<id>", {
        actions: function (plugin) {
            return [{ title: "配置", icon: "<svg>...</svg>", onClick: openMyModal }];
        },
        detail: function (container, plugin) { /* 向 container 追加 DOM */ }
    });

    function openMyModal() { /* 自建弹窗 DOM；样式可复用管理页 .modal-* .form-* 通用类 */ }
})();
```

注册后管理页自动重渲染；弹窗主题深浅色跟随管理页（CSS 变量 `--fg` / `--card` 等直接可用）。

### 开发约定与能力

- 新增插件后在管理页打开开关即可，无需重启；修改插件脚本同样无需任何操作，下一轮巡检
  （约 5 秒内）自动热更生效。
- 插件脚本可使用运行时共享工具 `window.__zcodeSoul.shared`：`currentSessionId()`（当前
  激活会话 ID）、`isForCurrentSession(data)`（数据帧归属校验）、`fmtTokens(v)` / `fmtExact(v)`
  （token 数格式化）。共享层随运行时先于所有插件脚本注入。
- 需要宿主数据的插件可请求 `http://127.0.0.1:9340/stats`（会话统计），或订阅
  `http://127.0.0.1:9340/stats/stream`（SSE 推送：连接即收到快照，会话记录变化时下发；
  心跳 25s）。
- 调用 `/api/*` 管理接口时，请求头必须携带 `x-zcode-soul-token`（注入运行时自动声明，
  每次启动器启动随机生成）。
- 需要自有接口或宿主平台能力（模型设置、上游模型调用）时走「服务端扩展」，
  在插件目录内完成，不改动 `launch.js`。

---

## 配置（config.json）

`config.json` 为入库默认值；同目录的 `config.local.json`（已被 `.gitignore` 忽略，不存在则不覆盖）
按字段覆盖 `config.json`，用于存放本机私有配置（如 ZCode 安装在非默认位置时的 `zcodePath`），
`install.bat` 检测到需要时会自动创建。

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `zcodePath` | ZCode.exe 完整路径，留空则按常见安装位置自动探测（探测不到时启动器报错并列出已尝试路径） | `""` |
| `debugPort` | CDP 调试端口；被其他程序占用时自动顺延（向后最多 7 个端口） | `9333` |
| `statsPort` | 内置服务端口（管理页 + 统计）；被占用时同样自动顺延，实际端口随运行时下发给插件并写入启动日志 | `9340` |
| `pollIntervalMs` | 看门狗巡检间隔 | `5000` |
| `openManager` | 启动时自动在浏览器打开管理页（默认关：应用内面板已够用） | `false` |

---

## 统计口径与已知限制

- 上下文窗口分母优先实时跟随客户端：启动器经 CDP 在 ZCode 页面内扫描 React
  fiber，读取「上下文容量」面板同源的 `contextWindow.maxTokens`（切模型后约 1
  分钟内跟上），**按会话 ID 归档**——只有页面显示该会话时读到的窗口才会用作
  它的分母，多会话窗口不同也不串用，响应标记 `windowSource: "live"`；读取失败
  或该会话的条目超过 60s 未刷新（页面一直停在别的会话）时回退默认 30 万
  （`"default"`），显式 `?window=`（≥1000）强制覆盖（`"override"`）。客户端改版
  导致 fiber 结构变化时同样回退默认值，不影响其余指标。
- **统计按会话隔离**：插件从激活会话容器的 `data-session-id` 读取当前会话 ID，请求 `/stats`
  与 `/stats/stream` 时携带 `?session=` 参数；服务端按会话 ID 精准定位记录文件，指定会话
  无记录时返回空快照而**不回退到 mtime 最新的文件**（按 mtime 取最新正是并发会话数据串台
  的根因）；SSE 为每个连接按其会话分流推送。前端对每帧数据校验归属（优先 `sessionId` 字段），
  会话切换（含原地改属性，不重建节点）时清空旧数据并重建数据通道。
- 统计服务对会话记录做增量解析（同一文件只读新增字节、只解析新行），启动器监听会话目录，
  变化经 `/stats/stream` 推送给 pill：一次请求完成后约 0.2s 内更新，空闲时不产生请求与解析。
- **历史会话 SQLite 兜底**：ZCode 官方仅保留最近几个 `model-io-*.jsonl` 记录文件（超出即按
  mtime 轮转删除），打开较早的历史会话时统计服务会只读查询客户端本地数据库
  `~/.zcode/cli/db/db.sqlite` 的 `turn_usage` 表（需 Node 22.5+ 内置 `node:sqlite`，
  缺失时维持空快照），汇总该会话真实的轮次、输入/输出/缓存/推理 token 与缓存命中率，
  返回 `source: "sqlite"` 标记；速度与工具种类等明细指标无法从库中还原，置空不显示。
  完全不存在的会话仍返回空快照，绝不回退到其他会话数据。
- **续接会话历史回填**：重启后续接同一会话时客户端会按原会话 ID 重建记录文件，文件里只剩
  续接后的请求，重启前的历史仍在数据库里。统计服务走文件路径时会从 `model_usage` 表
  （逐模型请求行，与文件记录同口径）回填文件首条之前的行并合并进聚合值（轮数、tokens、
  缓存、工具调用次数、会话时长、缓存命中率），返回 `source: "file+sqlite"` 与 `backfill`
  元数据；边界以「文件首条开始时间前推 2 秒」分界，同一条请求不会既进文件又被回填双计。
  文件已建但还没记录落盘的续接瞬间回填全部历史，`context.used` 用库里最新一行的输入
  token 修正，避免面板短暂显示「剩余满额、已用 0%」。
- 「推理（估算）」按 `reasoningText` 字符数 ÷ 3.5 估算；客户端未下发精确推理 token 数。
- 子代理按「文件名含会话 ID，或记录时间落在主会话范围内」归属；并行开多个会话时可能互相计入。

---

## 本地测试

不启动 ZCode 只跑内置服务：

```
set ZCODE_SOUL_NO_APP=1
node launch.js
```

- 管理页：`http://127.0.0.1:9340/`
- 插件加载器测试：`http://127.0.0.1:9340/fixture`（`/load/all.js` 加载全部启用插件，`/load/<id>.js` 单独加载）
- 接口：`GET /api/plugins`、`POST /api/plugins/{id}/toggle`（`{"enabled":false}`）、
  `GET /stats`（当前快照，支持 `?session=` 指定会话）、`GET /stats/stream`（SSE 推送，按连接的
  `?session=` 分流）

自动化验证脚本：

```
node test/verify-session-isolation.js     # 会话隔离回归（独立 9341 端口实例，不影响真实启动器）
node test/verify-history-backfill.js      # 续接会话历史回填断言（假 USERPROFILE 手造库与文件）
node test/verify-inject-plan.js           # 注入计划（探测热更）纯函数断言，不启动服务、不依赖 CDP
node test/verify-prompt-enhance-models.js # 提示词增强模型来源验证（独立 9342 端口实例）
node test/serve-fixture-instance.js       # 常驻 9341 实例，浏览器打开 /fixture 验证插件前端
```

全仓语法检查（遍历 .js 与 .html 内嵌脚本，零依赖）：

```
node tools/check.js
```

构建 Windows 发行包（内嵌当前 Node 运行时，产物在 `dist/`，已 gitignore）：

```
node tools/build-release.js
```

---

## 常见问题（FAQ）

**从原始 `ZCode.exe` 启动后插件没有注入？**
调试端口只能在进程启动时传入，请改用桌面「ZCode (soul)」快捷方式启动；启动器检测到未带端口的实例时会提示。

**修改 `zcode-soul.vbs` 后启动报 800A0401「语句未结束」？**
wscript 按 ANSI(GBK) 读取无 BOM 的 UTF-8 脚本，中文注释会把解析器搞乱。`zcode-soul.vbs`
必须保持 UTF-16 LE（带 BOM）+ CRLF 编码，用编辑器改动后执行
`node tools/fix-vbs-encoding.js zcode-soul.vbs` 重新转码；`tools/vbs-encoding-selftest.vbs`
是逐行同构的自检替身，用 cscript 跑它可验证编码。

**双击快捷方式没有反应？**
查看 `data/launcher.log` 的最后错误；Node 不可用时 VBS 会弹窗提示。

**ZCode 升级后用量面板不见了？**
升级可能改动面板 DOM 导致锚定失效。用 `tools/asar_tool.py` 重新定位 `chat.contextUsage.*`
与「平均缓存命中率」文案所在 chunk，核对文案与结构后调整插件脚本。

---

## 安全说明

CDP 调试端口仅绑定 `127.0.0.1`，但本机任意进程都能通过它控制渲染进程，请勿在不可信环境长期开启。

内置服务（`127.0.0.1:9340`）的防护措施：

- 请求头 Host 校验：非本机回环地址的请求直接拒绝（防 DNS rebinding）。
- `/api/*` 管理接口仅接受同源调用：浏览器跨站请求（带 Origin 头）必须携带注入时下发的
  随机令牌 `x-zcode-soul-token`；命令行脚本（无 Origin 头）不受影响。
- CORS 仅对 `/stats`、`/stats/stream` 等插件数据接口开放；管理接口响应不携带跨域头，
  任意网页无法跨域读取。
- `GET /api/prompt-enhancement/config` 不回传明文 API Key：已保存时返回占位符 `__stored__`，
  保存时原样提交占位符表示「未修改」，清空提交表示「删除」。
- **日志脱敏**：上游接口的错误响应可能回显凭据片段，`launcher.log` 与控制台输出在落盘前
  统一掩码 `Bearer` 令牌、`sk-` 密钥与 JWT，密钥不进日志。

---

## 许可证

本项目基于 [MIT](LICENSE) 协议开源，可自由用于个人自用与二次开发。

---

<div align="center">

**zcode-soul** · 给 ZCode 注入灵魂

不修改安装文件 · 零依赖 · 热更新 · 开箱即用

</div>
