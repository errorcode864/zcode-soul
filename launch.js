// zcode-soul 启动器：CDP 注入 + 插件管理 + 本地统计服务。
//
// 职责（参考 zcodeplusplus 的 launch.js）：
// 1. 以 --remote-debugging-port 启动 ZCode 桌面版
// 2. 在 127.0.0.1:statsPort 起内置服务：插件管理页 / 管理接口 / 会话统计
// 3. 扫描 plugins/ 目录，按各插件开关状态注入或卸载，每 pollIntervalMs 毫秒巡检
//
// 插件规范：plugins/<id>/plugin.json 声明 {id,name,version,description,inject:[]}，
// 可选字段：builtin（管理页「内置」徽标）、server（Node 侧服务扩展，启动时加载）、
// manager（管理页扩展脚本，由管理页动态加载注册卡片钩子）。
// 插件脚本注册 window.__zcodeSoul.registry[<id>] = { teardown }，禁用时启动器下发 teardown 卸载。
//
// 零依赖，需要 Node 22+（使用内置 fetch / WebSocket）。

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

// 平台能力：插件服务端扩展经上下文复用，启动器本体不直接调用
const zcodeProviders = require("./lib/zcode-providers");
const upstream = require("./lib/upstream");

const ROOT = __dirname;

// 应用版本单一来源：发行包构建（tools/build-release.js）从这里解析，启动日志也打印
const APP_VERSION = "0.1.0";

// 配置读取：config.json 为入库默认值，config.local.json（已 gitignore）覆盖本机私有值
function loadConfig() {
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf-8"));
    const localFile = path.join(ROOT, "config.local.json");
    if (!fs.existsSync(localFile)) return base;
    const local = JSON.parse(fs.readFileSync(localFile, "utf-8"));
    return Object.assign({}, base, local);
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// 端口分配：bind 预检 + 顺延。debugPort/statsPort 被其他程序占用时依次向后找空闲口，
// 两类端口共享同一顺延上限但默认值间隔 7，正常情况下不会互相侵占
// ---------------------------------------------------------------------------

const PORT_FALLBACK_RANGE = 7;
// 实际生效端口（main 启动时分配；cdpBase / 运行时下发 / 管理页地址统一引用这里）
const ports = { debug: config.debugPort, stats: config.statsPort };

// bind 预检比 connect 探测可靠：能 bind 说明端口空闲，不会误判「监听但拒绝连接」的进程
function portInUse(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once("error", () => resolve(true));
        srv.once("listening", () => srv.close(() => resolve(false)));
        srv.listen(port, "127.0.0.1");
    });
}

// 从 preferred 开始在顺延区间内找第一个空闲端口；区间名仅用于日志
async function allocatePort(preferred, name) {
    for (let p = preferred; p < preferred + PORT_FALLBACK_RANGE; p++) {
        if (!(await portInUse(p))) {
            if (p !== preferred) log(name + " " + preferred + " 被占用，顺延使用 " + p);
            return p;
        }
    }
    throw new Error(name + " " + preferred + "-" + (preferred + PORT_FALLBACK_RANGE - 1) + " 全部被占用，无法启动");
}

// 扫描顺延区间内已带调试端口运行的 ZCode（页面标题/URL 含 zcode 才认定，
// 防止误连本机其他应用的 CDP 端口），返回端口号；未找到返回 0
async function findRunningZcodeCdp() {
    for (let p = config.debugPort; p < config.debugPort + PORT_FALLBACK_RANGE; p++) {
        try {
            const res = await fetch("http://127.0.0.1:" + p + "/json/version", { signal: AbortSignal.timeout(1500) });
            if (!res.ok) continue;
            const list = await (await fetch("http://127.0.0.1:" + p + "/json/list", { signal: AbortSignal.timeout(1500) })).json();
            const isZcode = (Array.isArray(list) ? list : []).some((t) => {
                const title = String(t && t.title || "").toLowerCase();
                const url = String(t && t.url || "").toLowerCase();
                return title.includes("zcode") || url.includes("zcode");
            });
            if (isZcode) return p;
        } catch {
            // 该端口无 CDP 服务，继续
        }
    }
    return 0;
}
const STATE_FILE = path.join(ROOT, "data", "plugins-state.json");

// ---------------------------------------------------------------------------
// ZCode 路径解析：zcodePath 留空时按常见安装位置自动探测
// ---------------------------------------------------------------------------

function zcodePathCandidates() {
    const candidates = [];
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "ZCode", "ZCode.exe"));
    if (process.env.PROGRAMFILES) candidates.push(path.join(process.env.PROGRAMFILES, "ZCode", "ZCode.exe"));
    return candidates;
}

// zcodePath 显式配置时直接使用（存在性由启动处校验）；留空则探测常见安装位置
function resolveZcodePath(configured) {
    const value = String(configured || "").trim();
    if (value) return value;
    return zcodePathCandidates().find((candidate) => fs.existsSync(candidate)) || "";
}

// ---------------------------------------------------------------------------
// 插件发现与开关状态
// ---------------------------------------------------------------------------

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    } catch {
        return {};
    }
}

function saveState(state) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 4) + "\n", "utf-8");
}

function isEnabled(state, id) {
    // 未记录过的插件默认启用
    return state[id] !== false;
}

function scanPlugins() {
    const plugins = [];
    let entries = [];
    try {
        entries = fs.readdirSync(path.join(ROOT, "plugins"), { withFileTypes: true });
    } catch {
        return plugins;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(ROOT, "plugins", entry.name);
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf-8"));
        } catch (err) {
            log("跳过无效插件 " + entry.name + ": " + err.message);
            continue;
        }
        if (!manifest.id || !Array.isArray(manifest.inject)) {
            log("跳过插件 " + entry.name + ": plugin.json 缺少 id 或 inject");
            continue;
        }
        // 可选扩展入口：server 为 Node 侧服务扩展（启动时加载），
        // manager 为管理页扩展脚本（管理页按存在性动态加载）；builtin 控制管理页「内置」徽标
        const serverFile = typeof manifest.server === "string" ? manifest.server : "";
        const managerFile = typeof manifest.manager === "string" ? manifest.manager : "";
        plugins.push({
            id: manifest.id,
            name: manifest.name || manifest.id,
            version: manifest.version || "0.0.0",
            description: manifest.description || "",
            dir,
            inject: manifest.inject,
            builtin: manifest.builtin === true,
            server: serverFile,
            manager: managerFile,
            hasServer: Boolean(serverFile) && fs.existsSync(path.join(dir, serverFile)),
            hasManager: Boolean(managerFile) && fs.existsSync(path.join(dir, managerFile)),
        });
    }
    return plugins;
}

function readPluginSources(plugin) {
    return plugin.inject
        .map((name) => {
            try {
                return fs.readFileSync(path.join(plugin.dir, name), "utf-8");
            } catch (err) {
                log("读取插件脚本失败 " + plugin.id + "/" + name + ": " + err.message);
                return null;
            }
        })
        .filter(Boolean);
}

// 每次启动随机生成的插件接口令牌：随脚本注入到 ZCode 页面上下文（见 buildPluginInject），
// 本机其他网页拿不到，用于 /api/* 的跨站调用校验
const PLUGIN_TOKEN = crypto.randomBytes(16).toString("hex");

// 组装某插件的注入代码：前缀声明端口与令牌，并登记源码 hash 供看门狗探测比对。
// hash 覆盖端口、令牌与源码三者：任一变化都会让页面已登记的 hash 失配并触发重注入
// ——启动器重启后令牌轮换，正是靠这一机制把新令牌刷进已打开的页面
function buildPluginInject(plugin) {
    const source = readPluginSources(plugin).join("\n");
    // 注入前语法校验：文件正被保存到一半时是半截脚本，打进页面必报语法错并中断旧实例。
    // 校验失败返回 null，本轮跳过注入（保留页面旧实例），文件写完后的巡检轮按 hash 失配自动补注入
    try {
        new Function(source);
    } catch (err) {
        log("插件脚本语法校验失败，跳过注入 " + plugin.id + ": " + err.message);
        return null;
    }
    const prefix =
        "window.__ZCODE_SOUL_STATS_PORT__=" + ports.stats + ";" +
        "window.__ZCODE_SOUL_TOKEN__=" + JSON.stringify(PLUGIN_TOKEN) + ";" +
        "window.__zcodeSoul=window.__zcodeSoul||{registry:{}};" +
        "window.__zcodeSoul.hashes=window.__zcodeSoul.hashes||{};";
    const hash = crypto.createHash("sha1").update(prefix + "\n" + source).digest("hex").slice(0, 10);
    const code = prefix +
        "window.__zcodeSoul.hashes[" + JSON.stringify(plugin.id) + "]=" + JSON.stringify(hash) + ";\n" +
        source;
    return { code, hash };
}

// 运行时框架：插件注册表 + 跨插件共享工具。
// registry 幂等保留（重复注入不覆盖已注册插件）；shared 每次整体覆盖——全部为无状态
// 纯函数，热更即时生效。修改本段代码时须同步递增 RUNTIME_VERSION，让已注入页面重注入
const RUNTIME_VERSION = "0.4.0";
const RUNTIME_SNIPPET = `(function(){
var w=window;
w.__zcodeSoul=w.__zcodeSoul||{version:"${RUNTIME_VERSION}",registry:{}};
var shared={
currentSessionId:function(){
var el=document.querySelector("[data-session-id]");
var sid=el?el.getAttribute("data-session-id"):null;
if(sid)return sid;
// DOM 无值时兜底：客户端把每个工作区当前会话记在 localStorage 键
// zcode-v4-last-session:v1:<工作区路径>。localStorage 全窗口共享，各键值不一致时
// 无法判定本窗口归属，保守返回 null——宁可不显示也不串台
try{
var picked=null;
for(var i=0;i<localStorage.length;i++){
var k=localStorage.key(i);
if(/^zcode-v4-last-session:/.test(k)){
var v=localStorage.getItem(k);
if(v&&/^[A-Za-z0-9_-]+$/.test(v)){
if(picked===null)picked=v;else if(picked!==v)return null;
}
}
}
return picked;
}catch(e){return null;}
},
isForCurrentSession:function(data){
if(!data)return false;
var sid=shared.currentSessionId();
if(!sid)return true;
if(data.sessionId)return data.sessionId===sid;
if(data.sessionFile)return String(data.sessionFile).indexOf(sid)!==-1;
return true;
},
fmtTokens:function(value){
value=value||0;
var scaled=function(c){return c>=100?String(Math.round(c)):String(Math.round(c*10)/10);};
if(value<1e3)return String(value);
if(value<1e6)return scaled(value/1e3)+"K";
return scaled(value/1e6)+"M";
},
fmtExact:function(value){return (value||0).toLocaleString("en-US");}
};
w.__zcodeSoul.shared=shared;
})();`;

// 禁用插件时下发的卸载代码：执行 teardown 并清掉登记的 hash，让页面状态回到干净
function buildUnloader(id) {
    return (
        "if(window.__zcodeSoul){var p=window.__zcodeSoul.registry[" + JSON.stringify(id) + "];" +
        "if(p&&p.teardown){try{p.teardown();}catch(e){}}" +
        "if(window.__zcodeSoul.hashes)delete window.__zcodeSoul.hashes[" + JSON.stringify(id) + "];}"
    );
}

// ---------------------------------------------------------------------------
// 插件服务端扩展：plugin.json 声明 "server": "server.js" 时，启动器在启动阶段
// require 该模块（module.exports = function (ctx) {...}），插件通过 ctx 注册 /api/
// 路由并复用平台能力（模型设置读取、上游模型调用、数据文件读写）。
// 路由表随启动器常驻，新增带 server 的插件或修改 server 代码需重启启动器生效；
// 注入脚本与管理页扩展不受此限，仍走看门狗热更新
// ---------------------------------------------------------------------------

const pluginRoutes = new Map(); // "METHOD /api/路径" -> { pluginId, handler }
const loadedServerIds = new Set();
let pendingServerNoticeLogged = false;

// 插件服务上下文：把宿主能力收敛为最小注入面，插件代码不 require 启动器
function createPluginContext(plugin) {
    return {
        pluginId: plugin.id,
        pluginDir: plugin.dir,
        ports,
        config,
        log: (message) => log("[" + plugin.id + "] " + message),
        // 插件数据文件统一放 data/（已 gitignore），文件名建议带插件 id 前缀防撞名
        dataFile: (name) => path.join(ROOT, "data", name),
        readJson: (file, fallback) => {
            try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
        },
        writeJson: (file, value) => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(value, null, 4) + "\n", "utf-8");
        },
        readBody,
        sendJson,
        // 插件路由仅允许挂在 /api/ 下：与内置跨站守卫、令牌校验、CORS 预检共用一套防护；
        // 与其它插件路由冲突时拒绝注册并告警（内置路由不经此表，插件无法覆盖）
        registerRoute: (method, pathname, handler) => {
            const verb = String(method || "GET").toUpperCase();
            if (!/^\/api\//.test(pathname)) {
                log("插件 " + plugin.id + " 路由注册被拒绝（仅允许 /api/ 前缀）: " + verb + " " + pathname);
                return;
            }
            const key = verb + " " + pathname;
            if (pluginRoutes.has(key)) {
                log("插件 " + plugin.id + " 路由注册被拒绝（路径已被占用）: " + key);
                return;
            }
            pluginRoutes.set(key, { pluginId: plugin.id, handler });
        },
        // 平台能力：读取 ZCode「模型设置」服务清单 / 密钥（密钥仅限服务端使用，不回传前端）
        zcodeProviders: {
            list: zcodeProviders.loadZcodeProviders,
            readSecret: zcodeProviders.readZcodeProviderSecret,
            resolveTarget: zcodeProviders.resolveZcodeTarget,
            resolveTargetByLabel: zcodeProviders.resolveZcodeTargetByLabel,
            hasUsable: zcodeProviders.hasUsableZcodeProvider,
            planApiKeyUrl: zcodeProviders.planApiKeyUrl,
        },
        // 平台能力：上游模型调用（按服务协议分发并自动对齐客户端主链路 User-Agent）
        callModel: (opts) => upstream.callModel(opts, {
            cdpBase: cdpBase(),
            zcodeExe: resolveZcodePath(config.zcodePath),
        }),
    };
}

function loadPluginServers(plugins) {
    for (const plugin of plugins) {
        if (!plugin.hasServer || loadedServerIds.has(plugin.id)) continue;
        loadedServerIds.add(plugin.id);
        try {
            const factory = require(path.join(plugin.dir, plugin.server));
            if (typeof factory === "function") {
                factory(createPluginContext(plugin));
            } else {
                log("插件服务扩展格式无效（须导出 function (ctx)）: " + plugin.id);
            }
        } catch (err) {
            log("加载插件服务扩展失败 " + plugin.id + ": " + err.message);
        }
    }
    if (loadedServerIds.size) {
        log("插件服务扩展已加载: " + [...loadedServerIds].join(", "));
    }
}

// ---------------------------------------------------------------------------
// 本地统计服务：解析最近的 model-io 会话记录，输出与客户端面板同口径的扩展指标
// ---------------------------------------------------------------------------

const ROLLOUT_DIR = path.join(
    process.env.USERPROFILE || process.env.HOME || "", ".zcode", "cli", "rollout"
);
// 窗口分母回退值：CDP 实时读取失败时兜底（与多数模型的客户端面板默认一致）
const DEFAULT_WINDOW = 300000;
// 文本 token 估算系数：中英混排约 3.5 字符/token
const CHARS_PER_TOKEN = 3.5;

// 页面内执行的窗口探测脚本：从任意 DOM 元素取得 React fiber，上行到根后浅扫
// props 与 hooks，命中客户端推送给「上下文容量」面板的 contextWindow（面板同源
// 数据，含真实 maxTokens）即返回其 JSON，并附带页面当前激活会话 ID（与注入
// runtime 的 currentSessionId 同逻辑：data-session-id 优先，localStorage 各键
// 一致时兜底、不一致时为 null）——多会话窗口不同时据此归档，避免分母串台；
// 带扫描预算防大组件树卡住页面主线程，找不到返回 "null"
const LIVE_WINDOW_SNIPPET = `(function(){
var out=null;
try{
var el=null,all=document.querySelectorAll("*");
for(var i=0;i<all.length;i++){
var ks=Object.keys(all[i]);
for(var j=0;j<ks.length;j++){if(ks[j].indexOf("__reactFiber$")===0){el=all[i];break;}}
if(el)break;
}
if(el){
var fk=Object.keys(el).filter(function(k){return k.indexOf("__reactFiber$")===0;})[0];
var root=el[fk];
while(root&&root.return)root=root.return;
var seen=new Set(),n=0;
function dig(v,d){
if(out||!v||typeof v!=="object"||d<0||n>12000)return;
if(seen.has(v))return;
seen.add(v);n++;
if(Object.prototype.toString.call(v)==="[object Array]"){
for(var i=0;i<Math.min(v.length,20);i++)dig(v[i],d-1);
return;
}
var keys=Object.keys(v);
for(var a=0;a<keys.length;a++){
var k=keys[a];
if(k==="contextWindow"&&v[k]&&typeof v[k].maxTokens==="number"){out=v[k];return;}
dig(v[k],d-1);
if(out)return;
}
}
var q=[root],fseen=new Set();
while(q.length&&!out&&fseen.size<20000){
var f=q.pop();
if(!f||typeof f!=="object"||fseen.has(f))continue;
fseen.add(f);
dig(f.memoizedProps,2);
var h=f.memoizedState,hn=0;
while(h&&typeof h==="object"&&"memoizedState" in h&&hn<40&&!out){
dig(h.memoizedState,2);h=h.next;hn++;
}
if(f.child)q.push(f.child);
if(f.sibling)q.push(f.sibling);
}
}
}catch(e){}
if(!out)return "null";
var sid=document.querySelector("[data-session-id]");
if(!sid){
try{
var picked=null;
for(var i=0;i<localStorage.length;i++){
var k=localStorage.key(i);
if(/^zcode-v4-last-session:/.test(k)){
var v=localStorage.getItem(k);
if(v&&/^[A-Za-z0-9_-]+$/.test(v)){
if(picked===null)picked=v;else if(picked!==v){picked=null;break;}
}
}
}
if(picked)sid={getAttribute:function(){return picked;}};
}catch(e){}
}
return JSON.stringify({maxTokens:out.maxTokens,usedTokens:out.usedTokens||0,sessionId:sid?sid.getAttribute("data-session-id"):null});
})()`;

// 实时窗口缓存：按会话 ID 归档 CDP 读到的面板真实分母（多会话窗口不同时不串台），
// lastRead 记录最后一次成功读取供无 session 参数的请求兜底；条目超过 TTL 不再
// 消费（回退默认值），页面切回该会话后自动刷新恢复
const LIVE_WINDOW_TTL_MS = 60000;
const liveWindowCache = new Map(); // sessionId -> { value, readAt }
const liveWindowLastRead = { value: null, sessionId: null, readAt: 0 };
let liveWindowReading = false;
let liveWindowReadAt = 0; // 最近一次读取尝试时刻（含失败），控制读取频率

// 遍历 CDP 页面 target 执行探测脚本，取第一个合法的 { 窗口值, 页面激活会话 ID }；
// CDP 不可达或页面结构变化（React fiber 键改名等）时返回 null
async function readLiveWindowFromPages() {
    let targets;
    try {
        const res = await fetch(cdpBase() + "/json/list", { signal: AbortSignal.timeout(5000) });
        targets = await res.json();
    } catch {
        return null;
    }
    for (const target of targets) {
        if (target.type !== "page" || (target.url || "").startsWith("devtools://")) continue;
        const results = await evaluateBatchOnTarget(target, [{ label: "liveWindow", code: LIVE_WINDOW_SNIPPET }]);
        const item = results[0];
        if (!item.ok || typeof item.value !== "string") continue;
        try {
            const parsed = JSON.parse(item.value);
            if (parsed && Number.isFinite(parsed.maxTokens) && parsed.maxTokens >= 1000) {
                return { value: Math.round(parsed.maxTokens), sessionId: parsed.sessionId || null };
            }
        } catch {
            // 值不合法，继续尝试下一个页面
        }
    }
    return null;
}

// 后台刷新实时窗口（fire-and-forget）：距上次读取尝试超过 TTL 才发起，统计请求
// 路径不等待读取完成，当帧先用缓存值。首次读到与窗口变化（切模型/切换会话）时打日志
function refreshLiveWindow() {
    if (liveWindowReading) return;
    if (Date.now() - liveWindowReadAt < LIVE_WINDOW_TTL_MS) return;
    liveWindowReading = true;
    liveWindowReadAt = Date.now();
    readLiveWindowFromPages()
        .then((result) => {
            if (!result) return;
            const sid = result.sessionId;
            const entry = liveWindowCache.get(sid);
            if (!entry || entry.value !== result.value) {
                log("已读取客户端实时上下文窗口: " + result.value + "（会话 " + (sid || "未知") + (entry ? "，原 " + entry.value : "") + "）");
                liveWindowCache.set(sid, { value: result.value, readAt: Date.now() });
            } else {
                entry.readAt = Date.now();
            }
            liveWindowLastRead.value = result.value;
            liveWindowLastRead.sessionId = sid;
            liveWindowLastRead.readAt = Date.now();
        })
        .catch(() => {})
        .finally(() => { liveWindowReading = false; });
}

function parseTs(value) {
    if (!value) return null;
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? null : ts;
}

// 增量解析缓存：同一文件只读新增字节并只解析新行，避免每次全量读 + JSON.parse
const recordCache = new Map(); // filePath -> { offset: 已消费字节数, records: 已解析记录 }
const RECORD_CACHE_MAX = 64;

function appendRecordLines(entry, text) {
    for (const line of text.split("\n")) {
        const raw = line.trim();
        if (!raw) continue;
        try {
            entry.records.push(JSON.parse(raw));
        } catch {
            // 容忍正在写入的不完整行
        }
    }
}

function forgetStaleRecords() {
    if (recordCache.size <= RECORD_CACHE_MAX) return;
    for (const filePath of [...recordCache.keys()]) {
        if (!fs.existsSync(filePath)) recordCache.delete(filePath);
    }
    if (recordCache.size > RECORD_CACHE_MAX) recordCache.clear();
}

function readRecords(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        recordCache.delete(filePath);
        return [];
    }
    let entry = recordCache.get(filePath);
    // 首次读取，或文件被截断重写（大小回退）时从零开始
    if (!entry || stat.size < entry.offset) {
        entry = { offset: 0, records: [] };
        recordCache.set(filePath, entry);
    }
    if (stat.size === entry.offset) return entry.records;

    let chunk;
    try {
        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.allocUnsafe(stat.size - entry.offset);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, entry.offset);
        fs.closeSync(fd);
        chunk = buf.subarray(0, bytesRead);
    } catch {
        return entry.records;
    }

    // 只消费到最后一个换行符为止，正在写入的尾行留给下次读取
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline >= 0) {
        appendRecordLines(entry, chunk.subarray(0, lastNewline + 1).toString("utf-8"));
        entry.offset += lastNewline + 1;
        chunk = chunk.subarray(lastNewline + 1);
    }
    // 无换行结尾但已写完的完整记录也计入；解析失败说明仍在写入，offset 不推进
    const tail = chunk.toString("utf-8").trim();
    if (tail) {
        try {
            entry.records.push(JSON.parse(tail));
            entry.offset += chunk.length;
        } catch {
            // 等待下次读取
        }
    }
    forgetStaleRecords();
    return entry.records;
}

function fmtTokens(value) {
    if (value == null) return "-";
    if (value >= 1000000) return (value / 1000000).toFixed(1) + "M";
    if (value >= 1000) return (value / 1000).toFixed(1) + "K";
    return String(Math.round(value));
}

function fmtDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    if (total >= 3600) {
        return Math.floor(total / 3600) + "h " + Math.floor((total % 3600) / 60) + "m";
    }
    if (total >= 60) return Math.floor(total / 60) + "m " + (total % 60) + "s";
    return total + "s";
}

function estimateTokens(text) {
    return text ? Math.floor(text.length / CHARS_PER_TOKEN) : 0;
}

function collectStats(records, window) {
    const stats = {
        requests: records.length,
        modelId: null,
        window,
        contextUsed: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheHitRate: 0,
        reasoningTokensEst: 0,
        sessionSeconds: 0,
        modelSeconds: 0,
        toolSeconds: 0,
        lastSpeedTps: 0,
        avgSpeedTps: 0,
        toolKinds: 0,
        toolCalls: 0,
    };
    if (!records.length) return stats;

    let prev = null;
    for (const rec of records) {
        const resp = rec.response || {};
        const usage = resp.usage || {};
        const inp = usage.inputTokens || 0;
        const out = usage.outputTokens || 0;
        const cached = usage.cacheReadTokens || 0;
        stats.totalTokens += usage.totalTokens || 0;
        stats.inputTokens += inp;
        stats.outputTokens += out;
        stats.cacheReadTokens += cached;
        stats.reasoningTokensEst += estimateTokens(resp.reasoningText);

        const durMs = rec.durationMs || 0;
        stats.modelSeconds += durMs / 1000;
        if (durMs > 0 && out > 0) {
            stats.lastSpeedTps = out / (durMs / 1000);
        }

        const toolCounter = stats._toolCounter || (stats._toolCounter = new Map());
        for (const tc of resp.toolCalls || []) {
            const name = tc.name || "unknown";
            stats.toolCalls += 1;
            toolCounter.set(name, (toolCounter.get(name) || 0) + 1);
        }

        // 上一条带工具调用时，两条请求之间的间隔近似为工具执行耗时
        if (prev && prev.response && prev.response.toolCalls && prev.response.toolCalls.length) {
            const prevEnd = parseTs(prev.completedAt);
            const curStart = parseTs(rec.startedAt);
            if (prevEnd && curStart) stats.toolSeconds += Math.max(0, (curStart - prevEnd) / 1000);
        }

        stats.modelId = (rec.model && rec.model.modelId) || stats.modelId;
        prev = rec;
    }

    const first = parseTs(records[0].startedAt);
    const last = parseTs(records[records.length - 1].completedAt);
    if (first && last) stats.sessionSeconds = (last - first) / 1000;
    if (stats.modelSeconds > 0) stats.avgSpeedTps = stats.outputTokens / stats.modelSeconds;

    const lastUsage = (records[records.length - 1].response || {}).usage || {};
    stats.contextUsed = lastUsage.inputTokens || 0;
    if (stats.inputTokens > 0) {
        stats.cacheHitRate = (stats.cacheReadTokens * 100) / stats.inputTokens;
    }
    return stats;
}

// 会话 ID 转文件名段：与 ZCode 客户端写 rollout 文件的规则一致（非法字符转 -、截断 80 字符）
function sanitizeFileSegment(value) {
    return String(value || "")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

// 按会话 ID 精准定位会话记录文件；会话尚无记录文件时返回 null
function sessionFileById(sessionId) {
    const segment = sanitizeFileSegment(sessionId);
    if (!segment) return null;
    const file = path.join(ROLLOUT_DIR, "model-io-" + segment + ".jsonl");
    try {
        fs.accessSync(file);
        return file;
    } catch {
        return null;
    }
}

function latestSessionFile() {
    let files = [];
    try {
        files = fs.readdirSync(ROLLOUT_DIR)
            .filter((n) => n.startsWith("model-io-sess_") && n.endsWith(".jsonl") && !n.includes("subagent"))
            .map((n) => path.join(ROLLOUT_DIR, n));
    } catch {
        return null;
    }
    if (!files.length) return null;
    return files.map((p) => ({ p, m: fs.statSync(p).mtimeMs })).sort((a, b) => b.m - a.m)[0].p;
}

function sessionIdFromFile(file) {
    return path.basename(file, ".jsonl").replace(/^model-io-/, "");
}

// ---------------------------------------------------------------------------
// SQLite 兜底与历史回填：ZCode 官方只保留最近几个 model-io 会话记录文件
// （超出即轮转删除），且重启后续接同一会话时文件按新运行期重建、只剩续接后记录。
// 文件彻底缺失时从 turn_usage 表汇总整会话兜底（sqliteFallbackStats）；
// 文件只剩半截历史时从 model_usage 表回填文件首条之前的行（mergeSqliteHistory），
// 避免续接会话「统计清零 / 只剩半截历史」。
// ---------------------------------------------------------------------------

const USAGE_DB = path.join(
    process.env.USERPROFILE || process.env.HOME || "", ".zcode", "cli", "db", "db.sqlite"
);

let sqliteModule = null;
try {
    // Node 22.5+ 内置，低版本缺失时保持空快照行为
    sqliteModule = require("node:sqlite");
} catch {
    sqliteModule = null;
}

let lastSqliteError = "";
function sqliteFallbackStats(sessionId, window, windowSource) {
    if (!sqliteModule) return null;
    let db = null;
    try {
        db = new sqliteModule.DatabaseSync(USAGE_DB, { readOnly: true });
        const row = db.prepare(
            "SELECT count(*) AS turns," +
            " ifnull(sum(model_request_count), 0) AS modelRequests," +
            " ifnull(sum(tool_call_count), 0) AS toolCalls," +
            " ifnull(sum(input_tokens), 0) AS inputTokens," +
            " ifnull(sum(output_tokens), 0) AS outputTokens," +
            " ifnull(sum(reasoning_tokens), 0) AS reasoningTokens," +
            " ifnull(sum(cache_read_input_tokens), 0) AS cacheReadTokens," +
            " ifnull(sum(computed_total_tokens), 0) AS totalTokens," +
            " min(started_at) AS firstAt," +
            " max(completed_at) AS lastAt" +
            " FROM turn_usage WHERE session_id = ?"
        ).get(sessionId);
        if (!row || !row.turns) return null;

        const sessionSeconds = row.firstAt && row.lastAt
            ? Math.max(0, (row.lastAt - row.firstAt) / 1000) : 0;
        const inputTokens = Math.max(0, row.inputTokens - row.cacheReadTokens);
        return {
            ok: true,
            source: "sqlite",
            sessionId,
            generatedAt: new Date().toISOString(),
            window,
            windowSource,
            totals: {
                totalTokens: row.totalTokens,
                requests: row.modelRequests,
                inputTokens,
                outputTokens: row.outputTokens,
                cacheReadTokens: row.cacheReadTokens,
                cacheHitRate: row.inputTokens > 0
                    ? (row.cacheReadTokens * 100) / row.inputTokens : 0,
                reasoningTokensEst: row.reasoningTokens,
            },
            speed: { last: 0, avg: 0 },
            time: {
                sessionText: fmtDuration(sessionSeconds),
                sessionSeconds,
                modelText: "",
                modelPct: 0,
                toolText: "",
                toolPct: 0,
            },
            tools: { kinds: 0, calls: row.toolCalls, top: [] },
            subagent: null,
        };
    } catch (err) {
        const message = String((err && err.message) || err);
        if (message !== lastSqliteError) {
            lastSqliteError = message;
            log("SQLite 用量兜底查询失败: " + message);
        }
        return null;
    } finally {
        if (db) { try { db.close(); } catch {} }
    }
}

// 历史回填查询：model_usage 是逐模型请求行（query_source=main_turn 与主会话文件记录
// 同口径），聚合「beforeMs 之前」的全部请求。cancelled 行也计入——中止请求与文件记录
// 一样占轮数，已产生的用量同样是真实历史
const HISTORY_BACKFILL_GAP_MS = 2000;

let lastBackfillError = "";
function sqliteHistoryBefore(sessionId, beforeMs) {
    if (!sqliteModule) return null;
    let db = null;
    try {
        db = new sqliteModule.DatabaseSync(USAGE_DB, { readOnly: true });
        const row = db.prepare(
            "SELECT count(*) AS requests," +
            " ifnull(sum(computed_total_tokens), 0) AS totalTokens," +
            " ifnull(sum(input_tokens), 0) AS inputTokens," +
            " ifnull(sum(output_tokens), 0) AS outputTokens," +
            " ifnull(sum(cache_read_input_tokens), 0) AS cacheReadTokens," +
            " ifnull(sum(reasoning_tokens), 0) AS reasoningTokens," +
            " ifnull(sum(tool_call_count), 0) AS toolCalls," +
            " ifnull(sum(duration_ms), 0) AS durationMs," +
            " min(started_at) AS firstStartedAt," +
            " max(completed_at) AS lastCompletedAt," +
            " (SELECT u.input_tokens FROM model_usage u" +
            "  WHERE u.session_id = m.session_id AND u.query_source = 'main_turn'" +
            "  ORDER BY u.started_at DESC LIMIT 1) AS lastInputTokens" +
            " FROM model_usage m" +
            " WHERE m.session_id = ? AND m.query_source = 'main_turn' AND m.started_at < ?"
        ).get(sessionId, beforeMs);
        if (!row || !row.requests) return null;
        return {
            requests: row.requests,
            totalTokens: row.totalTokens,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheReadTokens: row.cacheReadTokens,
            reasoningTokens: row.reasoningTokens,
            toolCalls: row.toolCalls,
            modelSeconds: row.durationMs / 1000,
            firstStartedAt: row.firstStartedAt,
            lastCompletedAt: row.lastCompletedAt,
            lastInputTokens: row.lastInputTokens,
        };
    } catch (err) {
        const message = String((err && err.message) || err);
        if (message !== lastBackfillError) {
            lastBackfillError = message;
            log("SQLite 历史回填查询失败: " + message);
        }
        return null;
    } finally {
        if (db) { try { db.close(); } catch {} }
    }
}

// 把文件首条之前的库中历史并进文件聚合值：各用量计数直接累加；会话时长改为
// 「历史首条 → 文件末条」跨度（文件被轮转过时真正的首条只在库里）；缓存命中率与
// 平均输出速度按合并后总量重算，速度口径不变（输出总量 / 模型总耗时）。
// 文件为空（刚续接还没记录落盘）时回填全部历史，并用库里最新一行的输入 token
// 修正 context.used，避免续接瞬间面板显示「剩余满额、已用 0%」的假象
function mergeSqliteHistory(stats, records, sessionId) {
    if (!sessionId || !sqliteModule) return;
    const fileFirst = records.length ? parseTs(records[0].startedAt) : null;
    // 边界另留间隔：同一请求在文件与库里落笔时间有毫秒级手抖，而相邻两次真实请求
    // 至少相隔数秒，据此既不漏算也不把文件首条本身双计
    const beforeMs = fileFirst != null
        ? fileFirst - HISTORY_BACKFILL_GAP_MS
        : Date.now();
    const backfill = sqliteHistoryBefore(sessionId, beforeMs);
    if (!backfill) return;
    stats.requests += backfill.requests;
    stats.totalTokens += backfill.totalTokens;
    stats.inputTokens += backfill.inputTokens;
    stats.outputTokens += backfill.outputTokens;
    stats.cacheReadTokens += backfill.cacheReadTokens;
    stats.reasoningTokensEst += backfill.reasoningTokens;
    stats.toolCalls += backfill.toolCalls;
    stats.modelSeconds += backfill.modelSeconds;
    const fileLast = records.length ? parseTs(records[records.length - 1].completedAt) : null;
    const startMs = fileFirst != null && backfill.firstStartedAt != null
        ? Math.min(fileFirst, backfill.firstStartedAt)
        : (backfill.firstStartedAt != null ? backfill.firstStartedAt : fileFirst);
    const endMs = fileLast != null && backfill.lastCompletedAt != null
        ? Math.max(fileLast, backfill.lastCompletedAt)
        : (backfill.lastCompletedAt != null ? backfill.lastCompletedAt : fileLast);
    if (startMs != null && endMs != null) {
        stats.sessionSeconds = Math.max(0, (endMs - startMs) / 1000);
    }
    if (stats.inputTokens > 0) {
        stats.cacheHitRate = (stats.cacheReadTokens * 100) / stats.inputTokens;
    }
    if (stats.modelSeconds > 0) {
        stats.avgSpeedTps = stats.outputTokens / stats.modelSeconds;
    }
    if (!records.length && backfill.lastInputTokens) {
        stats.contextUsed = backfill.lastInputTokens;
    }
    stats._backfill = backfill;
}

function collectSubagents(mainFile, mainStart) {
    let files = [];
    try {
        files = fs.readdirSync(ROLLOUT_DIR)
            .filter((n) => n.startsWith("model-io-sess_subagent_") && n.endsWith(".jsonl"));
    } catch {
        return null;
    }
    const total = { files: 0, requests: 0, totalTokens: 0, outputTokens: 0 };
    for (const name of files) {
        const records = readRecords(path.join(ROLLOUT_DIR, name));
        // 文件名不含本会话 ID 时，只统计开始时间落在主会话范围内的记录
        const scoped = name.includes(path.basename(mainFile, ".jsonl"))
            ? records
            : records.filter((r) => {
                const ts = parseTs(r.startedAt);
                return ts && mainStart && ts >= mainStart;
            });
        if (!scoped.length) continue;
        const stats = collectStats(scoped, DEFAULT_WINDOW);
        total.files += 1;
        total.requests += stats.requests;
        total.totalTokens += stats.totalTokens;
        total.outputTokens += stats.outputTokens;
    }
    return total.files ? total : null;
}

function buildStatsPayload(query) {
    // 会话 ID 先于窗口解析：live 窗口按会话归档，须知道本帧属于哪个会话
    const sessionId = (query.get("session") || "").trim();
    // 窗口分母优先级：?window= 显式覆盖（≥1000）> CDP 实时读取的面板真实值 > 默认 30 万。
    // live 值只取「页面显示本会话时读到」的条目且未过期，其他会话的窗口绝不串用；
    // 无 session 参数（管理页回退最新文件）时用最近一次读取兜底
    const override = parseInt(query.get("window") || "", 10);
    let window = DEFAULT_WINDOW;
    let windowSource = "default";
    if (override >= 1000) {
        window = override;
        windowSource = "override";
    } else {
        const liveEntry = sessionId
            ? liveWindowCache.get(sessionId)
            : (Date.now() - liveWindowLastRead.readAt < LIVE_WINDOW_TTL_MS ? liveWindowLastRead : null);
        if (liveEntry && Date.now() - liveEntry.readAt < LIVE_WINDOW_TTL_MS) {
            window = liveEntry.value;
            windowSource = "live";
        }
    }
    // 优先按前端传入的 session 参数精准定位会话文件，隔离并发会话；
    // 指定了会话但记录尚未落盘时返回空快照，绝不回退到「最新文件」——
    // 按 mtime 取最新文件正是不同会话数据串台的根因
    let sessionFile = sessionId ? sessionFileById(sessionId) : null;
    if (sessionId && !sessionFile) {
        // 记录文件已被官方轮转删除时，先尝试从客户端数据库兜底出真实历史用量
        const fallback = sqliteFallbackStats(sessionId, window, windowSource);
        if (fallback) return fallback;
        return {
            ok: true,
            empty: true,
            sessionId,
            generatedAt: new Date().toISOString(),
            window,
            windowSource,
            context: { used: 0, remaining: window, percent: 0 },
            totals: {
                totalTokens: 0,
                requests: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheHitRate: 0,
                reasoningTokensEst: 0,
            },
            speed: { last: 0, avg: 0 },
            time: { sessionText: "", sessionSeconds: 0, modelText: "", modelPct: 0, toolText: "", toolPct: 0 },
            tools: { kinds: 0, calls: 0, top: [] },
            subagent: null,
        };
    }
    if (!sessionFile) sessionFile = latestSessionFile();
    if (!sessionFile) return { ok: false, error: "未找到会话记录 " + ROLLOUT_DIR };
    const records = readRecords(sessionFile);
    const stats = collectStats(records, window);
    stats.sessionFile = sessionFile;
    mergeSqliteHistory(stats, records, sessionId || sessionIdFromFile(sessionFile));
    const toolCounter = stats._toolCounter || new Map();
    const payload = {
        ok: true,
        generatedAt: new Date().toISOString(),
        source: stats._backfill ? "file+sqlite" : "file",
        sessionFile,
        sessionId: sessionId || sessionIdFromFile(sessionFile),
        modelId: stats.modelId,
        window: stats.window,
        windowSource,
        context: {
            used: stats.contextUsed,
            remaining: Math.max(0, window - stats.contextUsed),
            percent: window ? Math.min(100, (stats.contextUsed * 100) / window) : 0,
        },
        totals: {
            totalTokens: stats.totalTokens,
            requests: stats.requests,
            inputTokens: stats.inputTokens - stats.cacheReadTokens,
            outputTokens: stats.outputTokens,
            cacheReadTokens: stats.cacheReadTokens,
            cacheHitRate: stats.cacheHitRate,
            reasoningTokensEst: stats.reasoningTokensEst,
        },
        speed: { last: stats.lastSpeedTps, avg: stats.avgSpeedTps },
        time: {
            sessionText: fmtDuration(stats.sessionSeconds),
            sessionSeconds: stats.sessionSeconds,
            modelText: fmtDuration(stats.modelSeconds),
            modelPct: stats.sessionSeconds ? (stats.modelSeconds * 100) / stats.sessionSeconds : 0,
            toolText: fmtDuration(stats.toolSeconds),
            toolPct: stats.sessionSeconds ? (stats.toolSeconds * 100) / stats.sessionSeconds : 0,
        },
        tools: {
            kinds: toolCounter.size,
            calls: stats.toolCalls,
            top: [...toolCounter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
                .map(([name, count]) => ({ name, count })),
        },
        subagent: null,
    };
    if (stats._backfill) {
        payload.backfill = {
            requests: stats._backfill.requests,
            totalTokens: stats._backfill.totalTokens,
        };
    }
    if (query.get("subagents") === "1") {
        const mainStart = parseTs(records.length ? records[0].startedAt : null);
        payload.subagent = collectSubagents(sessionFile, mainStart);
    }
    return payload;
}

// ---------------------------------------------------------------------------
// 统计推送（SSE）：监听会话目录，文件变化即重算并推给所有已连接页面。
// 每个客户端记录各自的 query（含 session 参数），推送时按会话分流，避免串台
// ---------------------------------------------------------------------------

const sseClients = new Set(); // { res, query }

function statsFrame(query) {
    // 每次出帧都尝试触发实时窗口刷新（内部有 TTL 与并发去重，常态直接跳过），
    // 保证切模型后约 1 分钟内分母跟上，且统计路径不阻塞等待 CDP
    refreshLiveWindow();
    let payload;
    try {
        payload = buildStatsPayload(query || new URLSearchParams());
    } catch (err) {
        payload = { ok: false, error: String((err && err.message) || err) };
    }
    return "data: " + JSON.stringify(payload) + "\n\n";
}

function broadcastStats() {
    if (!sseClients.size) return;
    for (const client of sseClients) {
        try {
            client.res.write(statsFrame(client.query));
        } catch {
            sseClients.delete(client);
        }
    }
}

function startStatsWatcher() {
    // 合并高频写入：防抖 150ms，且首次触发后最多 1s 必推一次
    let pending = null;
    let firstAt = 0;
    const schedule = () => {
        const now = Date.now();
        if (pending) clearTimeout(pending);
        else firstAt = now;
        pending = setTimeout(() => {
            pending = null;
            broadcastStats();
        }, now - firstAt > 1000 ? 0 : 150);
    };
    const fallbackPoll = (reason) => {
        log("会话目录监听不可用（" + reason + "），退回 2s 轮询兜底");
        setInterval(broadcastStats, 2000);
    };
    try {
        const watcher = fs.watch(ROLLOUT_DIR, schedule);
        watcher.on("error", (err) => {
            try { watcher.close(); } catch {}
            fallbackPoll(err.message);
        });
        log("会话目录监听已启动: " + ROLLOUT_DIR);
    } catch (err) {
        fallbackPoll(err.message);
    }
    // 事件丢失兜底：静默时每 15s 校准一次（无变化时只有 statSync，成本可忽略）
    setInterval(broadcastStats, 15000);
}

// ---------------------------------------------------------------------------
// 内置 HTTP 服务：管理页 / 插件接口 / 统计接口 / 插件脚本
// ---------------------------------------------------------------------------

// 默认不带 CORS 头：管理接口只供本服务同源的管理页使用，防止任意网页跨域读取；
// /stats 系列由注入到 ZCode 页面的插件跨域读取，调用时传 cors=true 开放
function sendJson(res, payload, cors) {
    if (cors) res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
}

function sendFile(res, filePath, contentType) {
    try {
        const data = fs.readFileSync(filePath);
        res.setHeader("Content-Type", contentType);
        res.end(data);
    } catch {
        res.statusCode = 404;
        res.end("// not found");
    }
}

function readBody(req) {
    return new Promise((resolve) => {
        let raw = "";
        // 请求体超过 1MB 截断：本地接口没有大请求体，防止恶意超大请求占内存
        req.on("data", (chunk) => { if (raw.length <= 1024 * 1024) raw += chunk; });
        req.on("end", () => {
            try {
                resolve(JSON.parse(raw || "{}"));
            } catch {
                resolve({});
            }
        });
    });
}

// 用系统默认浏览器打开内置服务页面；Electron 渲染进程内 window.open 会被主进程
// 拦截，应用内统一走 /api/open-browser 由 Node 侧打开（与启动时自动打开管理页同机制）
function openInDefaultBrowser(targetPath) {
    const target = "http://127.0.0.1:" + ports.stats + (targetPath || "/");
    spawn("cmd", ["/c", "start", "", target], {
        detached: true,
        stdio: "ignore",
    }).unref();
}

function startServer(port, attempt) {
    attempt = attempt || 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const pathname = url.pathname;

        // DNS rebinding 防护：服务只监听回环地址，Host 不是本机回环即拒绝
        const host = String(req.headers.host || "").toLowerCase();
        if (host !== "127.0.0.1:" + port && host !== "localhost:" + port) {
            res.statusCode = 403;
            res.end("forbidden");
            return;
        }

        // CORS 预检：注入插件携带令牌头的跨域请求会先发 OPTIONS
        if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, x-zcode-soul-token",
                "Access-Control-Max-Age": "86400",
            });
            res.end();
            return;
        }

        // /api/* 同源守卫：浏览器跨站调用必带 Origin，须携带注入时下发的随机令牌才放行，
        // 防止任意网页 drive-by 调用本地接口；同源管理页与命令行脚本（无 Origin 头，
        // 如 verify 测试、CDP 工具）不受影响
        if (pathname.startsWith("/api/")) {
            const origin = String(req.headers.origin || "");
            const sameOrigin = origin === "http://127.0.0.1:" + port || origin === "http://localhost:" + port;
            const hasToken = req.headers["x-zcode-soul-token"] === PLUGIN_TOKEN;
            if (origin && !sameOrigin && !hasToken) {
                sendJson(res, { ok: false, error: "已拒绝跨站请求" }, true);
                return;
            }
        }

        // 管理页
        if (req.method === "GET" && pathname === "/") {
            sendFile(res, path.join(ROOT, "manager.html"), "text/html; charset=utf-8");
            return;
        }
        // 插件列表
        if (req.method === "GET" && pathname === "/api/plugins") {
            const state = loadState();
            sendJson(res, {
                ok: true,
                plugins: scanPlugins().map((p) => ({ ...p, dir: undefined, enabled: isEnabled(state, p.id) })),
            });
            return;
        }
        // 切换插件开关
        let match = pathname.match(/^\/api\/plugins\/([^/]+)\/toggle$/);
        if (req.method === "POST" && match) {
            readBody(req).then((body) => {
                const enabled = body.enabled !== false;
                const state = loadState();
                state[decodeURIComponent(match[1])] = enabled;
                saveState(state);
                log("插件 " + match[1] + " 已" + (enabled ? "启用" : "禁用"));
                sendJson(res, { ok: true, id: match[1], enabled });
            });
            return;
        }
        // 在系统默认浏览器中打开管理页；path 参数仅允许本服务内的安全路径字符，
        // 防止参数拼进 cmd 命令造成注入
        if (req.method === "GET" && pathname === "/api/open-browser") {
            const targetPath = url.searchParams.get("path") || "/";
            if (!/^\/[\w\-./?=]*$/.test(targetPath) || targetPath.includes("..")) {
                sendJson(res, { ok: false, error: "仅支持打开本服务页面" });
                return;
            }
            openInDefaultBrowser(targetPath);
            sendJson(res, { ok: true });
            return;
        }
        // 会话统计
        if (req.method === "GET" && pathname === "/stats") {
            let payload;
            try {
                payload = buildStatsPayload(url.searchParams);
            } catch (err) {
                payload = { ok: false, error: String((err && err.message) || err) };
            }
            sendJson(res, payload, true);
            return;
        }
        // 会话统计推送（SSE）：连接立即推一次快照，之后会话文件变化时推送；
        // 连接 URL 携带的 session 参数决定该客户端只收自己会话的数据
        if (req.method === "GET" && pathname === "/stats/stream") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            res.write(": connected\n\n");
            const client = { res, query: url.searchParams };
            res.write(statsFrame(client.query));
            sseClients.add(client);
            // 心跳注释行，保持连接可探测
            const heartbeat = setInterval(() => {
                try { res.write(": ping\n\n"); } catch {}
            }, 25000);
            req.on("close", () => {
                clearInterval(heartbeat);
                sseClients.delete(client);
            });
            return;
        }
        // 插件注册的路由（插件服务端扩展经 ctx.registerRoute 登记）：分发放在全部
        // 内置路由之后，插件不能覆盖内置接口；/api/ 前缀在注册时已强制，
        // 同源守卫、令牌校验与 OPTIONS 预检对插件路由同样生效
        const pluginRoute = pluginRoutes.get(req.method + " " + pathname);
        if (pluginRoute) {
            try {
                pluginRoute.handler(req, res);
            } catch (err) {
                log("插件路由处理失败 [" + pluginRoute.pluginId + "]: " + err.message);
                sendJson(res, { ok: false, error: "插件接口异常: " + err.message }, true);
            }
            return;
        }

        // 插件脚本原文（调试 / fixture 用）
        match = pathname.match(/^\/plugin\/([^/]+)\/([a-zA-Z0-9._-]+)$/);
        if (req.method === "GET" && match) {
            const plugin = scanPlugins().find((p) => p.id === decodeURIComponent(match[1]));
            if (plugin) {
                sendFile(res, path.join(plugin.dir, match[2]), "application/javascript; charset=utf-8");
                return;
            }
        }
        // 组合加载器：运行时 + 插件脚本（禁用时返回卸载代码），fixture 页使用
        match = pathname.match(/^\/load\/([^/.]+)\.js$/);
        if (req.method === "GET" && match) {
            const id = decodeURIComponent(match[1]);
            const state = loadState();
            const plugins = scanPlugins();
            let code = RUNTIME_SNIPPET + "\nwindow.__ZCODE_SOUL_STATS_PORT__=" + ports.stats + ";\n";
            if (id === "all") {
                for (const plugin of plugins) {
                    if (isEnabled(state, plugin.id)) {
                        code += readPluginSources(plugin).join("\n") + "\n";
                    }
                }
            } else {
                const plugin = plugins.find((p) => p.id === id);
                if (plugin && isEnabled(state, id)) {
                    code += readPluginSources(plugin).join("\n");
                } else {
                    code += buildUnloader(id) + "\n/* 插件未启用或不存在 */";
                }
            }
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Type", "application/javascript; charset=utf-8");
            res.end(code);
            return;
        }
        // 测试页
        if (req.method === "GET" && pathname === "/fixture") {
            sendFile(res, path.join(ROOT, "test", "fixture.html"), "text/html; charset=utf-8");
            return;
        }

        res.statusCode = 404;
        sendJson(res, { ok: false, error: "not found" });
    });
    server.listen(port, "127.0.0.1", () => {
        try {
            fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
            fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");
        } catch {
            // PID 记录失败不影响服务
        }
        log("内置服务已启动: http://127.0.0.1:" + port + "/（插件管理页）");
    });
    server.on("error", (err) => {
        // 旧实例刚被接管停止时端口释放有延迟，最多重试 6 次
        if (err.code === "EADDRINUSE" && attempt < 6) {
            setTimeout(() => startServer(port, attempt + 1), 1000);
            return;
        }
        log("内置服务启动失败: " + err.message + "，启动器退出");
        process.exit(1);
    });
    return server;
}

// ---------------------------------------------------------------------------
// CDP：等待调试端口、注入脚本、看门狗巡检
// ---------------------------------------------------------------------------

const cdpBase = () => "http://127.0.0.1:" + ports.debug;

async function waitCdp(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(cdpBase() + "/json/version");
            if (res.ok) return true;
        } catch {
            // 尚未就绪，继续等待
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

// 页面注入状态探测：返回 runtime 版本、registry 键集合与各插件登记的 hash。
// 与期望状态一致时本轮跳过注入，避免每轮全量重发插件源码
const PROBE_SNIPPET =
    "(function(){var z=window.__zcodeSoul||{};" +
    "return JSON.stringify({v:z.version,r:Object.keys(z.registry||{}),h:z.hashes||{}});})()";

// 在一个 target 上按数组顺序串行执行多条表达式，复用一条 WebSocket 连接。
// 串行保证依赖顺序（runtime 必须先于插件执行）；整体超时后未完成的条目记失败
function evaluateBatchOnTarget(target, expressions) {
    return new Promise((resolve) => {
        const results = expressions.map((item) => ({ label: item.label, ok: false, error: "not run", value: null }));
        if (!expressions.length) {
            resolve(results);
            return;
        }
        let ws;
        try {
            ws = new WebSocket(target.webSocketDebuggerUrl);
        } catch (err) {
            results.forEach((r) => { r.error = String((err && err.message) || err); });
            resolve(results);
            return;
        }
        let done = false;
        let sent = 0;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve(results);
        };
        const timer = setTimeout(finish, 8000);
        const evaluateNext = () => {
            if (done) return;
            if (sent >= expressions.length) {
                finish();
                return;
            }
            const i = sent++;
            ws.send(JSON.stringify({
                id: i + 1,
                method: "Runtime.evaluate",
                params: { expression: expressions[i].code, returnByValue: true, awaitPromise: false },
            }));
        };
        ws.onopen = evaluateNext;
        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(typeof event.data === "string" ? event.data : "");
            } catch {
                return;
            }
            if (typeof msg.id !== "number" || msg.id < 1 || msg.id > results.length) return;
            const item = results[msg.id - 1];
            const detail = msg.result && msg.result.exceptionDetails;
            item.ok = !detail;
            item.error = detail ? JSON.stringify(detail).slice(0, 300) : null;
            item.value = (!detail && msg.result && msg.result.result) ? msg.result.result.value : null;
            evaluateNext();
        };
        ws.onerror = () => {
            for (let i = Math.max(0, sent - 1); i < results.length; i++) {
                if (!results[i].ok) results[i].error = "ws error";
            }
            finish();
        };
        ws.onclose = () => {
            for (const r of results) {
                if (r.error === "not run") r.error = "ws closed";
            }
            finish();
        };
    });
}

// 探测单个页面的注入状态；探测失败返回 null（调用方回退全量注入）
async function probeTarget(target) {
    const results = await evaluateBatchOnTarget(target, [{ label: "probe", code: PROBE_SNIPPET }]);
    const probe = results[0];
    if (!probe.ok || typeof probe.value !== "string") return null;
    try {
        const parsed = JSON.parse(probe.value);
        return {
            version: typeof parsed.v === "string" ? parsed.v : "",
            registryIds: Array.isArray(parsed.r) ? parsed.r : [],
            hashes: (parsed.h && typeof parsed.h === "object") ? parsed.h : {},
        };
    } catch {
        return null;
    }
}

// 组装某个页面需要的注入计划。页面状态探测成功时按差异增量生成：
// runtime 版本不匹配 → 重注入运行时；插件 hash 失配 → 热更（先卸载旧实例再注入新代码）；
// 页面上多出的 registry 条目（禁用/已删插件）→ 卸载。探测失败回退全量注入
function buildInjectPlan(plugins, state, page) {
    if (!page) {
        const plan = [{ label: "runtime", code: RUNTIME_SNIPPET }];
        for (const plugin of plugins) {
            if (!isEnabled(state, plugin.id)) {
                plan.push({ label: plugin.id + "(卸载)", code: buildUnloader(plugin.id) });
                continue;
            }
            const inject = buildPluginInject(plugin);
            if (inject) plan.push({ label: plugin.id, code: inject.code });
        }
        return plan;
    }
    const plan = [];
    if (page.version !== RUNTIME_VERSION) {
        plan.push({ label: "runtime", code: RUNTIME_SNIPPET });
    }
    const enabledIds = new Set();
    for (const plugin of plugins) {
        if (!isEnabled(state, plugin.id)) continue;
        enabledIds.add(plugin.id);
        const inject = buildPluginInject(plugin);
        if (!inject) continue;   // 语法校验失败：跳过热更，保留页面旧实例
        const onPage = page.registryIds.includes(plugin.id);
        if (onPage && page.hashes[plugin.id] === inject.hash) continue;
        if (onPage) plan.push({ label: plugin.id + "(热更卸载)", code: buildUnloader(plugin.id) });
        plan.push({ label: plugin.id, code: inject.code });
    }
    for (const id of page.registryIds) {
        if (!enabledIds.has(id)) {
            plan.push({ label: id + "(卸载)", code: buildUnloader(id) });
        }
    }
    return plan;
}

// 每轮巡检：先探测各页面注入状态，与期望不一致（或探测失败）才生成并执行注入计划。
// 返回 CDP 是否可达，供主循环记录注入暂停/恢复
let cdpLastError = "";

async function injectAll(plugins, state) {
    let targets = [];
    try {
        const res = await fetch(cdpBase() + "/json/list", { signal: AbortSignal.timeout(5000) });
        targets = await res.json();
    } catch (err) {
        cdpLastError = String((err && err.cause && err.cause.code) || (err && err.message) || err);
        return false;
    }
    for (const target of targets) {
        if (target.type !== "page") continue;
        if ((target.url || "").startsWith("devtools://")) continue;
        const page = await probeTarget(target);
        const plan = buildInjectPlan(plugins, state, page);
        if (!plan.length) continue;
        const results = await evaluateBatchOnTarget(target, plan);
        for (const item of results) {
            if (!item.ok) {
                log("注入失败 [" + item.label + "] " + (target.url || "").slice(0, 60) + ": " + item.error);
            }
        }
    }
    return true;
}

const LOG_FILE = path.join(ROOT, "data", "launcher.log");
const PID_FILE = path.join(ROOT, "data", "launcher.pid");

// 单实例接管：旧启动器残留时先停掉，避免双实例抢端口、看门狗僵死
function killStaleLauncher() {
    let pid = 0;
    try {
        pid = parseInt(fs.readFileSync(PID_FILE, "utf-8"), 10);
    } catch {
        return; // 无 PID 记录，说明没有旧实例
    }
    if (!pid || pid === process.pid) return;
    try {
        // 确认目标确实是 node 进程，防止 PID 复用误杀
        const out = require("node:child_process")
            .execSync('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: "utf-8" });
        if (!/node\.exe/i.test(out)) return;
        process.kill(pid);
        log("已停止旧启动器进程 (PID " + pid + ")");
    } catch {
        // 旧进程已不存在或无权停止，继续
    }
}

// 日志脱敏：上游接口的错误响应可能回显凭据片段（Authorization 头、网关回包），
// 统一在日志落盘与控制台打印前掩码，密钥不进 launcher.log
function sanitizeLogText(message) {
    return String(message)
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已掩码]")
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[已掩码]")
        .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[JWT 已掩码]");
}

function log(message) {
    const line = "[" + new Date().toLocaleTimeString() + "] " + sanitizeLogText(message);
    console.log(line);
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        // 超过 512KB 时清空重写，避免无限增长
        try {
            if (fs.statSync(LOG_FILE).size > 512 * 1024) fs.writeFileSync(LOG_FILE, "");
        } catch {
            // 文件不存在时直接写入
        }
        fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
    } catch {
        // 日志落盘失败不影响主流程
    }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
    killStaleLauncher();

    log("zcode-soul v" + APP_VERSION + " 启动器启动");
    const plugins = scanPlugins();
    const state = loadState();
    log("发现插件: " + (plugins.map((p) => p.id + (isEnabled(state, p.id) ? "" : "（已禁用）")).join(", ") || "无"));
    loadPluginServers(plugins);

    // statsPort 先分配再启动服务：被占用时顺延，实际端口随运行时下发给插件
    ports.stats = await allocatePort(config.statsPort, "statsPort");
    startServer(ports.stats);
    startStatsWatcher();

    // 管理页随启动自动打开（config.json openManager 可关闭）
    if (config.openManager !== false) {
        try {
            openInDefaultBrowser("/");
        } catch {
            // 打开浏览器失败不影响主流程
        }
    }

    // 开发开关：只起内置服务，不启动 ZCode、不做注入
    if (process.env.ZCODE_SOUL_NO_APP === "1") {
        log("ZCODE_SOUL_NO_APP=1，仅运行内置服务");
        return;
    }

    // 先扫描顺延区间：已有带调试端口的 ZCode 在运行时直接复用（含上次顺延启动的实例），
    // 避免重复拉起
    const reusedPort = await findRunningZcodeCdp();
    const alreadyRunning = reusedPort > 0;
    if (alreadyRunning) {
        ports.debug = reusedPort;
        log("检测到 ZCode 已带调试端口运行（" + reusedPort + "），直接复用");
        // ZCode 可能只是驻留在托盘没有可见窗口，尝试把页面窗口带到前台
        try {
            const list = await (await fetch(cdpBase() + "/json/list")).json();
            const page = list.find((t) => t.type === "page");
            if (page && page.id) {
                await fetch(cdpBase() + "/json/activate/" + page.id, { method: "PUT" });
            }
        } catch {
            // 激活失败不影响注入
        }
    } else {
        const zcodeExe = resolveZcodePath(config.zcodePath);
        if (!zcodeExe) {
            log("未找到 ZCode：zcodePath 未配置，常见安装位置也未探测到，已尝试：");
            zcodePathCandidates().forEach((candidate) => log("  - " + candidate));
            log("请在 config.json 的 zcodePath 填入 ZCode.exe 完整路径。");
            process.exit(1);
        }
        if (!fs.existsSync(zcodeExe)) {
            log("未找到 ZCode: " + zcodeExe + "，请修改 config.json 的 zcodePath。");
            process.exit(1);
        }
        // preferred 端口若被其他程序占用（非 ZCode 的 CDP）则顺延，避免 ZCode 启动失败
        ports.debug = await allocatePort(config.debugPort, "debugPort");
        log("启动 ZCode（调试端口 " + ports.debug + "）: " + zcodeExe);
        const child = spawn(zcodeExe, ["--remote-debugging-port=" + ports.debug], {
            detached: true,
            stdio: "ignore",
        });
        child.on("error", (err) => {
            log("ZCode 启动失败: " + err.message);
            process.exit(1);
        });
        child.unref();
    }

    const ready = alreadyRunning || await waitCdp(30000);
    if (!ready) {
        log("CDP 端口等待超时。ZCode 可能已在运行但未带调试端口（调试端口只能在进程启动时传入）。");
        log("内置服务将继续运行（http://127.0.0.1:" + ports.stats + "），并在后台持续等待 ZCode 开启调试端口...");
    } else {
        log("CDP 已就绪，开始注入并进入看门狗巡检（每 " + config.pollIntervalMs + "ms）");
    }

    let cdpMiss = 0;
    let injectedPausedLogged = false;
    while (true) {
        // 每轮重新扫描与读取状态，支持热更新插件与开关
        const current = scanPlugins();
        const currentState = loadState();
        // 运行中发现新的服务端扩展：路由表只随启动器加载，提示重启（注入脚本不受影响）
        const pendingServers = current.filter((p) => p.hasServer && !loadedServerIds.has(p.id));
        if (pendingServers.length) {
            if (!pendingServerNoticeLogged) {
                pendingServerNoticeLogged = true;
                log("检测到新增的插件服务扩展（" + pendingServers.map((p) => p.id).join(", ") + "），重启启动器后接口生效");
            }
        } else {
            pendingServerNoticeLogged = false;
        }
        const reachable = await injectAll(current, currentState);
        if (reachable) {
            if (injectedPausedLogged) {
                log("CDP 已恢复，继续注入");
                injectedPausedLogged = false;
            }
            cdpMiss = 0;
        } else {
            cdpMiss += 1;
            // CDP 持续不可达（约 2 分钟）时暂停注入并打日志，但进程与内置服务保留：
            // 服务一旦停掉面板就会「内置服务未连接」；残留进程由下次双击的 PID 接管兜底。
            if (cdpMiss >= 24 && !injectedPausedLogged) {
                log("CDP 持续不可达（最后错误: " + cdpLastError + "），注入暂停，内置服务保留");
                injectedPausedLogged = true;
            }
        }
        await new Promise((r) => setTimeout(r, config.pollIntervalMs));
    }
}

if (require.main === module) {
    main().catch((err) => {
        log("启动器异常: " + String((err && err.stack) || err));
        process.exit(1);
    });
} else {
    // 被测试脚本 require 时只导出注入计划的纯函数做断言，不启动任何服务
    module.exports = {
        buildInjectPlan,
        buildPluginInject,
        buildUnloader,
        PROBE_SNIPPET,
        RUNTIME_SNIPPET,
        RUNTIME_VERSION,
    };
}
