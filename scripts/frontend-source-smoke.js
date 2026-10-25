#!/usr/bin/env node
/** 在真实已补丁资源上执行发送门槛表达式；未知结构不能当通过。 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { parse } = require("acorn");
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}
function verifyFrontendSource(assets) {
  const files = fs.readdirSync(assets).filter(name => name.endsWith(".js"));
  const markers = ["const __codexQuotaThreadProvider=", "codex-rebuild-local-accent-presets:theme",
    "Codex：API-key 首页使用官方记录器。", "CodexRebuildThreadTimeline", "CodexRebuildMcpStatusRefresh",
    "CodexRebuildRemoteControlAuthIsolation", "CodexRebuildRemoteControlGateAuthIsolation",
    "CodexRebuildServiceTierApiKeyRequest", "CodexRebuildSidebarUsage"];
  const markedSources = new Map();
  for (const name of files) {
    const text = fs.readFileSync(path.join(assets, name), "utf8");
    if (markers.some(marker => text.includes(marker))) markedSources.set(name, text);
  }
  const markedSource = marker => {
    const matches = [...markedSources.values()].filter(source => source.includes(marker));
    assert.equal(matches.length, 1, `补丁标记必须唯一：${marker}`);
    return matches[0];
  };
  // 编译器会移动组件；实际补丁标记和后续契约检查共同定位，不绑定 chunk 名称。
  const source = markedSource("const __codexQuotaThreadProvider="), ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  let guard, disabled, config, scope, quota = [], loading;
  walk(ast, node => {
    if (node.type === "VariableDeclaration" && node.declarations.some(d => d.id.name === "__codexUsesCustomProvider")) guard = node;
    if (node.type === "VariableDeclarator" && node.init?.type === "LogicalExpression" && source.slice(node.init.start, node.init.end).includes("!__codexUsesCustomProvider")) disabled = node;
  });
  assert.ok(guard && disabled);
  walk(guard, node => {
    if (node.type === "MemberExpression" && node.property.name === "isConfigDataPending") config = node.object.name;
    if (node.type === "MemberExpression" && node.property.name === "kind") scope = node.object.object.name;
  });
  const names = new Set();
  walk(disabled.init, node => {
    if (node.type === "Identifier") names.add(node.name);
    if (node.type === "LogicalExpression" && node.left?.type === "UnaryExpression" && node.left.argument.name === "__codexUsesCustomProvider") quota.push(node.right.name);
    if (node.type === "MemberExpression" && node.property.name === "isLoading") loading = node.object.name;
  });
  assert.equal(quota.length, 2); assert.ok(config && scope && loading);
  const lookup = guard.declarations[0].init;
  // 新 Composer 通过导出初始化器读取跨模块会话 atom；执行生成表达式，保留初始化调用。
  const providerRead = lookup.type === "SequenceExpression" ? lookup.expressions.at(-1) : lookup;
  assert.equal(providerRead.type, "CallExpression");
  assert.equal(providerRead.callee.type, "Identifier");
  assert.equal(providerRead.arguments.length, 2);
  const providerInitializers = lookup.type === "SequenceExpression" ? lookup.expressions.slice(0, -1) : [];
  for (const initializer of providerInitializers) {
    assert.equal(initializer.type, "CallExpression");
    assert.equal(initializer.callee.type, "Identifier");
    assert.equal(initializer.arguments.length, 0);
  }
  const external = { base_url: "https://provider.example/v1", requires_openai_auth: true };
  const scenarios = [
    { name: "第三方服务不受官方额度禁发", provider: "local", endpoint: external, expected: false },
    { name: "保存的官方任务不跟随全局第三方", saved: "openai", provider: "local", endpoint: external, expected: true },
    { name: "保存的第三方任务优先", saved: "local", provider: "openai", endpoint: external, expected: false },
    { name: "官方保留额度限制", provider: "openai", endpoint: external, expected: true },
    { name: "第三方无端点仍受保护", provider: "local", endpoint: {}, expected: true },
    { name: "ChatGPT 端点仍受保护", provider: "local", endpoint: { base_url: "https://chatgpt.com/backend-api/codex" }, expected: true },
    { name: "ChatGPT 子域仍受保护", provider: "local", endpoint: { base_url: "https://api.chatgpt.com./" }, expected: true },
    { name: "非法端点保留限制", provider: "local", endpoint: { base_url: "file:///tmp" }, expected: true },
    { name: "配置未就绪保留限制", provider: "local", endpoint: external, pending: true, expected: true },
    { name: "云任务不绕过", provider: "local", endpoint: external, kind: "cloud", expected: true },
    { name: "新建本地允许第三方", provider: "local", endpoint: external, kind: "new", expected: false },
    { name: "新建云原型不绕过", provider: "local", endpoint: external, kind: "new", cloud: true, expected: true },
    { name: "第三方真实加载错误仍阻止发送", provider: "local", endpoint: external, loading: true, expected: true },
  ];
  const results = [];
  for (const scenario of scenarios) {
    const context = Object.fromEntries([...names].map(name => [name, false]));
    let initialized = providerInitializers.length === 0;
    for (const initializer of providerInitializers) context[initializer.callee.name] = () => { initialized = true; };
    Object.assign(context, { URL, [config]: { isConfigDataPending: !!scenario.pending, resolvedConfig: { model_provider: scenario.provider, model_providers: { local: scenario.endpoint } } },
      [scope]: { value: { kind: scenario.kind || "local", cloudThreadPrototype: scenario.cloud } }, [loading]: { isLoading: !!scenario.loading },
      [providerRead.callee.name]: () => { assert.ok(initialized, "会话 Provider atom 必须先初始化"); return scenario.saved; },
      [providerRead.arguments[0].name]: null, [providerRead.arguments[1].name]: "fixture-thread" });
    for (const name of quota) context[name] = true;
    const actual = vm.runInNewContext(source.slice(guard.start, guard.end) + `\nBoolean(${source.slice(disabled.init.start, disabled.init.end)})`, context, { timeout: 1000 });
    assert.equal(actual, scenario.expected, scenario.name); results.push(scenario.name);
  }
  const settings = files.filter(name => /^general-settings-/.test(name)
    && fs.readFileSync(path.join(assets, name), "utf8").includes("settings.appearance.visualStyle")); assert.equal(settings.length, 1);
  const settingsSource = fs.readFileSync(path.join(assets, settings[0]), "utf8");
  assert.match(settingsSource, /jsx\)\(__CodexRebuildReadingWidth/);
  assert.match(settingsSource, /codex-rebuild-reading-width:visual-card/);
  assert.match(settingsSource, /codex-rebuild-local-accent-presets:settings/);
  assert.match(settingsSource, /codex-rebuild-accent-presets\.js/);
  assert.match(settingsSource, /__codexSelectAccentPreset/);
  const themeSource = markedSource("codex-rebuild-local-accent-presets:theme");
  assert.match(themeSource, /__codexResolveAccentPreset/);
  assert.match(themeSource, /accentSource:`chatgpt`/);
  const navigationSource = markedSource("Codex：API-key 首页使用官方记录器。");
  const recorder = /\/\* Codex：API-key 首页使用官方记录器。 \*\/if\([A-Za-z_$][\w$]*===`apikey`\)\{([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,\{accountKey:`auth:apikey`,auth:[A-Za-z_$][\w$]*,location:[A-Za-z_$][\w$]*,productMode:[A-Za-z_$][\w$]*\}\);return;\}/.exec(navigationSource);
  assert.ok(recorder, "API-key 首页必须调用结构完整的官方记录器");
  // 校验实际调用契约，不绑定压缩函数名；仍要求与原生五字段调用共用唯一记录器。
  const navigationAst = parse(navigationSource, { ecmaVersion: "latest", sourceType: "module" });
  let recorderDefinitions = 0, officialRecorderCalls = 0;
  walk(navigationAst, node => {
    if (node.type === "FunctionDeclaration" && node.id?.name === recorder[1]) recorderDefinitions++;
    if (node.type !== "CallExpression" || node.callee?.name !== recorder[1] ||
        node.arguments.length !== 2 || node.arguments[0]?.type !== "Identifier" ||
        node.arguments[1]?.type !== "ObjectExpression") return;
    const properties = node.arguments[1].properties;
    if (properties.length === 5 && ["accountKey", "auth", "location", "productMode", "destinationId"]
      .every(name => properties.filter(property => property.key?.name === name &&
        property.value?.type === "Identifier").length === 1)) officialRecorderCalls++;
  });
  assert.equal(recorderDefinitions, 1, "官方首页记录器定义必须唯一");
  assert.equal(officialRecorderCalls, 1, "官方首页五字段记录调用必须唯一");
  assert.doesNotMatch(navigationSource, /Codex：API-key 首页记录真实会话。/);
  assert.match(navigationSource,
    /\([A-Za-z_$][\w$]*\|\|\/\* Codex：API-key 首页保持当前位置。 \*\/[A-Za-z_$][\w$]*===`auth:apikey`&&[A-Za-z_$][\w$]*===`home`\)&&[A-Za-z_$][\w$]*!=null/);
  assert.match(navigationSource,
    /&&\([A-Za-z_$][\w$]*\([^)]*\)===[A-Za-z_$][\w$]*\|\|\/\* Codex：API-key 首页保持当前。 \*\/[A-Za-z_$][\w$]*\.state\?\.sidebarThreadLocationId!=null\)/);
  assert.match(navigationSource,
    /\(\s*[A-Za-z_$][\w$]*\|\|\/\* Codex：API-key 首页从其他页面恢复会话。 \*\/[A-Za-z_$][\w$]*===`auth:apikey`&&[A-Za-z_$][\w$]*===`home`\s*\)\?/);
  assert.doesNotMatch(navigationSource, /Codex：API-key 当前首页保持会话/);
  assert.doesNotMatch(navigationSource, /Codex：API-key 首页保持状态会话/);
  assert.doesNotMatch(navigationSource, /Codex：API-key 首页恢复最近会话/);
  assert.doesNotMatch(navigationSource, /Codex：API-key 首页恢复写入/);
  assert.doesNotMatch(navigationSource, /authMethod:__codexAuthMethod/);
  const timelineSource = markedSource("CodexRebuildThreadTimeline");
  assert.match(timelineSource,
    /supportsThreadTimeline\(\)\{return\s*[A-Za-z_$][\w$]*\(this\.hostId,this\.requestClient\.getAppServerVersion\(\)\)\/\* CodexRebuildThreadTimeline \*\//);
  const mcpRefreshSource = markedSource("CodexRebuildMcpStatusRefresh");
  assert.match(mcpRefreshSource, /toolsAndAuthOnly/);
  assert.match(mcpRefreshSource, /mention-discovery/);
  assert.match(mcpRefreshSource, /refetchType:`none`/);
  assert.match(mcpRefreshSource, /===`full`/);
  assert.match(mcpRefreshSource, /CodexRebuildMcpStatusRefresh \*\/\)\},250\)/);
  const remoteControlSource = markedSource("CodexRebuildRemoteControlAuthIsolation");
  const remoteGateSource = markedSource("CodexRebuildRemoteControlGateAuthIsolation");
  assert.match(remoteControlSource, /__codexRemoteAccount\?\.authMethod!==`chatgpt`/);
  // 新版官方目录 atom 为只读派生值；旧版仍需清理可写存储，二者均校验认证隔离。
  assert.equal(require("./patch-remote-control").patchSource(remoteControlSource).status, "already-patched");
  if (!remoteControlSource.includes("CodexRebuildRemoteControlCatalog")) {
    assert.match(remoteControlSource, /__codexSetRemoteEnabled\(!1\)/);
  }
  assert.match(remoteGateSource, /__codexRemoteGateAccount\?\.authMethod===`chatgpt`/);
  assert.match(remoteGateSource, /__codexRemoteGateAccount\?\.authLoading/);
  assert.doesNotMatch(remoteControlSource, /codex-remote-gate:/);
  assert.doesNotMatch(remoteGateSource, /codex-remote-gate:/);
  const serviceTierSource = markedSource("CodexRebuildServiceTierApiKeyRequest");
  assert.match(serviceTierSource, /CodexRebuildServiceTierApiKeyAuth/);
  assert.match(serviceTierSource, /CodexRebuildServiceTierApiKeyAccess/);
  assert.match(serviceTierSource, /\{fast:!0,ultrafast:!0\}\/\* CodexRebuildServiceTierApiKeyRequest \*\//);
  const accentModule = fs.readFileSync(path.join(assets, "codex-rebuild-accent-presets.js"), "utf8");
  assert.match(accentModule, /codex-rebuild:accent-preset:v1/);
  assert.match(accentModule, /export function resolveAccentPreset/);
  assert.match(accentModule, /preset == null \|\| preset === "default" \? "blue" : preset/);
  assert.match(accentModule, /CUSTOM_ACCENT_PRESET = "custom"/);
  assert.doesNotMatch(accentModule, /getComputedStyle|#[0-9a-f]{6}/i);
  const readingModule = fs.readFileSync(path.join(assets, "codex-rebuild-reading-width.js"), "utf8");
  assert.match(readingModule, /MIN_WIDTH_PERCENT = 50/);
  assert.match(readingModule, /MAX_WIDTH_PERCENT = 100/);
  assert.match(readingModule, /WIDTH_STEP = 5/);
  assert.match(readingModule, /type: "range"/);
  assert.match(readingModule, /codex-rebuild:markdown-bold-color-mode:v1/);
  assert.match(readingModule, /--app-color-text-accent/);
  assert.doesNotMatch(readingModule, /--color-token-charts-green|--green-500|#00a240/);
  assert.doesNotMatch(readingModule, /设置无效|请重新选择/);
  const shared = files.filter(name => /^app-shared-/.test(name) && fs.readFileSync(path.join(assets, name), "utf8").includes("codex-rebuild-dialog-default"));
  assert.equal(shared.length, 1);
  const dialogs = fs.readFileSync(path.join(assets, shared[0]), "utf8");
  const inviteMenus = files.filter(name => /^profile-dropdown-items-.*\.js$/.test(name));
  assert.equal(inviteMenus.length, 1);
  assert.equal(require("./patch-hide-invite-menu").patchSource(
    fs.readFileSync(path.join(assets, inviteMenus[0]), "utf8")).status, "already-patched");
  const usagePatch = require("./patch-sidebar-usage");
  const usageDependencies = files.filter(name => /^app-initial-.*\.js$/.test(name))
    .map(name => ({ name, source: fs.readFileSync(path.join(assets, name), "utf8") }));
  assert.equal(usagePatch.patchSource(markedSource("CodexRebuildSidebarUsage"), {
    relatedSources: usageDependencies,
  }).status, "already-patched");
  assert.equal(fs.readFileSync(path.join(assets, usagePatch.MODULE), "utf8"),
    fs.readFileSync(path.join(__dirname, "runtime", "sidebar-usage.mjs"), "utf8"));
  assert.match(dialogs, /codex-rebuild-dialog-editor h-\[720px\] max-w-full max-h-full/);
  return { passed: true, quotaScenarios: results, apiKeyHomeNavigation: true, threadTimelineEnabled: true, mcpStatusRefreshGoverned: true, remoteControlAuthIsolated: true, apiKeyServiceTiers: true, nativeAppearanceRow: true, nativeAccentThemePipeline: true, dialogHeightPreserved: true };
}
if (require.main === module) console.log(JSON.stringify(verifyFrontendSource(path.resolve(process.argv[2] || "src/win/_asar/webview/assets")), null, 2));
module.exports = { verifyFrontendSource };
