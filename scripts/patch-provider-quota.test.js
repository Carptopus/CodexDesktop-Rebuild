const test = require("node:test");
const assert = require("node:assert/strict");

const { MARKER, getProviderMetadata, patchSource } = require("./patch-provider-quota");

function fixture() {
  return [
    "import{provider as threadProvider,quota as quotaAtom,hard as hardBlockAtom,host as hostAtom}from'./initial.js';",
    "function providerFor(store,id,config){return store.get(threadProvider,id)??config.model_provider}",
    "function Composer(props){",
    "let{submitDisabled:external}=props,scope=useScope(),conversation=currentConversation(),host=read(hostAtom,conversation),context;",
    "cacheMiss()?(context=conversation==null?null:{conversationId:conversation,hostId:host}):context=cached();",
    "let accountQuota=read(quotaAtom,context),config=useConfig(target),hardQuota=value(host===`local`&&hardBlockAtom);",
    "let disabled=external||accountQuota||config.isLoading||hardQuota;",
    "save(config.isConfigDataPending?null:config.resolvedConfig,scope.value.kind);",
    "return jsx(Editor,{submitDisabled:disabled})",
    "}",
  ].join("");
}

function legacyFixture() {
  return fixture().replace(
    "hardQuota=value(host===`local`&&hardBlockAtom)",
    "hardQuota=value(hardBlockAtom)&&host===`local`",
  );
}

test("按新版 Composer 数据流隔离第三方 Provider 的官方额度门槛", () => {
  const result = patchSource(fixture());

  assert.equal(result.status, "patched", result.reason);
  assert.ok(result.code.includes(MARKER));
  assert.match(result.code, /const __codexQuotaThreadProvider=read\(threadProvider,conversation\)/);
  assert.match(result.code, /\(!__codexUsesCustomProvider&&accountQuota\)/);
  assert.match(result.code, /\(!__codexUsesCustomProvider&&hardQuota\)/);
  assert.equal(patchSource(result.code).status, "already");
});

test("多个 Provider 读取仍要求指向同一个会话 Provider atom", () => {
  const source = fixture().replace(
    "function Composer(props){",
    "function another(get,id,config){return get(threadProvider,id)??config.model_provider}function Composer(props){",
  );

  assert.equal(getProviderMetadata(source).threadProviderAtom, "threadProvider");
  const result = patchSource(source);
  assert.equal(result.status, "patched", result.reason);
});

test("兼容 26.1007 的独立本地主机额度门槛", () => {
  const result = patchSource(legacyFixture());

  assert.equal(result.status, "patched", result.reason);
  assert.match(result.code, /\(!__codexUsesCustomProvider&&hardQuota\)/);
  assert.equal(patchSource(result.code).status, "already");
});

test("会话 Provider atom 不唯一时拒绝补丁", () => {
  const source = fixture().replace(
    "function Composer(props){",
    "function other(get,id,config){return get(otherProvider,id)??config.model_provider}function Composer(props){",
  );
  const result = patchSource(source);

  assert.equal(result.status, "error");
  assert.match(result.reason, /thread-provider lookup is ambiguous/);
});

test("拆分 Composer 只沿真实初始模块导出识别 Provider atom", () => {
  const source = fixture().replace(/import[^;]+;/,
    'import{quota as quotaAtom,hard as hardBlockAtom,host as hostAtom}from"./app-initial-fixture.js";')
    .replace("function providerFor(store,id,config){return store.get(threadProvider,id)??config.model_provider}", "");
  const dependency = "var atom;function init(){atom=cj(({summary:e})=>e.modelProvider||null)}function providerFor(get,id,config){return get(atom,id)??config.model_provider}export{atom as provider,init as initialize};";
  const options = { resolveModule: name => { assert.equal(name, "./app-initial-fixture.js"); return dependency; } };
  const result = patchSource(source, options);
  assert.equal(result.status, "patched", result.reason);
  assert.match(result.code, /provider as __codexQuotaThreadProviderAtom/);
  assert.match(result.code, /initialize as __codexQuotaThreadProviderInit/);
  assert.match(result.code, /__codexQuotaThreadProviderInit\(\),read\(__codexQuotaThreadProviderAtom,conversation\)/);
  assert.equal(patchSource(result.code, options).status, "already");
  assert.equal(patchSource(source).status, "error");
  assert.equal(patchSource(source, { resolveModule: () => dependency.replace("modelProvider", "otherProvider") }).status, "error");
  assert.equal(patchSource(source, { resolveModule: () => dependency.replace("atom as provider", "other as provider") }).status, "error");
});

test("实际生成的发送门槛只忽略明确第三方端点的官方额度", () => {
  const result = patchSource(fixture());
  assert.equal(result.status, "patched", result.reason);
  const { parse } = require("acorn");
  const composer = parse(result.code, { ecmaVersion: "latest", sourceType: "module" }).body
    .find(node => node.type === "FunctionDeclaration" && node.id.name === "Composer");
  const source = result.code.slice(composer.start, composer.end);
  const vm = require("node:vm");
  let state;
  const context = vm.createContext({
    URL, threadProvider: "provider", quotaAtom: "quota", hardBlockAtom: "hard", hostAtom: "host",
    target: {}, Editor: {}, cacheMiss: () => true, currentConversation: () => "thread-a",
    useScope: () => ({ value: state.scope ?? { kind: "local" } }),
    useConfig: () => ({ isLoading: false, isConfigDataPending: state.pending ?? false,
      resolvedConfig: { model_provider: "custom", model_providers: state.providers } }),
    read: atom => atom === "provider" ? state.threadProvider : atom === "host" ? "local" : true,
    value: () => true, save: () => {}, jsx: (_, props) => props,
  });
  vm.runInContext(source, context);
  for (const endpoint of ["https://proxy.example/v1", "http://127.0.0.1:8080/v1"]) {
    state = { providers: { custom: { base_url: endpoint, requires_openai_auth: true } } };
    assert.equal(context.Composer({}).submitDisabled, false, endpoint);
    assert.equal(context.Composer({ submitDisabled: true }).submitDisabled, true,
      "外部禁用条件不能因自定义 Provider 被忽略");
  }
  for (const endpoint of [undefined, "", "https://chatgpt.com/backend-api/codex",
    "https://sub.chatgpt.com./codex", "https://chat.openai.com/codex", "file:///tmp/api", "invalid"]) {
    state = { providers: { custom: { base_url: endpoint } } };
    assert.equal(context.Composer({}).submitDisabled, true, String(endpoint));
  }
  state = { providers: { custom: { base_url: "https://proxy.example/v1" } }, pending: true };
  assert.equal(context.Composer({}).submitDisabled, true, "待解析配置不能绕过额度");
  state = { providers: { custom: { base_url: "https://proxy.example/v1" } }, threadProvider: "openai" };
  assert.equal(context.Composer({}).submitDisabled, true, "已保存会话 Provider 优先于当前配置");
  state = { providers: { custom: { base_url: "https://proxy.example/v1" } }, scope: { kind: "cloud" } };
  assert.equal(context.Composer({}).submitDisabled, true, "云会话不能绕过官方额度");
});

test("26.1021 真实 adapter 的 Provider 依赖与发送门槛", { skip: !process.env.CODEX_REBUILD_1021_BUNDLE }, () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const { parse } = require("acorn");
  const { walk } = require("./patch-ast-util");
  let file = process.env.CODEX_REBUILD_1021_BUNDLE;
  if (fs.statSync(file).isDirectory()) {
    const names = fs.readdirSync(file).filter(name => /^codex-composer-adapter-.*\.js$/.test(name) &&
      fs.readFileSync(path.join(file, name), "utf8").includes("isConfigDataPending"));
    assert.equal(names.length, 1); file = path.join(file, names[0]);
  }
  const source = fs.readFileSync(file, "utf8");
  const options = { resolveModule: name => fs.readFileSync(path.join(path.dirname(file), name), "utf8") };
  const result = patchSource(source, options);
  assert.equal(result.status, "patched", result.reason);
  assert.equal(patchSource(result.code, options).status, "already");
  assert.equal(patchSource(source).status, "error", "缺少真实依赖时不能推测 Provider atom");
  const ast = parse(result.code, { ecmaVersion: "latest", sourceType: "module" });
  const composer = ast.body.find(node => node.type === "FunctionDeclaration" &&
    result.code.slice(node.start, node.end).includes("const __codexQuotaThreadProvider="));
  const guardIndex = composer.body.body.findIndex(node => node.type === "VariableDeclaration" &&
    node.declarations[0].id.name === "__codexQuotaThreadProvider");
  const guard = composer.body.body[guardIndex], disabled = composer.body.body[guardIndex + 1].declarations[0];
  const names = new Set();
  walk(disabled.init, node => { if (node.type === "Identifier") names.add(node.name); });
  const context = vm.createContext(Object.fromEntries([...names].map(name => [name, false])));
  let state;
  Object.assign(context, { URL, H: "thread-a", __codexQuotaThreadProviderAtom: {}, sn: () => {},
    A: () => state.savedProvider, R: { value: { kind: "local" } },
    Fr: { isConfigDataPending: false, resolvedConfig: { model_provider: "custom", model_providers: {} } },
    Pn: true, Ur: true });
  vm.runInContext(`function evaluate(){${result.code.slice(guard.start, guard.end)}return ${result.code.slice(disabled.init.start, disabled.init.end)}}`, context);
  for (const endpoint of ["https://proxy.example/v1", "http://localhost:8000/v1", "https://chatgpt.com", undefined]) {
    state = {};
    context.Fr.resolvedConfig.model_providers.custom = { base_url: endpoint, requires_openai_auth: true };
    assert.equal(context.evaluate(), endpoint == null || endpoint === "https://chatgpt.com", String(endpoint));
  }
  context.Fr.resolvedConfig.model_providers.custom = { base_url: "https://proxy.example/v1" };
  state.savedProvider = "openai";
  assert.equal(context.evaluate(), true, "会话已保存 Provider 优先于当前配置");
  state.savedProvider = null;
  context.Fr.isConfigDataPending = true;
  assert.equal(context.evaluate(), true);
  context.Fr.isConfigDataPending = false;
  context.R.value = { kind: "new", cloudThreadPrototype: true };
  assert.equal(context.evaluate(), true);
  context.R.value = { kind: "local" }; context.yt = true;
  assert.equal(context.evaluate(), true, "外部 submitDisabled 不被绕过");
});
