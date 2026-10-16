// 平台能力：读取 ZCode 桌面版「模型设置」中已配置的模型服务。
// 由 launch.js 加载并经插件上下文（ctx.zcodeProviders）暴露给插件服务端扩展，
// 密钥只在服务端使用，任何接口都不回传明文。
//
// 数据目录由 ~/.zcode/v2/setting.json 的 dataBaseDir 指定（未指定时为 ~/.zcode）；
// 目录下 provider_config.json 是「模型设置」界面的自定义供应商源，
// config.json 的 provider 节补充内置套餐服务（含协议类型与凭据）。

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function zcodeDataDir() {
    try {
        const setting = JSON.parse(fs.readFileSync(
            path.join(os.homedir(), ".zcode", "v2", "setting.json"), "utf-8"));
        const base = setting && typeof setting.dataBaseDir === "string" ? setting.dataBaseDir.trim() : "";
        // 「数据存储路径」设置只迁移数据，目录内允许缺 config.json（仅 provider_config.json 也可用）
        if (base && fs.existsSync(path.join(base, ".zcode", "v2"))) {
            return path.join(base, ".zcode", "v2");
        }
    } catch {
        // setting.json 缺失或损坏时回退默认目录
    }
    return path.join(os.homedir(), ".zcode", "v2");
}

function loadProviderConfigRules() {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(zcodeDataDir(), "provider_config.json"), "utf-8"));
        const config = j.config || {};
        return {
            rules: (config.providerConfigRules && config.providerConfigRules.providerRules) || [],
            order: config.providerOrder || [],
        };
    } catch {
        return { rules: [], order: [] };
    }
}

// 账号套餐 OAuth 网关（zcode.z.ai 的 zcode-plan 端点）：凭据由客户端登录态持有，
// 网关只接受桌面端会话请求（实测直连 401/405），config.json 里同步的 JWT 不是可直连的静态密钥
function isPlanOAuthGateway(baseURL) {
    return /zcode\.z\.ai/.test(baseURL) && /zcode-plan/.test(baseURL);
}

// 套餐控制台的 API Key 管理页（与 ZCode 内置模板 apiKeyManagementUrl 一致）；
// 在控制台生成 Coding Plan API Key 填入「模型设置」后，对应服务即可被插件直连复用
function planApiKeyUrl(providerId) {
    return String(providerId).includes("bigmodel")
        ? "https://bigmodel.cn/coding-plan/personal/overview"
        : "https://z.ai/manage-apikey/apikey-list";
}

// 账号套餐规则（id 形如 account:bigmodel-team-coding-plan）：回填对应内置服务的启用态与模型清单
function applyAccountRule(builtins, rule) {
    const id = String(rule.providerId || "");
    const family = id.replace(/^account:/, "").split("-")[0];
    const product = id.includes("start-plan") ? "start-plan" : (id.includes("coding-plan") ? "coding-plan" : "");
    if (!family || !product) return;
    const builtinId = "builtin:" + family + "-" + product;
    const target = builtins.find((p) => p.id === builtinId);
    if (!target) return;
    target.enabled = true;
    const modelIds = (rule.config && (rule.config.modelOrder || rule.config.personalModelIds)) || [];
    for (const modelId of modelIds) {
        if (!target.models.some((m) => m.id === modelId)) {
            target.models.push({ id: modelId, name: "", reasoningEnabled: false, outputLimit: 0 });
        }
    }
}

function loadZcodeProviders() {
    const dir = zcodeDataDir();
    const file = path.join(dir, "config.json");
    let providerMap = {};
    try {
        providerMap = JSON.parse(fs.readFileSync(file, "utf-8")).provider || {};
    } catch {
        // config.json 缺失或损坏时仍可仅凭 provider_config.json 列出自定义供应商
    }

    // config.json 的 provider 节：内置套餐服务与旧格式服务（含 kind / baseURL / 凭据）
    const legacy = [];
    for (const [id, p] of Object.entries(providerMap)) {
        if (!p || typeof p !== "object") continue;
        const models = [];
        for (const [modelId, m] of Object.entries(p.models || {})) {
            models.push({
                id: modelId,
                name: (m && m.name) || "",
                reasoningEnabled: Boolean(m && m.reasoning && m.reasoning.enabled),
                outputLimit: (m && m.limit && m.limit.output) || 0,
            });
        }
        const baseURL = (p.options && p.options.baseURL) || "";
        // 套餐 OAuth 网关服务的 JWT 由客户端持有，不能作为静态密钥直用，视为无可用凭据
        const planGateway = isPlanOAuthGateway(baseURL);
        legacy.push({
            id,
            name: p.name || id,
            kind: p.kind === "anthropic" ? "anthropic" : "openai",
            enabled: p.enabled === true,
            baseURL,
            hasApiKey: Boolean(p.options && p.options.apiKey) && !planGateway,
            planGateway,
            models,
        });
    }

    // provider_config.json：与「模型设置」界面一致的自定义供应商（列表以此为准）
    const { rules, order } = loadProviderConfigRules();
    const custom = [];
    for (const rule of rules) {
        if (!rule || !rule.providerId) continue;
        if (String(rule.providerId).startsWith("account:")) {
            applyAccountRule(legacy, rule);
            continue;
        }
        const cfg = rule.config || {};
        const api = cfg.api || {};
        if (!api.baseUrl) continue;
        const modelIds = cfg.modelOrder || cfg.personalModelIds || [];
        custom.push({
            id: rule.providerId,
            name: rule.providerName || rule.providerId,
            kind: api.type === "anthropic-messages" ? "anthropic" : "openai",
            enabled: true,
            baseURL: api.baseUrl,
            hasApiKey: Boolean(cfg.access && cfg.access.apiKey),
            models: modelIds.map((id) => ({ id, name: "", reasoningEnabled: false, outputLimit: 0 })),
        });
    }
    // 界面展示顺序：providerOrder 在前的排前面
    custom.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    });

    // 自定义供应商以 provider_config.json（模型设置界面）为准：界面已删除的不展示，
    // config.json 仅补充内置套餐服务
    const providers = custom.concat(legacy.filter((p) => p.id.startsWith("builtin:")));
    // 已启用的服务排前面，作为未显式选择时的默认值
    providers.sort((a, b) => Number(b.enabled) - Number(a.enabled));
    return { ok: providers.length > 0, dataDir: dir, configFile: file, providers };
}

// 按需单独读取某个服务的密钥（仅服务端调用时使用）：provider_config 优先，回退 config.json。
// 套餐 OAuth 网关服务的 JWT 不是可直连凭据，一律视为未配置
function readZcodeProviderSecret(providerId) {
    const state = loadZcodeProviders();
    const meta = state.providers.find((p) => p.id === providerId);
    if (meta && meta.planGateway) return "";
    const rule = loadProviderConfigRules().rules.find((r) => r && r.providerId === providerId);
    const fromRules = rule && rule.config && rule.config.access && rule.config.access.apiKey;
    if (fromRules) return fromRules;
    try {
        const p = (JSON.parse(fs.readFileSync(path.join(zcodeDataDir(), "config.json"), "utf-8")).provider || {})[providerId];
        return (p && p.options && p.options.apiKey) || "";
    } catch {
        return "";
    }
}

// 解析「模型设置」来源的实际调用目标：显式选择优先，否则回退到「已启用且有密钥」的服务，
// 避免默认值落在账号套餐网关（不可直连）或未配置密钥的服务上；全部不可用时抛错提示用户
function resolveZcodeTarget(cfg) {
    const state = loadZcodeProviders();
    if (!state.providers.length) {
        throw new Error("未读取到 ZCode 模型设置（数据目录 " + state.dataDir + "）");
    }
    const provider = state.providers.find((p) => p.id === cfg.zcodeProviderId && p.hasApiKey) ||
        state.providers.find((p) => p.enabled && p.hasApiKey) ||
        state.providers.find((p) => p.hasApiKey);
    if (!provider) {
        throw new Error("没有可直连的模型服务（均为账号套餐网关或未配置密钥）");
    }
    if (!provider.baseURL) {
        throw new Error("模型服务「" + provider.name + "」缺少 API 地址，请在 ZCode 模型设置中补全");
    }
    const savedModel = provider.models.find((m) => m.id === cfg.zcodeModel);
    const model = savedModel || provider.models[0];
    if (!model) {
        throw new Error("模型服务「" + provider.name + "」没有可选模型");
    }
    return { provider, model };
}

// 「跟随当前模型」来源：按输入框当前显示的模型标签（形如「供应商名/模型名」）解析直连
// 目标。匹配策略：先按供应商名找服务、服务内按模型 id 双向兼容匹配；供应商命中但模型
// 未对上时用该服务首个模型兜底；标签无供应商段或供应商没对上时按模型名跨服务找
function resolveZcodeTargetByLabel(label) {
    const state = loadZcodeProviders();
    const usable = state.providers.filter((p) => p.hasApiKey && p.baseURL && p.enabled !== false);
    if (!usable.length) {
        throw new Error("没有可直连的模型服务（均为账号套餐网关、未配置密钥或未启用）");
    }
    const raw = String(label || "").trim();
    if (!raw) {
        throw new Error("未读取到当前使用的模型（输入框上方未显示模型名，或当前不在会话页）");
    }
    const parts = raw.split("/");
    const namePart = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const modelPart = parts.length > 1 ? parts[parts.length - 1] : raw;
    const lo = (s) => String(s || "").toLowerCase();

    const modelHit = (provider) => provider.models.find((m) => m.id === modelPart)
        || provider.models.find((m) => m.id.endsWith("/" + modelPart) || modelPart.endsWith("/" + m.id))
        || provider.models.find((m) => { const a = lo(m.id), b = lo(modelPart); return a === b || a.includes(b) || b.includes(a); });

    if (namePart) {
        for (const p of usable) {
            const name = lo(p.name);
            const nameHit = name === lo(raw) || name === lo(namePart)
                || name.includes(lo(namePart)) || lo(namePart).includes(name);
            if (!nameHit) continue;
            const model = modelHit(p) || p.models[0];
            if (model) return { provider: p, model };
        }
    }
    for (const p of usable) {
        const model = modelHit(p);
        if (model) return { provider: p, model };
    }
    throw new Error("按当前模型「" + raw + "」未匹配到可直连的模型服务，可切换为「模型设置」手动选择");
}

// 是否存在可直连复用（有静态密钥）的模型设置服务
function hasUsableZcodeProvider() {
    return loadZcodeProviders().providers.some((p) => p.hasApiKey);
}

module.exports = {
    zcodeDataDir,
    loadZcodeProviders,
    readZcodeProviderSecret,
    resolveZcodeTarget,
    resolveZcodeTargetByLabel,
    hasUsableZcodeProvider,
    planApiKeyUrl,
    isPlanOAuthGateway,
};
