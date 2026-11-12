#!/usr/bin/env node
/** 在 26.1106 Rspack 模块工厂上执行已生成补丁；复用既有 sidebar/reading 验证入口。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { parse } = require("acorn");
const { nodes, unique } = require("./patch-ast-util");
const {
  frontendFiles,
  rspackModules,
  moduleImports,
  moduleExports,
  findModuleCopies,
  findFrontendModules,
} = require("./rspack-util");

const quota = require("./patch-provider-quota");
const home = require("./patch-api-key-home-navigation");
const timeline = require("./patch-thread-timeline");
const mcp = require("./patch-mcp-status-refresh");
const accent = require("./patch-accent-presets");
const fast = require("./patch-fast-mode");
const pet = require("./patch-hide-pet-menu");
const invite = require("./patch-hide-invite-menu");
const sidebar = require("./patch-sidebar-usage");
const reading = require("./patch-reading-layout");
const remote = require("./patch-remote-control");

const TOKENS = [
  "__codexQuotaThreadProvider", "modelProvider||null", "Codex：API-key",
  "CodexRebuildThreadTimeline", "CodexRebuildMcpStatusRefresh",
  "CodexRebuildServiceTierApiKey", "codex-rebuild-local-accent-presets",
  "codex-rebuild-hide-pet-menu", "codex-rebuild-hide-invite-menu",
  "CodexRebuildSidebarUsage", "CodexRebuildRemoteControl",
  "accountId:null,accountLoading:!0,", "codex-rebuild-reading-width",
  "codex-rebuild-dialog-default", "codex.profileFooter.settingsFallback",
  "chatgptAccentPicker.ChatGptAccentPicker.updateError",
  "--color-background-user-message", "settings.appearance.visualStyle",
  "supportsThreadTimeline", "Failed to read service tier for request",
];

const property = node => {
  if (!["MemberExpression", "MethodDefinition", "Property"].includes(node?.type)) return null;
  const part = node.type === "MemberExpression" ? node.property : node.key;
  if (!node.computed && part?.type === "Identifier") return part.name;
  return part?.type === "Literal" ? part.value : null;
};
const props = node => Object.fromEntries((node?.properties ?? [])
  .filter(item => property(item)).map(item => [property(item), item.value]));
const text = (source, node) => source.slice(node.start, node.end);
const has = (source, node, value) => text(source, node).includes(value);
const sameText = (left, right) => left.replace(/\r\n/g, "\n") === right.replace(/\r\n/g, "\n");

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function smallest(source, types, position) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  return nodes(ast, node => types.includes(node.type) &&
    node.start <= position && node.end >= position)
    .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
}

function moduleIndex(assets) {
  const modules = [];
  for (const file of frontendFiles(assets)) {
    const chunkSource = fs.readFileSync(file, "utf8");
    if (!chunkSource.includes("export const __webpack_modules__=") ||
        !TOKENS.some(token => chunkSource.includes(token))) continue;
    for (const module of rspackModules(chunkSource)) modules.push({ ...module, file });
  }
  const copies = (marker, label) => {
    const found = modules.filter(module => module.source.includes(marker));
    assert.ok(found.length, `${label}必须存在`);
    return found;
  };
  return {
    assets, modules, copies,
    one(marker, label) { return unique(modules.filter(module => module.source.includes(marker)), label); },
  };
}

function verifyQuota(index, target, metadata) {
  const source = quota.patchRspackComposer(target.source, {
    providerModule: metadata.module.id,
    providerExport: metadata.exported,
    imports: moduleImports(target),
  });
  assert.equal(source, target.source, "额度 Composer 必须已是完整补丁");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const composer = unique(ast.body.filter(node => node.type === "FunctionDeclaration" &&
    has(source, node, quota.MARKER)), "Rspack quota composer");
  const guardStatement = unique(composer.body.body.filter(statement =>
    statement.type === "VariableDeclaration" &&
    statement.declarations.some(declaration => declaration.id.name === "__codexUsesCustomProvider")),
  "Rspack quota guard");
  const providerRead = guardStatement.declarations.find(declaration =>
    declaration.id.name === "__codexQuotaThreadProvider").init;
  const reasonStatement = unique(composer.body.body.filter(statement =>
    statement.type === "VariableDeclaration" &&
    ["reserve-limit", "usage-limit"].every(reason => has(source, statement, reason)) &&
    has(source, statement, "caller-disabled")), "Rspack quota reasons");
  const quotaReasons = reasonStatement.declarations.filter(declaration =>
    has(source, declaration, "reserve-limit") || has(source, declaration, "usage-limit"));
  assert.equal(quotaReasons.length, 2, "必须保留两条额度原因");
  const reasonNames = quotaReasons.map(reason => reason.id.name);
  const reasonList = unique(nodes(composer, node => node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" && property(node.callee) === "filter" &&
    reasonNames.every(name => has(source, node.callee.object, name))),
  "Rspack quota reason list");
  const config = unique([...new Set(nodes(guardStatement, node =>
    node.type === "MemberExpression" && property(node) === "isConfigDataPending")
    .map(node => node.object.name).filter(Boolean))], "Rspack quota config");
  const scope = unique([...new Set(nodes(guardStatement, node =>
    node.type === "MemberExpression" && property(node) === "kind")
    .map(node => node.object?.object?.name).filter(Boolean))], "Rspack quota scope");
  const loadingDeclaration = unique(reasonStatement.declarations.filter(declaration =>
    declaration.init && has(source, declaration, "service-tier-loading") &&
    has(source, declaration, "isLoading")), "Rspack service-tier loading");
  const loading = unique([...new Set(nodes(loadingDeclaration.init, node =>
    node.type === "MemberExpression" && property(node) === "isLoading")
    .map(node => node.object?.name).filter(Boolean))], "Rspack service-tier loading source");
  const providerMember = providerRead.callee.type === "SequenceExpression"
    ? providerRead.callee.expressions.at(-1) : providerRead.callee;
  assert.equal(providerMember.type, "MemberExpression");
  const providerRoot = providerMember.object.name;
  const providerReadName = property(providerMember);
  const atomRoots = new Set(nodes(providerRead, node => node.type === "MemberExpression")
    .map(node => node.object?.name).filter(name => name && name !== providerRoot));
  const names = new Set();
  for (const root of [guardStatement, reasonStatement, reasonList]) walk(root, node => {
    if (node.type === "Identifier") names.add(node.name);
  });
  const scenarios = [
    ["第三方服务不受官方额度禁发", "local", "https://provider.example/v1", {}, false],
    ["保存的官方任务不跟随全局第三方", "local", "https://provider.example/v1", { saved: "openai" }, true],
    ["保存的第三方任务优先", "openai", "https://provider.example/v1", { saved: "local" }, false],
    ["官方保留额度限制", "openai", "https://provider.example/v1", {}, true],
    ["第三方无端点仍受保护", "local", null, {}, true],
    ["ChatGPT 端点仍受保护", "local", "https://chatgpt.com/backend-api/codex", {}, true],
    ["ChatGPT 子域仍受保护", "local", "https://api.chatgpt.com./", {}, true],
    ["非法端点保留限制", "local", "file:///tmp", {}, true],
    ["配置未就绪保留限制", "local", "https://provider.example/v1", { pending: true }, true],
    ["云任务不绕过", "local", "https://provider.example/v1", { kind: "cloud" }, true],
    ["新建本地允许第三方", "local", "https://provider.example/v1", { kind: "new" }, false],
    ["新建云原型不绕过", "local", "https://provider.example/v1", { kind: "new", cloud: true }, true],
    ["第三方真实加载错误仍阻止发送", "local", "https://provider.example/v1", { loading: true }, true],
  ];
  for (const [name, provider, endpoint, extra, expected] of scenarios) {
    const context = Object.fromEntries([...names].map(item => [item, false]));
    Object.assign(context, {
      URL, Boolean,
      [providerRoot]: { [providerReadName]: () => extra.saved ?? null },
      [config]: {
        isConfigDataPending: !!extra.pending,
        resolvedConfig: {
          model_provider: provider,
          model_providers: { local: { base_url: endpoint, requires_openai_auth: true } },
        },
      },
      [scope]: { value: { kind: extra.kind ?? "local", cloudThreadPrototype: !!extra.cloud } },
      [loading]: { isLoading: !!extra.loading },
    });
    for (const root of atomRoots) context[root] = new Proxy({}, {
      get(_target, key) { return key === "then" ? undefined : { atom: String(key) }; },
    });
    for (const reason of quotaReasons) {
      const flag = nodes(reason.init, node => node.type === "Identifier" &&
        node.name !== "__codexUsesCustomProvider")[0];
      assert.ok(flag, `${target.id}: 额度原因标志必须可执行`);
      context[flag.name] = true;
    }
    const actual = vm.runInNewContext(
      `${text(source, guardStatement)}\n${text(source, reasonStatement)}\n`
      + `Boolean((${text(source, reasonList)}).length)`, context, { timeout: 1000 });
    assert.equal(actual, expected, `${target.id}: ${name}`);
  }
  return true;
}

function verifyHomeRecorder(index, target) {
  assert.equal(home.patchRspackNavigation(target.source, "tracker").status, "already-patched");
  const source = target.source, position = source.indexOf(home.MARKER);
  const owner = smallest(source, ["FunctionDeclaration"], position);
  assert.ok(owner, "首页记录器宿主必须存在");
  const official = unique(nodes(owner, node => node.type === "CallExpression" &&
    node.arguments[1]?.type === "ObjectExpression" &&
    node.arguments[1].properties.length === 5 &&
    ["accountKey", "auth", "location", "productMode", "destinationId"]
      .every(name => props(node.arguments[1])[name])), "官方首页五字段记录调用");
  const apiKey = unique(nodes(owner, node => node.type === "CallExpression" &&
    node.arguments[1]?.type === "ObjectExpression" &&
    node.arguments[1].properties.length === 4 &&
    ["accountKey", "auth", "location", "productMode"]
      .every(name => props(node.arguments[1])[name])), "API-key 首页记录调用");
  assert.match(text(source, apiKey), /auth:apikey/);
  const recorder = official.callee.type === "SequenceExpression"
    ? official.callee.expressions.at(-1) : official.callee;
  const dependency = unique(moduleImports(target).filter(item => item.local === recorder.object.name));
  const indexed = index.modules.filter(item => item.id === dependency.id);
  const module = unique(indexed.length ? indexed : findModuleCopies(index.assets, dependency.id),
    "记录器模块");
  const exported = unique(moduleExports(module).filter(item =>
    item.exported === property(recorder)), "记录器导出");
  const moduleAst = parse(module.source, {
    ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true,
  });
  assert.equal(nodes(moduleAst, node => node.type === "FunctionDeclaration" &&
    node.id?.name === exported.value).length, 1, "官方首页记录器定义必须唯一");
  const callback = nodes(owner, node => node.type === "ArrowFunctionExpression" &&
    node.start <= position && node.end >= position)
    .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
  const ifStatement = callback && unique(nodes(callback, node => node.type === "IfStatement"),
    "首页 API-key 记录条件");
  assert.ok(callback && ifStatement, "首页记录回调必须可执行");
  const values = props(apiKey.arguments[1]), calls = [];
  const context = vm.createContext({
    [recorder.object.name]: { [property(recorder)]: (store, options) => calls.push({ store, options }) },
    [ifStatement.test.left.name]: "apikey",
    [values.auth.name]: { authMethod: "apikey" },
    [apiKey.arguments[0].name]: {},
    [values.location.name]: { pathname: "/thread" },
    [values.productMode.name]: "codex",
  });
  vm.runInContext(`(${text(source, callback)})();`, context);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].options),
    ["accountKey", "auth", "location", "productMode"]);
  return true;
}

function verifyHomeRestore(target) {
  const result = home.patchRspackNavigation(target.source, "restore");
  assert.equal(result.status, "already-patched");
  const markers = [home.HOME_CURRENT_MARKER, home.HOME_STATE_MARKER, home.HOME_RESTORE_MARKER];
  assert.ok(markers.every(marker => target.source.includes(marker)), "三项首页恢复条件必须存在");
  assert.match(target.source, /auth:apikey/);
  assert.match(target.source, /sidebarThreadLocationId!=null/);
  return true;
}

function verifyTimeline(target) {
  const result = timeline.patchSource(target.source);
  assert.equal(result.status, "already-patched");
  const ast = parse(result.source, { ecmaVersion: "latest", sourceType: "module" });
  const method = nodes(ast, node => node.type === "MethodDefinition" &&
    property(node) === "supportsThreadTimeline" &&
    has(result.source, node, timeline.MARKER))[0];
  assert.ok(method);
  const returned = method.value.body.body[0].argument;
  let version;
  const callee = returned.callee.type === "SequenceExpression"
    ? returned.callee.expressions.at(-1) : returned.callee;
  const versionCheck = (_host, value) => value === "supported";
  const context = vm.createContext(callee.type === "MemberExpression"
    ? { [callee.object.name]: { [property(callee)]: versionCheck } }
    : { [callee.name]: versionCheck });
  vm.runInContext(`class X{${text(result.source, method)}};globalThis.X=X`, context);
  const value = new context.X();
  value.hostId = {};
  value.requestClient = { getAppServerVersion: () => version };
  version = "supported"; assert.equal(value.supportsThreadTimeline(), true);
  version = "old"; assert.equal(value.supportsThreadTimeline(), false);
  return true;
}

function verifyMcp(target) {
  const result = mcp.patchRspackSource(target.source);
  assert.equal(result.status, "already-patched");
  const source = result.source, ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const branch = nodes(ast, node => node.type === "SwitchCase" && has(source, node, mcp.MARKER))[0];
  assert.ok(branch);
  const listener = nodes(ast, node => ["ArrowFunctionExpression", "FunctionExpression"].includes(node.type) &&
    node.start < branch.start && node.end > branch.end)
    .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
  const branchText = text(source, branch);
  const readiness = /\b([A-Za-z_$][\w$]*)&&\(([A-Za-z_$][\w$]*)\?\.\(\)\?\?!0\)/.exec(branchText);
  const inventory = /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*);\2=!1/.exec(branchText);
  const helper = /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)/.exec(branchText);
  const threadSet = /([A-Za-z_$][\w$]*)\.add\(/.exec(branchText)?.[1];
  const helperImport = /\(0,([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\)\(n\.params\.name\)/
    .exec(branchText);
  const inventoryState = /([A-Za-z_$][\w$]*)=\1\|\|/.exec(branchText)?.[1];
  const readyTimer = /([A-Za-z_$][\w$]*)\?\?=setTimeout/.exec(branchText)?.[1];
  const threadTimer = /null==([A-Za-z_$][\w$]*)&&\([A-Za-z_$][\w$]*=setTimeout/
    .exec(branchText)?.[1];
  const refresh = /\(0,([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\)\(([A-Za-z_$][\w$]*)\.queryClient,\{queryKey:\[\.\.\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),`toolsAndAuthOnly`\]/
    .exec(branchText);
  assert.ok(readiness && inventory && helper && threadSet && helperImport &&
    inventoryState && readyTimer && threadTimer && refresh);
  const calls = [], timers = [];
  const context = vm.createContext({
    [readiness[1]]: true, [inventory[2]]: false, [inventory[1]]: false,
    [helper[1]]: name => calls.push(["inventory", name]), [threadSet]: new Set(),
    [readiness[2]]: () => true, __codexMcpThreadReadyPending: false,
    [helperImport[1]]: { [helperImport[2]]: name => name },
    [refresh[4]]: { [refresh[5]]: ["mcp"] },
    [refresh[6]]: "host",
    [refresh[1]]: {
      [refresh[2]]: (_client, filters, options) => calls.push(["refresh", filters, options]),
    },
    [refresh[3]]: {
      queryClient: {
        invalidateQueries: options => calls.push(["invalidate", options]),
      },
    },
    [inventoryState]: undefined,
    [readyTimer]: undefined,
    [threadTimer]: undefined,
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
  });
  vm.runInContext(`globalThis.listener=(${text(source, listener)});`, context);
  const notify = (threadId, name = "plugin") => context.listener({
    method: "mcpServer/startupStatus/updated", params: { threadId, name, status: "ready" },
  });
  notify("thread-a"); notify(null);
  assert.equal(timers.filter(timer => timer.delay === 250).length, 1);
  assert.equal(timers.filter(timer => timer.delay === 0).length, 1);
  timers.find(timer => timer.delay === 250).callback();
  assert.equal(calls.filter(call => call[1]?.queryKey?.at(-1) === "toolsAndAuthOnly").length, 1);
  const full = calls.find(call => call[1]?.refetchType === "none")[1];
  assert.equal(full.predicate({ queryKey: ["mcp", "local", "full"] }), true);
  assert.equal(full.predicate({ queryKey: ["mcp", "local", "thread", "a", "full"] }), false);
  return true;
}

function moduleRequire(target, state) {
  const exports = {};
  const imports = moduleImports(target);
  const roles = new Map();
  const bindImport = (pattern, methods, label) => {
    const local = pattern.exec(target.source)?.[1];
    const imported = unique(imports.filter(item => item.local === local), label);
    const role = roles.get(imported.id) ?? {};
    Object.assign(role, methods);
    roles.set(imported.id, role);
  };
  bindImport(/\(0,([A-Za-z_$][\w$]*)\.c\)\(/, {
    c: () => state.cache,
  }, "Fast settings cache import");
  bindImport(/\(0,([A-Za-z_$][\w$]*)\.Ul\)\(/, {
    Ul: () => state.host,
  }, "Fast settings host import");
  bindImport(/\(0,([A-Za-z_$][\w$]*)\._U\)\(/, {
    _U: () => ({ data: state.data, isPending: state.pending }),
  }, "Fast settings query import");
  bindImport(/\(0,([A-Za-z_$][\w$]*)\.W6\)\(/, {
    W6: value => value.access,
  }, "Fast settings access import");
  bindImport(/\(0,([A-Za-z_$][\w$]*)\.tn\)\(/, {
    tn: () => state.auth,
  }, "Fast settings auth import");
  bindImport(/([A-Za-z_$][\w$]*)\.Dc\)/, {
    Dc: "host",
  }, "Fast settings host id import");
  bindImport(/([A-Za-z_$][\w$]*)\.b9\b/, {
    b9: "query",
  }, "Fast settings query key import");
  const namespace = id => new Proxy({}, {
    get(_target, name) {
      if (name === "then") return undefined;
      return roles.get(id)?.[name];
    },
  });
  const root = new Proxy(function require() {}, {
    get(_target, name) {
      if (name === "then") return undefined;
      if (name === "d") return (value, _first, second) => Object.assign(value, second ?? _first);
      return undefined;
    },
    apply(_target, _thisArg, [id]) { return namespace(String(id)); },
  });
  vm.runInContext(target.source, vm.createContext({
    [target.requireName]: root, [target.exportsName]: exports,
  }));
  return exports;
}

function verifyFastSettings(target) {
  const result = fast.patchRspackSource(target.source, "settings");
  assert.equal(result.status, "already-patched");
  const state = {};
  const exports = moduleRequire(target, state);
  const useAccess = Object.values(exports).find(value => typeof value === "function");
  const run = (auth, pending) => {
    Object.assign(state, {
      auth, pending, cache: Array(12).fill(Symbol()), host: {},
      data: { access: { fast: false, ultrafast: true } },
    });
    return useAccess({});
  };
  assert.deepEqual(JSON.parse(JSON.stringify(run({ authMethod: "apikey" }, true))), {
    serviceTierAccess: { fast: true, ultrafast: true }, isLoading: false,
  });
  assert.equal(run({ authMethod: "chatgpt" }, true).serviceTierAccess, null);
  assert.deepEqual(JSON.parse(JSON.stringify(run({ authMethod: "chatgpt" }, false).serviceTierAccess)),
    { fast: false, ultrafast: true });
  return true;
}

async function verifyFastRequest(target) {
  const source = fast.patchRspackSource(target.source, "request").source;
  const exported = moduleExports({ ...target, source })[0];
  const imports = moduleImports(target);
  const requestFunction = parse(`(${exported.value})`, { ecmaVersion: "latest" })
    .body[0].expression;
  const [requestContext, requestHost] = requestFunction.params.map(param => param.name);
  assert.ok(requestContext && requestHost, "Fast 请求函数参数结构未知");
  let authMethod, requirements = 0;
  const roles = new Map();
  const bindImport = (pattern, methods, label) => {
    const local = pattern.exec(source)?.[1];
    const imported = unique(imports.filter(item => item.local === local), label);
    const role = roles.get(imported.id) ?? {};
    Object.assign(role, methods);
    roles.set(imported.id, role);
  };
  bindImport(new RegExp(`\\(0,([A-Za-z_$][\\w$]*)\\.s\\)\\(${requestContext},${requestHost}\\)`), {
    s: async () => authMethod,
  }, "service tier auth import");
  bindImport(new RegExp(`\\(0,([A-Za-z_$][\\w$]*)\\.Wr\\)\\(${requestContext},${requestHost},\\{`), {
    Wr: async () => {
      requirements++;
      return { access: { fast: false, ultrafast: false } };
    },
  }, "service tier requirements import");
  bindImport(/\(0,([A-Za-z_$][\w$]*)\.W6\)\([A-Za-z_$][\w$]*\)/, {
    W6: value => value.access,
  }, "service tier access import");
  bindImport(/\(0,([A-Za-z_$][\w$]*)\.E_\)\(/, {
    E_: (...args) => args.at(-1),
  }, "service tier result import");
  bindImport(/\(0,([A-Za-z_$][\w$]*)\.qh\)\(/, {
    qh: (_value, fallback) => fallback,
  }, "service tier config import");
  bindImport(/\(0,([A-Za-z_$][\w$]*)\.ig\)\(/, {
    ig: async () => ({ config: {} }),
  }, "service tier config loader import");
  bindImport(/\(0,([A-Za-z_$][\w$]*)\.Y\$\)\(/, {
    Y$: () => ({ service_tier: {}, model: "fixture" }),
  }, "service tier model config import");
  bindImport(/return ([A-Za-z_$][\w$]*)\.v\.error/, {
    v: { error() {} },
  }, "service tier logger import");
  const namespace = id => new Proxy({}, {
    get(_target, name) {
      if (name === "then") return undefined;
      return roles.get(id)?.[name];
    },
  });
  const root = new Proxy(function require() {}, {
    get(_target, name) {
      if (name === "then") return undefined;
      if (name === "d") return (value, _first, second) => Object.assign(value, second ?? _first);
      return undefined;
    },
    apply(_target, _thisArg, [id]) { return namespace(String(id)); },
  });
  const context = vm.createContext({ [target.requireName]: root, [target.exportsName]: {} });
  vm.runInContext(target.source, context);
  vm.runInContext(`globalThis.request=(${exported.value})`, context);
  const store = { query: { setData() {} }, get: () => ({ type: "fromConfig" }) };
  for (const method of ["apikey", "chatgpt", "personalAccessToken", "amazonBedrock", "copilot"]) {
    authMethod = method; requirements = 0;
    const value = await context.request(store, "local", "model", undefined);
    const expected = method === "apikey" ? { fast: true, ultrafast: true }
      : method === "copilot" ? null : { fast: false, ultrafast: false };
    assert.deepEqual(JSON.parse(JSON.stringify(value)), expected, method);
    assert.equal(requirements, ["chatgpt", "personalAccessToken", "amazonBedrock"].includes(method) ? 1 : 0);
  }
  return true;
}

function verifyAppearance(index, settingsTargets, themeTargets) {
  for (const target of settingsTargets) {
    assert.equal(accent.patchSettingsSource(target.source).status, "already-patched");
  }
  const runtime = fs.readFileSync(path.join(index.assets, accent.MODULE), "utf8");
  assert.ok(sameText(runtime, fs.readFileSync(path.join(__dirname, "runtime", "accent-presets.mjs"), "utf8")));
  for (const target of themeTargets) {
    const theme = accent.patchThemeSource(target.source);
    assert.equal(theme.status, "already-patched");
    const ast = parse(theme.source, { ecmaVersion: "latest", sourceType: "module" });
    const injected = unique(nodes(ast, node => node.type === "VariableDeclaration" &&
      node.declarations.some(item => item.id.name === "__codexAccentPreset")), "主题注入");
    const renderer = smallest(theme.source, ["FunctionDeclaration"], injected.start);
    const injectedIf = nodes(renderer, node => node.type === "IfStatement" &&
      has(theme.source, node, "__codexAccentPreset"))[0];
    assert.ok(injected && injectedIf && has(theme.source, injectedIf, "accentSource:`chatgpt`"));
  }
  const readingRuntime = fs.readFileSync(path.join(index.assets, "codex-rebuild-reading-width.js"), "utf8");
  assert.ok(sameText(readingRuntime,
    fs.readFileSync(path.join(__dirname, "runtime", "reading-width.mjs"), "utf8")));
  const settings = fs.readFileSync(path.join(index.assets, "codex-rebuild-reading-width.js"), "utf8");
  assert.match(settings, /MIN_WIDTH_PERCENT = 50/);
  assert.match(settings, /MAX_WIDTH_PERCENT = 100/);
  assert.match(settings, /WIDTH_STEP = 5/);
  assert.match(settings, /type: "range"/);
  return true;
}

function verifyReading(index, settingsTarget) {
  assert.equal(reading.patchSettings(settingsTarget.source), settingsTarget.source,
    "阅读宽度设置必须已是完整补丁");
  assert.match(settingsTarget.source, /jsx\)\(__CodexRebuildReadingWidth/);
  assert.match(settingsTarget.source, /codex-rebuild-reading-width:visual-card/);
  const entries = findFrontendModules(index.assets, {
    all: ["thread-content-responsive-max-width", "@max-thread-expanded/app-shell-main-content:"],
  });
  assert.ok(entries.length, "正文响应宽度入口模块必须存在");
  for (const target of entries) {
    assert.match(target.chunkSource, /import "\.\.\/codex-rebuild-reading-width\.js";/,
      `${target.file}: 正文入口必须加载阅读宽度 runtime`);
  }
  const dialogs = index.copies("codex-rebuild-dialog-default", "对话框尺寸");
  for (const target of dialogs) {
    assert.equal(reading.patchDialogs(target.source), target.source,
      "对话框尺寸必须已是完整补丁");
    assert.match(target.source, /codex-rebuild-dialog-editor/);
  }
  return true;
}

function verifyHidden(petTargets, inviteTargets) {
  assert.ok(petTargets.length && inviteTargets.length);
  for (const target of petTargets) {
    assert.equal(pet.patchSource(target.source).status, "already-patched");
    assert.equal(target.source.split(pet.MARKER).length - 1, 1);
    assert.match(target.source, /codex-rebuild-hide-pet-menu \*\/null/);
  }
  for (const target of inviteTargets) {
    assert.equal(invite.patchSource(target.source).status, "already-patched");
    assert.equal(target.source.split(invite.MARKER).length - 1, 1);
    assert.match(target.source, /codex-rebuild-hide-invite-menu \*\/null/);
  }
  return true;
}

function verifyRemote(index) {
  const accounts = index.modules.filter(module =>
    ["authenticatedAccountId", "authLoading", "supportedSurface", "hasChatGptToken"]
      .every(value => module.source.includes(value)) &&
    module.source.includes("accountId:null,accountLoading:!0,"));
  assert.ok(accounts.length, "Remote Control 当前账户模块必须存在");
  assert.equal(new Set(accounts.map(module => module.id)).size, 1);
  const auth = accounts[0], authAst = parse(auth.source, {
    ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true,
  });
  const atom = unique(nodes(authAst, node => node.type === "VariableDeclarator" &&
    node.init?.type === "CallExpression" &&
    ["accountLoading", "authLoading", "requiresAuth", "supportedSurface"]
      .every(value => has(auth.source, node.init, value))), "当前账户 Atom");
  const exported = unique(moduleExports(auth).filter(item => item.value === atom.id.name));
  const targets = index.modules.filter(module =>
    module.source.includes(remote.MARKER) &&
    module.source.includes("CodexRebuildRemoteControlGateAuthIsolation"));
  assert.ok(targets.length);
  for (const target of targets) assert.equal(remote.patchRspackSource(target.source, {
    requireName: target.requireName, authId: auth.id, authExport: exported.exported,
  }).status, "already-patched");
  return true;
}

function verifySidebarWithExistingSmoke(assets) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "sidebar-usage-smoke.js"), "--assets", assets,
  ], { encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function verifyRspackFrontend(assets) {
  const index = moduleIndex(path.resolve(assets));
  const metadata = quota.rspackProviderMetadata(index.assets);
  const quotaCopies = index.copies(quota.MARKER, "Provider quota");
  assert.ok(quotaCopies.length, "Provider Composer 必须存在");
  assert.equal(new Set(quotaCopies.map(target => target.id)).size, 1,
    "Provider Composer 副本必须来自同一原生模块");
  quotaCopies.forEach(target => verifyQuota(index, target, metadata));

  const trackers = index.copies(home.MARKER, "首页记录器");
  const restores = index.copies(home.HOME_CURRENT_MARKER, "首页恢复");
  trackers.forEach(target => verifyHomeRecorder(index, target));
  restores.forEach(verifyHomeRestore);
  index.copies(timeline.MARKER, "timeline").forEach(verifyTimeline);
  index.copies(mcp.MARKER, "MCP").forEach(verifyMcp);
  verifyRemote(index);

  const settingsCopies = index.copies(fast.SETTINGS_ACCESS_MARKER, "Fast 设置");
  const requestCopies = index.copies(fast.REQUEST_ACCESS_MARKER, "Fast 请求");
  assert.ok(settingsCopies.length && requestCopies.length, "Fast 设置和请求模块必须存在");
  assert.equal(new Set(settingsCopies.map(target => target.id)).size, 1,
    "Fast 设置副本必须来自同一原生模块");
  assert.equal(new Set(requestCopies.map(target => target.id)).size, 1,
    "Fast 请求副本必须来自同一原生模块");
  settingsCopies.forEach(verifyFastSettings);
  requestCopies.forEach(target => assert.equal(
    fast.patchRspackSource(target.source, "request").status, "already-patched"));

  const accentSettings = index.copies(accent.SETTINGS_MARKER, "强调色设置");
  const themes = index.copies(accent.THEME_MARKER, "强调色主题");
  verifyAppearance(index, accentSettings, themes);
  const readingSettings = unique(findFrontendModules(index.assets, {
    all: ["settings.appearance.visualStyle", "chatgptAccentPicker.ChatGptAccentPicker.updateError"],
  }), "外观设置");
  verifyReading(index, readingSettings);
  verifyHidden(index.copies(pet.MARKER, "Pet"), index.copies(invite.MARKER, "邀请"));

  return Promise.all(requestCopies.map(verifyFastRequest))
    .then(() => sidebar.findRspackSidebarTarget(index.assets))
    .then(target => {
      assert.ok(target.usageAtomExpression);
      const output = verifySidebarWithExistingSmoke(index.assets);
      return {
        passed: true,
        quotaScenarios: quotaCopies.length * 13,
        quotaCopies: quotaCopies.length,
        fastSettingsCopies: settingsCopies.length,
        fastRequestCopies: requestCopies.length,
        apiKeyHomeNavigation: true,
        threadTimelineEnabled: true,
        mcpStatusRefreshGoverned: true,
        remoteControlAuthIsolated: true,
        apiKeyServiceTiers: true,
        nativeAppearanceRow: true,
        nativeAccentThemePipeline: true,
        dialogHeightPreserved: true,
        sidebarUsage: output,
        sharedUsageAtom: target.usageAtomExpression,
      };
    });
}

if (require.main === module) {
  verifyRspackFrontend(path.resolve(process.argv[2] || "src/win/_asar/webview/assets"))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { moduleIndex, verifyRspackFrontend };
