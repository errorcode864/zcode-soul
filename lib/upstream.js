// 平台能力：上游模型调用与 User-Agent 对齐。
// 由 launch.js 加载并经插件上下文（ctx.callModel）暴露给插件服务端扩展；
// cdpBase / zcodeExe 等宿主环境参数由调用方传入，本模块不依赖启动器。
//
// UA 形态：`ZCode/<客户端版本> ai-sdk/provider-utils/<版本> <运行时标记>`，运行时
// 标记复刻客户端逻辑（Node 24 下为 runtime/node.js/24），使模型网关使用日志的
// 「用户代理」列不因请求走启动器而显示为裸 node。
// 客户端版本从 CDP /json/version 的 User-Agent 提取（如 ZCode/3.15.3），探测失败
// 不缓存结果（下次请求重试），仍取不到时按客户端自身的兜底格式记为 unknown；
// provider-utils 版本从客户端 zcode.cjs 动态提取（多份 vendored 取最大）

const fs = require("node:fs");

// 客户端 zcode.cjs 内 vendored 多份 @ai-sdk/provider-utils（当前 4.0.27 与 4.0.39），
// 发往模型网关的模型调用（postJsonToApi 路径，含主链路）走其中最新一份，故提取包内
// 全部引用版本取最大值，客户端升级后无需改这里；包不可读或结构变更时回退到最后已知值
const FALLBACK_AI_SDK_PROVIDER_UTILS_VERSION = "4.0.39";
let providerUtilsVersionCache = { value: "", readAt: 0 };
let clientVersionCache = { value: "", probedAt: 0 };

async function resolveZcodeClientVersion(cdpBase) {
    // 成功结果缓存 10 分钟：客户端升级换版本无需重启启动器
    if (clientVersionCache.value && Date.now() - clientVersionCache.probedAt < 600000) {
        return clientVersionCache.value;
    }
    try {
        const res = await fetch(cdpBase + "/json/version", { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
            const info = await res.json();
            // CDP 返回的字段名是带连字符的 "User-Agent"，兜底容忍驼峰拼写
            const ua = String(info["User-Agent"] || info.userAgent || "");
            const matched = ua.match(/ZCode\/(\S+)/);
            if (matched) {
                clientVersionCache = { value: matched[1], probedAt: Date.now() };
            }
        }
    } catch {
        // 客户端未运行或 CDP 不可达：本轮回退 unknown
    }
    return clientVersionCache.value;
}

// 模板 `ai-sdk/provider-utils/${变量}` 中的变量各自落到一处 "x.y.z" 赋值，
// 全部抠出后取最大版本（取舍原因见上方常量注释）
async function resolveProviderUtilsVersion(zcodeExe) {
    if (providerUtilsVersionCache.value && Date.now() - providerUtilsVersionCache.readAt < 600000) {
        return providerUtilsVersionCache.value;
    }
    if (zcodeExe) {
        try {
            const bundlePath = require("node:path").join(
                require("node:path").dirname(zcodeExe), "resources", "glm", "zcode.cjs");
            const bundle = await fs.promises.readFile(bundlePath, "utf8");
            const versions = [];
            const sitePattern = /ai-sdk\/provider-utils\/\$\{([A-Za-z_$][\w$]*)\}/g;
            let site;
            while ((site = sitePattern.exec(bundle)) !== null) {
                const def = bundle.match(new RegExp(
                    '(?<![\\w$])' + site[1].replace(/\$/g, "\\$") + '="(\\d+\\.\\d+\\.\\d+)"'));
                if (def && !versions.includes(def[1])) versions.push(def[1]);
            }
            const latest = versions.sort((a, b) => {
                const pa = a.split(".").map(Number);
                const pb = b.split(".").map(Number);
                for (let i = 0; i < 3; i++) {
                    if (pa[i] !== pb[i]) return pb[i] - pa[i];
                }
                return 0;
            })[0];
            if (latest) providerUtilsVersionCache = { value: latest, readAt: Date.now() };
        } catch {
            // 包不可读：本回合回退最后已知值，失败不缓存
        }
    }
    return providerUtilsVersionCache.value || FALLBACK_AI_SDK_PROVIDER_UTILS_VERSION;
}

// 复刻客户端 llt() 运行时标记：优先取 navigator.userAgent（Node 24 为 Node.js/24，
// 与主链路一致），无 navigator 的环境才退回完整 process.version
function buildRuntimeMarker() {
    if (globalThis.navigator && globalThis.navigator.userAgent) {
        return "runtime/" + globalThis.navigator.userAgent.toLowerCase();
    }
    return "runtime/node.js/" + process.version;
}

function buildUpstreamUserAgent(clientVersion, providerUtilsVersion) {
    return "ZCode/" + (clientVersion || "unknown") +
        " ai-sdk/provider-utils/" + (providerUtilsVersion || FALLBACK_AI_SDK_PROVIDER_UTILS_VERSION) +
        " " + buildRuntimeMarker();
}

// Anthropic Messages 协议（ZCode 内置 BigModel / Z.ai 服务及 anthropic 兼容网关均为此类型）
async function callAnthropicMessages(baseURL, apiKey, model, maxTokens, systemPrompt, userPrompt, signal, userAgent) {
    let url = baseURL.trim().replace(/\/+$/, "");
    url += url.endsWith("/v1") ? "/messages" : "/v1/messages";
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "User-Agent": userAgent,
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
        }),
        signal,
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error("API 请求失败 (" + response.status + "): " + errText.slice(0, 300));
    }
    const data = await response.json();
    const text = (Array.isArray(data.content) ? data.content : [])
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
        .trim();
    if (!text) {
        throw new Error("模型只返回了思考内容或空响应，请换一个非推理模型");
    }
    return text;
}

// OpenAI 兼容 chat/completions 协议（自定义 API 与模型设置中 openai 类型服务）
async function callOpenAiChat(apiUrl, apiKey, model, temperature, systemPrompt, userPrompt, signal, userAgent) {
    let baseUrl = (apiUrl || "https://api.deepseek.com/v1").trim().replace(/\/+$/, "");
    if (!baseUrl.endsWith("/chat/completions")) {
        baseUrl += "/chat/completions";
    }
    const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey,
            "User-Agent": userAgent,
        },
        body: JSON.stringify({
            model,
            temperature: typeof temperature === "number" ? temperature : 0.3,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
        }),
        signal,
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error("API 请求失败 (" + response.status + "): " + errText.slice(0, 300));
    }
    const data = await response.json();
    return (data.choices && data.choices[0] && data.choices[0].message)
        ? data.choices[0].message.content
        : "";
}

// 统一上游模型调用入口：按服务协议分发到对应实现，并自动对齐客户端主链路 User-Agent。
// opts: { kind: "anthropic"|"openai", baseURL, apiKey, model, systemPrompt, userPrompt,
//         temperature?, maxTokens?, signal? }
//       temperature 仅 openai 使用；maxTokens 仅 anthropic 使用（缺省 8192）
// env:  { cdpBase, zcodeExe } —— 宿主环境参数，用于探测客户端版本以构造 UA
async function callModel(opts, env) {
    const userAgent = buildUpstreamUserAgent(
        await resolveZcodeClientVersion((env && env.cdpBase) || ""),
        await resolveProviderUtilsVersion((env && env.zcodeExe) || ""));
    if (opts.kind === "anthropic") {
        return callAnthropicMessages(
            opts.baseURL, opts.apiKey, opts.model, opts.maxTokens || 8192,
            opts.systemPrompt, opts.userPrompt, opts.signal, userAgent);
    }
    return callOpenAiChat(
        opts.baseURL, opts.apiKey, opts.model, opts.temperature,
        opts.systemPrompt, opts.userPrompt, opts.signal, userAgent);
}

module.exports = {
    resolveZcodeClientVersion,
    resolveProviderUtilsVersion,
    buildUpstreamUserAgent,
    callModel,
};
