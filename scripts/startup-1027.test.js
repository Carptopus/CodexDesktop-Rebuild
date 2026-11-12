const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { parse } = require("acorn");
const { patchSource } = require("./patch-codex-home-env");
const { patchMain, patchPreload, MODULE } = require("./patch-rebuild-settings");
const settings = require("./runtime/rebuild-settings.cjs");
let mainSource, mainTree;
function nodes(source, predicate) {
  const found = [];
  function walk(node) {
    if (!node?.type) return;
    if (predicate(node)) found.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value?.type) walk(value);
    }
  }
  // 主进程分块超过 5 MB；同一资源只解析一次，避免无分页文件环境中的重复大树分配。
  let tree;
  if (source.length > 4 * 1024 * 1024) {
    if (mainSource !== source) { mainTree = parse(source, { ecmaVersion: "latest" }); mainSource = source; }
    tree = mainTree;
  } else tree = parse(source, { ecmaVersion: "latest" });
  walk(tree); return found;
}
const props = node => Object.fromEntries(node.properties.filter(p => p.type === "Property").map(p => [p.key.name ?? p.key.value, p.value]));
const slice = (source, node) => source.slice(node.start, node.end);
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "codex-startup-1027-"));

test("native pipe 匿名工厂写回真实 home，保留显式环境与原返回行为", () => {
  const source = 'const make=function({codexHome:home=resolve(),codexCliPath,platform="win32",startServer:start=server}){const windowsHelperPath="helper",windowsHelperTransportModulePath="transport";return {codexHome:home,windowsHelperPath,windowsHelperTransportModulePath}};';
  const patched = patchSource(source, "fixture"); assert.equal(patched.changed, true);
  assert.equal(patchSource(patched.source, "fixture").changed, false);
  const context = { process: { env: {} } };
  vm.runInNewContext(patched.source + ';globalThis.result=make({codexHome:"isolated",startServer:()=>{}})', context);
  assert.equal(context.process.env.CODEX_HOME, "isolated"); assert.equal(context.result.codexHome, "isolated");
  context.process.env.CODEX_HOME = "explicit";
  vm.runInNewContext(patched.source.replace("const make=", "globalThis.make=") + ';make({codexHome:"other",startServer:()=>{}})', context);
  assert.equal(context.process.env.CODEX_HOME, "explicit");
  assert.throws(() => patchSource(source + source.replace("const make", "const other"), "duplicate"), /Expected one/);
  assert.throws(() => patchSource(source.replaceAll("windowsHelperTransportModulePath", "unknown"), "drift"), /Unknown native-pipe/);
});

test("26.1027真实资源：组合应用、隔离顺序、官方可信 IPC 与完整 preload 执行", { skip: !process.env.CODEX_REBUILD_STARTUP_EVIDENCE }, async () => {
  const evidence = path.resolve(process.env.CODEX_REBUILD_STARTUP_EVIDENCE);
  const index = JSON.parse(fs.readFileSync(path.join(evidence, "index.json")));
  const originals = new Map();
  for (const item of index.files.filter(item => item.directory === ".vite/build" && item.copied)) {
    const bytes = fs.readFileSync(path.join(evidence, "main", item.name));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), item.sha256, item.name);
    originals.set(item.name, bytes.toString("utf8"));
  }
  const root = tempRoot();
  try {
    const asar = path.join(root, "source", "win", "_asar"), build = path.join(asar, ".vite", "build");
    fs.mkdirSync(build, { recursive: true }); fs.mkdirSync(path.join(asar, "webview", "assets"), { recursive: true });
    // 只有显式给出原始 ASAR 目录时才使用官方清单；资源子集模式使用明确的测试夹具。
    const manifest = process.env.CODEX_REBUILD_STARTUP_ASAR_DIR ? fs.readFileSync(path.join(process.env.CODEX_REBUILD_STARTUP_ASAR_DIR, "package.json")) : JSON.stringify({ main: ".vite/build/early-bootstrap.js", type: "commonjs" });
    fs.writeFileSync(path.join(asar, "package.json"), manifest);
    for (const [name, source] of originals) fs.writeFileSync(path.join(build, name), source);
    const run = (script, args = [], success = true) => {
      const result = spawnSync(process.execPath, [path.join(__dirname, script), "win", ...args], { encoding: "utf8", env: { ...process.env, CODEX_PATCH_SOURCE_DIR: path.join(root, "source") } });
      assert.equal(result.error, undefined);
      if (success) assert.equal(result.status, 0, result.stdout + result.stderr);
      else assert.notEqual(result.status, 0, "结构漂移必须失败");
    };
    for (const script of ["patch-codex-home-env.js", "patch-test-isolation.js", "patch-rebuild-settings.js"]) {
      run(script, ["--check"]);
      for (const [name, original] of originals) assert.equal(fs.readFileSync(path.join(build, name), "utf8"), original);
      run(script);
      const after = new Map([...originals.keys()].map(name => [name, fs.readFileSync(path.join(build, name), "utf8")]));
      run(script); run(script, ["--check"]);
      for (const [name, source] of after) assert.equal(fs.readFileSync(path.join(build, name), "utf8"), source, "幂等");
      // 下一补丁检查仅比较该脚本开始前状态。
      for (const name of originals.keys()) originals.set(name, fs.readFileSync(path.join(build, name), "utf8"));
    }
    const sources = [...originals.values()], main = sources.find(s => s.includes("runMainAppStartup:()=>"));
    assert.ok(main);
    const native = nodes(main, n => n.type === "FunctionExpression" && n.params[0]?.type === "ObjectPattern" && props(n.params[0]).startServer);
    assert.equal(native.length, 1);
    const isolatedHome = path.join(root, "profile", "codex-home");
    const nativeContext = { process: { env: {} }, sI: null };
    const factory = vm.runInNewContext(`(${slice(main, native[0])})`, nativeContext);
    const pipe = factory({ codexHome: isolatedHome, ensureNotifyConfig() {}, codexCliPath: "fixture", onAnalyticsEvent() {}, platform: "win32", resourcesPath: "fixture", startServer() {} });
    assert.equal(nativeContext.process.env.CODEX_HOME, isolatedHome); assert.equal(pipe.hasActiveTurn("test"), false);
    nativeContext.process.env.CODEX_HOME = "explicit";
    factory({ codexHome: "other", ensureNotifyConfig() {}, codexCliPath: "fixture", platform: "win32", resourcesPath: "fixture", startServer() {} });
    assert.equal(nativeContext.process.env.CODEX_HOME, "explicit");

    const bootstrap = sources.find(s => s.includes('setPath("userData"') && s.includes("requestSingleInstanceLock"));
    const setters = nodes(bootstrap, n => n.type === "CallExpression" && n.callee.property?.name === "setPath" && n.arguments[0]?.value === "userData");
    const setter = setters[0], hooks = nodes(bootstrap, n => n.type === "CallExpression" && n.callee.name === "require" && n.arguments[0]?.value === "./codex-rebuild-test-isolation.cjs");
    assert.equal(setters.length, 1); assert.equal(hooks.length, 1); assert.equal(bootstrap.slice(setter.end, hooks[0].start), ",");
    const lock = nodes(bootstrap, n => n.type === "CallExpression" && n.callee.property?.name === "requestSingleInstanceLock" && n.start > hooks[0].end)[0]; assert.ok(lock);
    const order = [], paths = {}, env = { CODEX_REBUILD_TEST_ROOT: path.join(root, "profile"), CODEX_REBUILD_SMOKE_EXIT: "0" };
    const fakeProcess = { env, pid: process.pid, execPath: process.execPath, on() {} };
    const app = { setPath(k, v) { paths[k] = v; order.push(k); }, getPath(k) { return paths[k] ?? root; }, whenReady: () => Promise.resolve(), requestSingleInstanceLock() { assert.equal(paths.userData, paths.sessionData); order.push("lock"); return true; }, exit() { assert.fail("isolation exit"); } };
    const context = { process: fakeProcess, console, require(name) { if (name === "electron") return { app }; if (name.startsWith("node:")) return require(name); return vm.runInNewContext(fs.readFileSync(path.join(build, name), "utf8"), context); } };
    vm.runInNewContext(fs.readFileSync(path.join(build, "codex-rebuild-test-environment.cjs"), "utf8"), context);
    const appName = setter.callee.object.object.name;
    context[appName] = { app };
    const resolver = setter.arguments[1];
    assert.equal(resolver.type, "CallExpression");
    const resolverOptions = props(resolver.arguments[0]);
    assert.equal(resolverOptions.buildFlavor.type, "Identifier");
    context[resolverOptions.buildFlavor.name] = "prod";
    const pathCalls = nodes(`(${slice(bootstrap, resolver.callee)})`, node => node.type === "CallExpression"
      && node.callee.type === "SequenceExpression").map(node => node.callee.expressions.at(-1));
    for (const member of pathCalls) {
      if (member.type !== "MemberExpression" || member.object.type !== "Identifier") continue;
      context[member.object.name] = ["resolve", "join"].includes(member.property.name)
        ? path : { [member.property.name]: () => null };
    }
    const taskChecks = nodes(slice(bootstrap, lock), node => node.type === "BinaryExpression"
      && [node.left, node.right].some(operand => operand.value === "startup-task"));
    assert.equal(taskChecks.length, 1);
    const taskKind = [taskChecks[0].left, taskChecks[0].right].find(node => node.type === "Identifier");
    context[taskKind.name] = "interactive";
    vm.runInNewContext(bootstrap.slice(setter.start, hooks[0].end) + ";" + slice(bootstrap, lock), context);
    await Promise.resolve(); assert.deepEqual(order, ["userData", "sessionData", "lock"]);
    assert.equal(env.CODEX_HOME, isolatedHome); assert.ok(fs.existsSync(path.join(root, "profile", "isolation-runtime.json")));
    const entry = fs.readFileSync(path.join(build, "early-bootstrap.js"), "utf8");
    const callbacks = nodes(entry, n => n.type === "ArrowFunctionExpression" && n.params[0]?.name === "e" && slice(entry, n).includes("native-startup-error.json"));
    assert.equal(callbacks.length, 1);
    const imports = Object.assign(function () {}, { e: async () => {}, bind: () => () => ({ getLogger: () => ({ error() { order.push("startup-error"); } }) }) });
    env.CODEX_REBUILD_SMOKE_EXIT = "1";
    const catchContext = { process: fakeProcess, require, n: imports, r: { app: { exit(code) { assert.equal(code, 1); order.push("exit"); } } } };
    await vm.runInNewContext(`(${slice(entry, callbacks[0])})(new Error("startup failure"))`, catchContext);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "profile", "native-startup-error.json"))).message, "startup failure");

    const installs = nodes(main, n => n.type === "CallExpression" && n.callee.property?.name === "install" && n.callee.object.arguments?.[0]?.value === `./${MODULE}`);
    assert.equal(installs.length, 1); const installArgs = props(installs[0].arguments[0]);
    const ipcMain = new EventEmitter(), handlers = new Map(); ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
    ipcMain.removeHandler = channel => handlers.delete(channel);
    const sender = new EventEmitter(); sender.mainFrame = { url: "app://-/index.html" }; sender.isDestroyed = () => false; sender.send = () => {};
    const trustedName = installArgs.isTrustedIpcEvent.name;
    const trusted = nodes(main, n => n.type === "VariableDeclarator" && n.id.name === trustedName && n.init?.type === "ArrowFunctionExpression" && n.init.body.callee?.property?.name === "isTrustedIpcSender"); assert.equal(trusted.length, 1);
    const validator = trusted[0].init.body.callee.object.name;
    let seenFrame;
    const mainContext = { [validator]: { getContextForWebContents() { return {}; }, isTrustedIpcSender(actualSender, frame) { seenFrame = frame; return actualSender === sender && frame === sender.mainFrame; } }, [installArgs.codexHome.object.name]: { codexHome: isolatedHome }, require(name) { assert.equal(name, `./${MODULE}`); return { install(options) { return settings.install({ ...options, electron: { ipcMain } }); } }; } };
    mainContext[trustedName] = vm.runInNewContext(`(${slice(main, trusted[0].init)})`, mainContext);
    const registrations = nodes(main, n => n.type === "CallExpression" && n.callee.type === "FunctionExpression" && n.arguments[0]?.type === "ObjectExpression" && props(n.arguments[0]).buildFlavor && props(n.arguments[0]).getContextForWebContents && props(n.arguments[0]).isTrustedIpcEvent);
    assert.equal(registrations.length, 1);
    mainContext[props(registrations[0].arguments[0]).buildFlavor.name] = "prod";
    const listeners = nodes(`(${slice(main, registrations[0].callee)})`, node => node.type === "CallExpression"
      && node.callee.property?.name === "on" && node.callee.object.property?.name === "ipcMain");
    assert.ok(listeners.length > 0, "真实官方 IPC 注册不能缺失");
    for (const listener of listeners) {
      mainContext[listener.callee.object.object.name] = { ipcMain };
      mainContext[listener.arguments[0].object.name] = new Proxy({}, { get: (_target, key) => `official:${String(key)}` });
    }
    vm.runInNewContext(`(${main.slice(registrations[0].start, installs[0].end)})`, mainContext);
    for (const listener of listeners) assert.equal(ipcMain.listenerCount(`official:${listener.arguments[0].property.name}`), 1, "新增挂载保留真实官方 IPC");
    const preload = sources.find(s => s.includes('exposeInMainWorld("electronBridge"'));
    function renderer(frame) {
      const ipcRenderer = new EventEmitter(), exposed = {};
      ipcRenderer.send = () => {};
      ipcRenderer.sendSync = channel => { if (channel === settings.CHANNELS.read) { const event = { sender, senderFrame: frame }; ipcMain.emit(channel, event); return event.returnValue; } if (channel.endsWith("get-sentry-init-options")) return { appVersion: "fixture" }; if (channel.endsWith("get-shared-object-snapshot")) return {}; return "light"; };
      ipcRenderer.invoke = (channel, patch) => handlers.get(channel)({ sender, senderFrame: frame }, patch);
      vm.runInNewContext(preload, { require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld(k, v) { exposed[k] = v; } }, webUtils: {} }), module: { exports: {} }, window: { addEventListener() {}, dispatchEvent() {}, location: { href: "app://-/index.html", origin: "app://-" } }, document: { documentElement: { dataset: {} } }, performance: { timeOrigin: 0 }, process: { platform: "win32", arch: "x64", argv: [] }, URL, console });
      return exposed.electronBridge.rebuildSettings;
    }
    const bridge = renderer(sender.mainFrame); assert.equal(bridge.read().readingWidthPercent, 50); assert.equal(seenFrame, sender.mainFrame);
    assert.equal((await bridge.write({ readingWidthPercent: 70 })).readingWidthPercent, 70);
    assert.equal(JSON.parse(fs.readFileSync(path.join(isolatedHome, "codex-rebuild-settings.json"))).readingWidthPercent, 70);
    const outsider = renderer({ url: "app://-/index.html" }); assert.match(outsider.read().error, /未受信任/); await assert.rejects(outsider.write({ readingWidthPercent: 80 }), /未受信任/);
    assert.equal(bridge.read().readingWidthPercent, 70);
    assert.throws(() => patchPreload(preload.replace("subscribeToSystemThemeVariant:", "unknownThemeSubscription:")), /当前必要通信契约/);
    assert.throws(() => patchMain(main.replace(slice(main, trusted[0].init), slice(main, trusted[0].init).replace(".isTrustedIpcSender(", ".unknownSender("))), /可信校验/);
    const bootFile = path.join(build, [...originals.keys()].find(name => originals.get(name) === bootstrap));
    fs.writeFileSync(bootFile, bootstrap.replace("requestSingleInstanceLock({startupTask:", "unknownLock({startupTask:")); run("patch-test-isolation.js", ["--check"], false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
