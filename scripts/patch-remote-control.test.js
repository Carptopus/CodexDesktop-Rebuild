const assert = require("node:assert/strict");
const test = require("node:test");

const { MARKER, patchSource, validatePatchedSource } = require("./patch-remote-control");

function fixture() {
  return [
    "function remoteSync(){let e=(0,cache.c)(4),t=get(Container),[n]=shared(`local_remote_control_enabled`),r,i;return e[0]!==n||e[1]!==t?(r=()=>{n!=null&&sync(t,n).catch(e=>{handle(t,e),log.error(`Failed to sync local remote control enablement`,{error:e})})},i=[n,t],e[0]=n,e[1]=t,e[2]=r,e[3]=i):(r=e[2],i=e[3]),react.useEffect(r,i),null}",
    "var cache,react;",
    "function remoteInit(){return(remoteInit=once((()=>{cache=compiled(),base(),react=reactModule(),sharedInit(),syncInit()})))()}",
    "function currentAccess(){return useAtom(accountAccess)}",
    "var accountAtom,accountAccess;",
    "function accountInit(){return(accountInit=once((()=>{accountAtom=atom(Store,()=>({accountId:null,accountLoading:!0,authLoading:!0,authMethod:null,authenticatedAccountId:null,hasChatGptToken:void 0,requiresAuth:!0,supportedSurface:null})),accountAccess=selector(Store,({get:e})=>e(accountAtom).authMethod)})))()}",
    "function gateBridge(){let e=(0,gateCache.c)(10),{checkGate:t,isLoading:n}=useGates(),r;e[0]===t?r=e[1]:(r=t(oneToOneGate),e[0]=t,e[1]=r);let i=r,a;e[2]!==t||e[3]!==i?(a=t(`1042620455`)||i,e[2]=t,e[3]=i,e[4]=a):a=e[4];let o=a,s,c;return e[5]!==n||e[6]!==i||e[7]!==o?(s=()=>{n||ipc(`set-remote-control-connections-enabled`,{params:{enabled:o,oneToOnePairingInAppEnabled:i}}).catch(e=>{log.warning(`[remote-connections/gate-bridge] sync_failed`,{error:e})})},c=[n,i,o],e[5]=n,e[6]=i,e[7]=o,e[8]=s,e[9]=c):(s=e[8],c=e[9]),react.useEffect(s,c),null}",
    "var gateCache;",
    "function gateInit(){return(gateInit=once((()=>{gateCache=compiled(),gateDeps()})))()}",
  ].join("");
}

test("API-key 清除旧启用值并禁用 Remote Control，ChatGPT 保留官方同步", () => {
  const result = patchSource(fixture());
  assert.equal(result.status, "patched", result.reason);
  validatePatchedSource(result.source);
  assert.equal(result.source.split(MARKER).length - 1, 1);
  assert.match(result.source, /__codexRemoteAccount\?\.authMethod!==`chatgpt`/);
  assert.match(result.source, /n===!0&&__codexSetRemoteEnabled\(!1\),sync\(t,!1\)/);
  assert.match(result.source, /n!=null&&sync\(t,n\)/);
  assert.match(result.source, /function remoteInit\(\).*accountInit\(\),/);
  assert.match(result.source, /function gateInit\(\).*accountInit\(\),/);
  assert.match(result.source, /__codexRemoteGateAccount\?\.authMethod===`chatgpt`/);
  assert.match(result.source, /if\(n\|\|__codexRemoteGateAccount\?\.authLoading\)return/);
  assert.match(result.source, /enabled:o,oneToOnePairingInAppEnabled:i/);
  assert.doesNotMatch(result.source, /codex-remote-gate:/);
});

test("重复应用保持幂等", () => {
  const first = patchSource(fixture());
  assert.equal(first.status, "patched", first.reason);
  const second = patchSource(first.source);
  assert.equal(second.status, "already-patched", second.reason);
  assert.equal(second.source, first.source);
});

test("拒绝继续处理曾经强开 gate 的污染 Bundle", () => {
  const source = `${fixture()}const enabled=!0/*codex-remote-gate:1042620455*/;`;
  const result = patchSource(source);
  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /官方资源重新生成/);
});

test("没有 Remote Control 同步组件时不适用", () => {
  assert.equal(patchSource("const value=1;").status, "not-applicable");
});

test("catalog 模式要求 enabled selector、完整认证 atom 及初始化器的真实导入", () => {
  const source = 'import{catalog as enabledAtom,account as currentAccount,initialize as initAuth}from"./app-initial-fixture.js";' +
    fixture().replace('[n]=shared(`local_remote_control_enabled`)', 'n=useAtom(enabledAtom)');
  const dependency = "var enabled,account;function init(){enabled=select(({get:e})=>e(catalog)?.localRemoteControlEnabled),account=atom(()=>({accountLoading:true,authLoading:true,authMethod:null,authenticatedAccountId:null,hasChatGptToken:null,requiresAuth:true,supportedSurface:null}))}export{enabled as catalog,account,init as initialize};";
  const result = patchSource(source, { resolveModule: () => dependency });
  assert.equal(result.status, "patched", result.reason);
  assert.equal(patchSource(result.source).status, "already-patched");
  assert.equal(patchSource(source).status, "unexpected-shape");
  assert.equal(patchSource(source, { resolveModule: () => dependency.replace("localRemoteControlEnabled", "otherEnabled") }).status, "unexpected-shape");
  assert.equal(patchSource(source, { resolveModule: () => dependency.replace("account,init as", "other as account,init as") }).status, "unexpected-shape");
});

test("执行生成组件验证认证加载、存储清理及两个 Remote Control 同步入口", async () => {
  const result = patchSource(fixture());
  assert.equal(result.status, "patched", result.reason);
  const { parse } = require("acorn");
  const vm = require("node:vm");
  const functions = parse(result.source, { ecmaVersion: "latest", sourceType: "module" }).body
    .filter(node => node.type === "FunctionDeclaration" && ["remoteSync", "gateBridge"].includes(node.id.name));
  assert.equal(functions.length, 2);
  const events = [], container = {};
  let account, enabled, gateLoading = false, remoteGate = true, pairingGate = true;
  const context = vm.createContext({
    get: () => container, Container: {}, accountAtom: {}, useAtom: () => account,
    shared: () => [enabled, value => { enabled = value; events.push(["storage", value]); }],
    sync: async (target, value) => { assert.equal(target, container); events.push(["sync", value]); },
    react: { useEffect: effect => effect() }, oneToOneGate: "pairing",
    useGates: () => ({ isLoading: gateLoading, checkGate: gate => gate === "pairing" ? pairingGate : remoteGate }),
    ipc: async (method, value) => events.push([method, JSON.parse(JSON.stringify(value.params))]),
  });
  vm.runInContext(functions.map(node => result.source.slice(node.start, node.end)).join(";"), context);
  for (const authMethod of ["apikey", "chatgpt", "copilot"]) {
    enabled = true;
    events.length = 0;
    account = { authMethod, authLoading: true };
    context.remoteSync(); context.gateBridge();
    assert.deepEqual(events, [], "认证加载期间不能同步或清理存储");
    account.authLoading = false;
    context.remoteSync(); context.gateBridge();
    await Promise.resolve();
    const chatgpt = authMethod === "chatgpt";
    assert.deepEqual(events, [
      ...chatgpt ? [] : [["storage", false]], ["sync", chatgpt],
      ["set-remote-control-connections-enabled", { enabled: chatgpt, oneToOnePairingInAppEnabled: chatgpt }],
    ]);
  }
  events.length = 0;
  account = { authMethod: "chatgpt", authLoading: false };
  remoteGate = false; pairingGate = false;
  context.gateBridge();
  assert.deepEqual(events.at(-1), ["set-remote-control-connections-enabled", {
    enabled: false, oneToOnePairingInAppEnabled: false,
  }], "ChatGPT 仍遵循官方 gate，不能被强制开启");
  events.length = 0;
  gateLoading = true;
  context.gateBridge();
  assert.deepEqual(events, [], "gate 加载期间不提前发送状态");
});

test("26.1016 真实 Bundle 的 Remote Control 认证切换行为", { skip: !process.env.CODEX_REBUILD_1016_BUNDLE }, async () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const { parse } = require("acorn");
  const source = fs.readFileSync(process.env.CODEX_REBUILD_1016_BUNDLE, "utf8");
  const result = patchSource(source);
  assert.equal(result.status, "patched", result.reason);
  assert.equal(patchSource(result.source).status, "already-patched");
  const functions = parse(result.source, { ecmaVersion: "latest", sourceType: "module" }).body
    .filter((node) => node.type === "FunctionDeclaration");
  const extract = (name) => {
    const matches = functions.filter((node) => node.id.name === name);
    assert.equal(matches.length, 1);
    return result.source.slice(matches[0].start, matches[0].end);
  };
  const events = [], container = {};
  let account, enabled = true;
  const context = vm.createContext({
    E: () => container, J: {}, Czl: () => [enabled, (value) => { events.push(["storage", value]); enabled = value; }],
    Z: () => account, $h: {}, rvu: async (target, value) => { assert.equal(target, container); events.push(["sync", value]); },
    gvu: { useEffect: (effect) => effect() }, xvu: { useEffect: (effect) => effect() },
    $v: () => ({ checkGate: () => true, isLoading: false }), F_i: "pairing",
    tu: async (method, value) => events.push([method, JSON.parse(JSON.stringify(value.params))]),
  });
  vm.runInContext(`${extract("mvu")};${extract("yvu")}`, context);
  for (const authMethod of ["apikey", "chatgpt", "copilot"]) {
    enabled = true;
    events.length = 0;
    account = { authMethod, authLoading: true };
    context.mvu(); context.yvu();
    assert.deepEqual(events, [], "认证加载期间不触发同步或状态清理");
    account = { authMethod, authLoading: false };
    context.mvu(); context.yvu();
    await Promise.resolve();
    const chatgpt = authMethod === "chatgpt";
    assert.deepEqual(events, [
      ...chatgpt ? [] : [["storage", false]],
      ["sync", chatgpt],
      ["set-remote-control-connections-enabled", { enabled: chatgpt, oneToOnePairingInAppEnabled: chatgpt }],
    ]);
  }
});

test("26.1021 真实 catalog 与 native Remote Control 认证切换", { skip: !process.env.CODEX_REBUILD_1021_BUNDLE }, async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const { parse } = require("acorn");
  let file = process.env.CODEX_REBUILD_1021_BUNDLE;
  if (fs.statSync(file).isDirectory()) {
    const names = fs.readdirSync(file).filter(name => /^app-runtime-.*\.js$/.test(name));
    assert.equal(names.length, 1); file = path.join(file, names[0]);
  }
  const source = fs.readFileSync(file, "utf8");
  const options = { resolveModule: name => fs.readFileSync(path.join(path.dirname(file), name), "utf8") };
  const result = patchSource(source, options);
  assert.equal(result.status, "patched", result.reason);
  assert.equal(patchSource(result.source).status, "already-patched");
  assert.equal(patchSource(source).status, "unexpected-shape", "缺少依赖必须拒绝认证推断");
  assert.match(result.source, /CodexRebuildRemoteControlCatalog/);
  assert.match(result.source, /function TU\(\).*__codexRemoteAuthInit\(\),/);
  assert.match(result.source, /function jU\(\).*__codexRemoteAuthInit\(\),/);
  assert.doesNotMatch(result.source, /__codexSetRemoteEnabled/);
  assert.equal(patchSource(result.source.replace("WE(t,!1)", "WE(t,!0)")).status,
    "unexpected-shape", "已有 catalog 标记不能掩盖非 ChatGPT enable 污染");
  const functions = parse(result.source, { ecmaVersion: "latest", sourceType: "module" }).body
    .filter(node => node.type === "FunctionDeclaration" && ["SU", "DU"].includes(node.id.name));
  assert.equal(functions.length, 2);
  const events = [], container = {}, catalogAtom = {}, accountAtom = {};
  let account, enabled = true, nativeAvailable = true;
  const context = vm.createContext({ K: () => container, f: {}, Uc: catalogAtom, Jd: accountAtom,
    H: atom => atom === catalogAtom ? enabled : account,
    WE: async (target, value) => { assert.equal(target, container); events.push(["sync", value]); },
    wU: { useEffect: effect => effect() }, kU: { useEffect: effect => effect() },
    xa: () => ({ checkGate: () => true, isLoading: false }), al: "pairing",
    I: { get remoteConnections() { return nativeAvailable ? { setRemoteControlEnabled: async params =>
      events.push(["native", JSON.parse(JSON.stringify(params))]) } : null; } },
  });
  vm.runInContext(functions.map(node => result.source.slice(node.start, node.end)).join(";"), context);
  for (const authMethod of ["apikey", "chatgpt", "copilot"]) {
    events.length = 0; account = { authMethod, authLoading: true };
    context.SU(); context.DU(); assert.deepEqual(events, []);
    account.authLoading = false; context.SU(); context.DU(); await Promise.resolve();
    const chatgpt = authMethod === "chatgpt";
    assert.deepEqual(events, [["sync", chatgpt], ["native", {
      enabled: chatgpt, oneToOnePairingInAppEnabled: chatgpt,
    }]]);
  }
  nativeAvailable = false; events.length = 0; context.DU(); assert.deepEqual(events, []);
  enabled = false; events.length = 0; context.SU(); assert.deepEqual(events, [["sync", false]]);
  const changed = { resolveModule: name => options.resolveModule(name).replace("?.localRemoteControlEnabled", "?.unexpectedEnabled") };
  assert.equal(patchSource(source, changed).status, "unexpected-shape", "catalog selector 漂移必须拒绝");
});
