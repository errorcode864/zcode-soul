// prompt-enhancement-plus 管理页扩展：提示词增强配置弹窗。
// 由扩展管理页按 /api/plugins 的 hasManager 声明以同源 script 动态加载，
// 通过 window.__zcodeSoulManager 注册卡片钩子（操作区配置按钮 + 详情区入口）。
// 弹窗 UI 与配置逻辑全部内聚在本插件目录，新增同类插件无需再改 manager.html；
// 样式复用管理页通用弹窗/表单类（.modal-* .form-* .seg 等），深浅色随管理页主题。
(function () {
    "use strict";
    var ID = "prompt-enhancement-plus";
    var API = location.origin;

    // 幂等：扩展脚本被重复加载时不叠加弹窗
    if (document.getElementById("enhance-modal")) return;

    var Mgr = window.__zcodeSoulManager = window.__zcodeSoulManager || {};
    if (!Mgr.hooks) Mgr.hooks = {};

    var GEAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';

    // —— 弹窗 DOM（自扩展管理页内联结构迁入，元素 id 保持不变）——
    var backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.id = "enhance-modal";
    backdrop.innerHTML =
        '<div class="modal-dialog">' +
        '<div class="modal-header">' +
        '<h3 class="modal-title">提示词增强设置</h3>' +
        '<button class="modal-close" id="btn-enhance-modal-close" title="关闭">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
        '</button>' +
        '</div>' +
        '<div class="form-group">' +
        '<label class="form-label">模型来源</label>' +
        '<div class="seg">' +
        '<button type="button" class="seg-btn" id="enhance-source-follow">跟随当前模型</button>' +
        '<button type="button" class="seg-btn" id="enhance-source-zcode">模型设置</button>' +
        '<button type="button" class="seg-btn" id="enhance-source-custom">自定义 API</button>' +
        '</div>' +
        '<div class="form-hint" id="enhance-source-hint">「跟随当前模型」自动匹配输入框当前显示的供应商与模型，改写用模型随会话切换</div>' +
        '</div>' +
        '<div id="enhance-zcode-fields" style="display:none;">' +
        '<div class="form-group">' +
        '<label class="form-label" for="enhance-zcode-provider">模型服务</label>' +
        '<select class="form-input" id="enhance-zcode-provider"></select>' +
        '<div class="form-hint">仅可选择已配置密钥的服务；账号登录的套餐网关（如 Coding Plan）凭据由客户端持有、无法被插件复用，需在套餐控制台生成 API Key 填入「模型设置」后才可选</div>' +
        '</div>' +
        '<div class="form-group">' +
        '<label class="form-label" for="enhance-zcode-model">模型</label>' +
        '<select class="form-input" id="enhance-zcode-model"></select>' +
        '<div class="form-hint">推荐低延迟、高遵循性的通用模型</div>' +
        '</div>' +
        '</div>' +
        '<div id="enhance-custom-fields" style="display:none;">' +
        '<div class="form-group">' +
        '<label class="form-label" for="enhance-api-url">API 地址 (OpenAI 兼容)</label>' +
        '<input type="text" class="form-input" id="enhance-api-url" placeholder="https://api.deepseek.com/v1">' +
        '<div class="form-hint">支持 DeepSeek、OpenAI、Ollama 等接口（会自动追加 /chat/completions）</div>' +
        '</div>' +
        '<div class="form-row">' +
        '<div class="form-group">' +
        '<label class="form-label" for="enhance-api-key">API Key</label>' +
        '<input type="password" class="form-input" id="enhance-api-key" placeholder="sk-...">' +
        '<div class="form-hint">仅存储在本地 data 目录；已保存的密钥不回传明文，清空保存即删除，输入新值则覆盖</div>' +
        '</div>' +
        '<div class="form-group">' +
        '<label class="form-label" for="enhance-model">模型名称</label>' +
        '<input type="text" class="form-input" id="enhance-model" placeholder="deepseek-chat">' +
        '<div class="form-hint">推荐低延迟、高遵循性的通用模型</div>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div class="form-group">' +
        '<div class="form-label-row">' +
        '<label class="form-label" for="enhance-template">改写模板</label>' +
        '<div style="display:flex;gap:6px;">' +
        '<button type="button" class="cfg-btn-sm" id="btn-insert-draft">插入 {{draft}}</button>' +
        '<button type="button" class="cfg-btn-sm" id="btn-restore-template">恢复默认</button>' +
        '</div>' +
        '</div>' +
        '<textarea class="form-textarea" id="enhance-template" spellcheck="false"></textarea>' +
        '<div class="form-hint">模板中必须包含 {{draft}} 占位符，运行时替换为当前输入框草稿</div>' +
        '</div>' +
        '<div class="modal-actions">' +
        '<span id="enhance-status" style="font-size:12px;color:var(--fg-subtle);margin-right:auto;"></span>' +
        '<button class="btn btn-ghost" id="btn-enhance-cancel">取消</button>' +
        '<button class="btn btn-primary" id="btn-enhance-save">保存设置</button>' +
        '</div>' +
        '</div>';
    document.body.appendChild(backdrop);

    // —— 配置逻辑（自扩展管理页迁入）——
    var defaultEnhanceTemplate = "";
    var enhanceSource = "zcode";
    var zcodeProvidersCache = [];

    var ENHANCE_SOURCE_HINTS = {
        follow: "「跟随当前模型」自动匹配输入框当前显示的供应商与模型，改写用模型随会话切换",
        zcode: "「模型设置」复用 ZCode 客户端已配置的服务与密钥，无需重复填写",
        custom: "「自定义 API」调用 OpenAI 兼容接口，需自行填写地址与 API Key"
    };

    function setEnhanceSource(source) {
        enhanceSource = source;
        document.getElementById("enhance-source-follow").classList.toggle("active", source === "follow");
        document.getElementById("enhance-source-zcode").classList.toggle("active", source === "zcode");
        document.getElementById("enhance-source-custom").classList.toggle("active", source === "custom");
        document.getElementById("enhance-zcode-fields").style.display = source === "zcode" ? "" : "none";
        document.getElementById("enhance-custom-fields").style.display = source === "custom" ? "" : "none";
        var hint = document.getElementById("enhance-source-hint");
        if (hint) hint.textContent = ENHANCE_SOURCE_HINTS[source] || "";
    }

    function fillZcodeModelSelect(selectedModelId) {
        var modelSel = document.getElementById("enhance-zcode-model");
        var providerSel = document.getElementById("enhance-zcode-provider");
        var provider = zcodeProvidersCache.find(function (p) { return p.id === providerSel.value; });
        modelSel.innerHTML = "";
        if (!provider) return;
        provider.models.forEach(function (m) {
            var opt = document.createElement("option");
            opt.value = m.id;
            opt.textContent = m.name && m.name !== m.id ? m.id + "（" + m.name + "）" : m.id;
            modelSel.appendChild(opt);
        });
        if (selectedModelId && provider.models.some(function (m) { return m.id === selectedModelId; })) {
            modelSel.value = selectedModelId;
        }
    }

    function fillZcodeProviderSelect(selectedProviderId, selectedModelId) {
        var providerSel = document.getElementById("enhance-zcode-provider");
        providerSel.innerHTML = "";
        // 只列出可直连复用的服务：账号套餐网关、未配置密钥、未启用的直接不展示
        zcodeProvidersCache.filter(zcodeProviderUsable).forEach(function (p) {
            var opt = document.createElement("option");
            var host = "";
            try { host = new URL(p.baseURL).host; } catch (e) {}
            opt.value = p.id;
            opt.textContent = p.name + (host ? " · " + host : "");
            providerSel.appendChild(opt);
        });
        var savedUsable = selectedProviderId && zcodeProvidersCache.some(function (p) {
            return p.id === selectedProviderId && zcodeProviderUsable(p);
        });
        if (savedUsable) {
            providerSel.value = selectedProviderId;
        }
        fillZcodeModelSelect(savedUsable ? selectedModelId : "");
    }

    // 服务是否可被选中：有静态密钥、非账号套餐网关、已启用
    function zcodeProviderUsable(p) {
        return Boolean(p && p.hasApiKey && !p.planGateway && p.enabled !== false);
    }

    document.getElementById("enhance-source-follow").addEventListener("click", function () {
        if (!zcodeProvidersCache.some(zcodeProviderUsable)) return;
        setEnhanceSource("follow");
    });
    document.getElementById("enhance-source-zcode").addEventListener("click", function () {
        if (!zcodeProvidersCache.some(zcodeProviderUsable)) return;
        setEnhanceSource("zcode");
    });
    document.getElementById("enhance-source-custom").addEventListener("click", function () {
        setEnhanceSource("custom");
    });
    document.getElementById("enhance-zcode-provider").addEventListener("change", function () {
        fillZcodeModelSelect("");
    });

    function openEnhanceModal() {
        var modal = document.getElementById("enhance-modal");
        var status = document.getElementById("enhance-status");
        status.textContent = "正在加载配置...";
        status.style.color = "var(--fg-subtle)";
        modal.classList.add("open");

        Promise.all([
            fetch(API + "/api/prompt-enhancement/config").then(function (res) { return res.json(); }),
            fetch(API + "/api/prompt-enhancement/zcode-models").then(function (res) { return res.json(); })
        ]).then(function (results) {
            var data = results[0];
            var zdata = results[1] || {};
            if (!data.ok) {
                status.textContent = "配置加载失败: " + (data.error || "");
                return;
            }
            var cfg = data.config || {};
            defaultEnhanceTemplate = data.defaultTemplate || "";
            zcodeProvidersCache = zdata.providers || [];
            var usableCount = zcodeProvidersCache.filter(zcodeProviderUsable).length;

            var zcodeBtn = document.getElementById("enhance-source-zcode");
            var followBtn = document.getElementById("enhance-source-follow");
            zcodeBtn.disabled = !usableCount;
            followBtn.disabled = !usableCount;

            // 后端已把旧值 cli 与空值归一为 follow / zcode / custom，此处直接取用
            var source = cfg.source === "custom" ? "custom" : (cfg.source === "follow" ? "follow" : "zcode");
            // 已保存的服务不可直连（套餐网关 / 未配置密钥 / 未启用）时改选首个可用服务；
            // 没有任何可用服务时切换为「自定义 API」并说明（follow 同样依赖可直连服务）
            var savedProvider = cfg.zcodeProviderId
                ? zcodeProvidersCache.find(function (p) { return p.id === cfg.zcodeProviderId; }) : null;
            var savedUsable = zcodeProviderUsable(savedProvider);
            var notice = "";
            if (source !== "custom" && !usableCount) {
                source = "custom";
                notice = "没有可直连的模型服务（均为账号套餐网关、未配置密钥或未启用），已切换为「自定义 API」。如需使用套餐额度，可在套餐控制台生成 Coding Plan API Key 并填入 ZCode「模型设置」";
            } else if (source === "zcode" && cfg.zcodeProviderId && !savedUsable) {
                if (savedProvider && savedProvider.planGateway) {
                    notice = "已选服务「" + savedProvider.name + "」是账号套餐网关、无法被插件复用，已改为选择首个可用服务。可在套餐控制台生成 Coding Plan API Key 并填入 ZCode「模型设置」后再选";
                } else if (savedProvider) {
                    notice = "已选服务「" + savedProvider.name + "」未配置密钥或未启用，已改为选择首个可用服务";
                }
            }
            setEnhanceSource(source);
            fillZcodeProviderSelect(savedUsable ? cfg.zcodeProviderId : "", savedUsable ? cfg.zcodeModel : "");

            document.getElementById("enhance-api-url").value = cfg.apiUrl || "";
            document.getElementById("enhance-api-key").value = cfg.apiKey || "";
            document.getElementById("enhance-model").value = cfg.model || "";
            document.getElementById("enhance-template").value = cfg.userTemplate || defaultEnhanceTemplate;
            status.textContent = notice;
            status.style.color = notice ? "var(--warning)" : "var(--fg-subtle)";
        }).catch(function (err) {
            status.textContent = "网络错误: " + err.message;
        });
    }

    function closeEnhanceModal() {
        document.getElementById("enhance-modal").classList.remove("open");
    }

    document.getElementById("btn-enhance-modal-close").addEventListener("click", closeEnhanceModal);
    document.getElementById("btn-enhance-cancel").addEventListener("click", closeEnhanceModal);

    document.getElementById("btn-insert-draft").addEventListener("click", function () {
        var ta = document.getElementById("enhance-template");
        var start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
        var end = ta.selectionEnd != null ? ta.selectionEnd : start;
        var val = ta.value;
        ta.value = val.slice(0, start) + "{{draft}}" + val.slice(end);
        ta.selectionStart = start + "{{draft}}".length;
        ta.selectionEnd = ta.selectionStart;
        ta.focus();
    });

    document.getElementById("btn-restore-template").addEventListener("click", function () {
        document.getElementById("enhance-template").value = defaultEnhanceTemplate;
    });

    document.getElementById("btn-enhance-save").addEventListener("click", function () {
        var btn = document.getElementById("btn-enhance-save");
        var status = document.getElementById("enhance-status");
        var template = document.getElementById("enhance-template").value;

        if (template.trim() && template.indexOf("{{draft}}") === -1) {
            status.textContent = "模板中必须包含 {{draft}} 占位符";
            status.style.color = "var(--warning)";
            return;
        }

        var payload = {
            source: enhanceSource,
            userTemplate: template.trim() === defaultEnhanceTemplate.trim() ? "" : template
        };
        if (enhanceSource === "follow") {
            // 跟随当前模型：目标在增强时按输入框显示的模型实时解析，无需预选服务
        } else if (enhanceSource === "zcode") {
            var providerSel = document.getElementById("enhance-zcode-provider");
            var modelSel = document.getElementById("enhance-zcode-model");
            if (!providerSel.value || !modelSel.value) {
                status.textContent = "请选择模型服务与模型";
                status.style.color = "var(--warning)";
                return;
            }
            payload.zcodeProviderId = providerSel.value;
            payload.zcodeModel = modelSel.value;
        } else {
            payload.apiUrl = document.getElementById("enhance-api-url").value.trim();
            payload.apiKey = document.getElementById("enhance-api-key").value.trim();
            payload.model = document.getElementById("enhance-model").value.trim();
        }

        btn.disabled = true;
        status.textContent = "正在保存...";
        status.style.color = "var(--fg-subtle)";

        fetch(API + "/api/prompt-enhancement/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            btn.disabled = false;
            if (data.ok) {
                status.textContent = "设置已保存";
                status.style.color = "var(--success)";
                setTimeout(closeEnhanceModal, 800);
            } else {
                status.textContent = "保存失败: " + (data.error || "");
                status.style.color = "var(--warning)";
            }
        })
        .catch(function (err) {
            btn.disabled = false;
            status.textContent = "请求失败: " + err.message;
            status.style.color = "var(--warning)";
        });
    });

    // —— 卡片钩子注册：操作区配置按钮 + 详情区设置入口 ——
    Mgr.register(ID, {
        actions: function () {
            return [{
                title: "配置提示词增强",
                icon: GEAR_ICON,
                onClick: openEnhanceModal
            }];
        },
        detail: function (container) {
            var cfgLink = document.createElement("button");
            cfgLink.type = "button";
            cfgLink.className = "cfg-btn-sm";
            cfgLink.style.marginTop = "10px";
            cfgLink.style.display = "inline-flex";
            cfgLink.style.alignItems = "center";
            cfgLink.style.gap = "4px";
            cfgLink.innerHTML = GEAR_ICON + '打开提示词增强设置';
            cfgLink.addEventListener("click", openEnhanceModal);
            container.appendChild(cfgLink);
        }
    });
})();
