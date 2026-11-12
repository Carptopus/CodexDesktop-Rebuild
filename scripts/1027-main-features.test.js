const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const acorn = require("acorn");
const worker = require("./patch-worker-limits");
const cdp = require("./patch-cdp-screenshot");
const sentry = require("./patch-sentry-scope");

// 26.1027.6604.0 early-bootstrap-499 的真实 Worker 构造表达式。
const workerExpression = "new eMg.Worker(r,{name:this.id,workerData:{...a,sentryRpcPort:n.port2,mainRpcPort:i?.port2??null},transferList:[n.port2,...null==i?[]:[i.port2]]})";
test("1027 Worker 限额保留名称、RPC 端口和 transferList", () => {
  const result = worker.patchSource("function create(){return " + workerExpression + "}");
  assert.equal(result.status, "patched");
  const run = vm.runInNewContext("(" + result.source + ")", { eMg: { Worker: class { constructor(file, options) { this.file = file; this.options = options; } } }, r: "worker.js", a: { task: "git" }, n: { port2: "sentry" }, i: { port2: "main" } });
  const instance = run.call({ id: "git-worker" });
  assert.equal(instance.file, "worker.js");
  assert.deepEqual(JSON.parse(JSON.stringify(instance.options)), { name: "git-worker", workerData: { task: "git", sentryRpcPort: "sentry", mainRpcPort: "main" }, transferList: ["sentry", "main"], resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 128 } });
  assert.equal(worker.patchSource(result.source).status, "already-patched");
  assert.equal(worker.patchSource("function absent(){}").status, "unexpected-anchor-count");
  assert.equal(worker.patchSource(result.source + result.source).status, "unexpected-anchor-count");
});

// 同一 chunk 的真实 sendDebuggerCommand，包含新增的结果包装器。
const forwarder = 'async sendDebuggerCommand(e,t,r,n={},i=this.cdpCommandTimeoutMs){let s=n.sessionId??(null==n.targetId?void 0:this.debuggerSessionIdForTarget(e,n.targetId)??void 0);if(null!=n.targetId&&n.targetId!==eeY(e)&&null==s)throw Error(`No in-app browser debugger session is attached for target ${n.targetId}`);return(0,ea.LcI)(t,await ets(e.webContents.debugger.sendCommand(t,r,s),i,`Timed out running CDP command "${t}" for tab ${e.cdpTabId}`))}';
test("1027 CDP 包装返回值和超时语义保留，仅修改整页截图副本", async () => {
  const result = cdp.patchSource("class BrowserHost{" + forwarder + "}");
  assert.equal(result.status, "patched");
  let sent, timeout, wrapped;
  const BrowserHost = vm.runInNewContext(result.source + ";BrowserHost", { ets: async (promise, ms) => { timeout = ms; return promise; }, ea: { LcI: (method, value) => { wrapped = method; return { value }; } } });
  const host = new BrowserHost();
  host.cdpCommandTimeoutMs = 456;
  const tab = { webContents: { debugger: { sendCommand: async (...args) => { sent = args; return "response"; } } } };
  const params = { captureBeyondViewport: true, clip: { width: 10000, height: 10000 }, format: "png", other: 9 };
  const response = await host.sendDebuggerCommand(tab, "Page.captureScreenshot", params, { sessionId: "session" });
  assert.equal(response.value, "response");
  assert.equal(wrapped, "Page.captureScreenshot");
  assert.equal(timeout, 456);
  assert.equal(sent[2], "session");
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1])), { captureBeyondViewport: false, format: "jpeg", quality: 60, other: 9 });
  assert.equal(params.captureBeyondViewport, true);
  assert.ok(params.clip);
  const viewport = { captureBeyondViewport: false, clip: { width: 10, height: 10 }, format: "png" };
  await host.sendDebuggerCommand(tab, "Page.captureScreenshot", viewport);
  assert.equal(sent[1], viewport);
  await host.sendDebuggerCommand(tab, "Page.navigate", params);
  assert.equal(sent[1], params);
  const jpeg = { captureBeyondViewport: true, format: "jpeg", quality: 85 };
  await host.sendDebuggerCommand(tab, "Page.captureScreenshot", jpeg);
  assert.equal(sent[1].quality, 85);
  assert.equal(cdp.patchSource(result.source).status, "already-patched");
  assert.equal(cdp.patchSource("class X{" + forwarder + forwarder + "}").status, "unexpected-shape");
});

const evidenceDir = process.env.CODEX_1027_SOURCE_EVIDENCE;
test("1027 完整真实源：五项补丁两次运行、缺失和歧义拒绝", { skip: !evidenceDir }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-1027-main-features-"));
  const build = path.join(root, "win", "_asar", ".vite", "build");
  fs.mkdirSync(build, { recursive: true });
  fs.cpSync(evidenceDir, build, { recursive: true });
  function run(name) {
    return spawnSync(process.execPath, [path.join(__dirname, "patch-" + name + ".js"), "win"], { env: { ...process.env, CODEX_PATCH_SOURCE_DIR: root }, encoding: "utf8" });
  }
  try {
    const sources = fs.readdirSync(build).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(build, f), "utf8"));
    assert.deepEqual(sentry.inspectNativeScopeProtection(sources), [{ moduleId: 72629, sanitizerModuleId: 39092, sanitizerName: "r7" }]);
    assert.equal(sentry.inspectNativeScopeProtection(sources.map((source) => source.replace("beforeBreadcrumb:o.SKH", "beforeBreadcrumb:o.wrong"))).length, 0);
    assert.equal(sentry.inspectNativeScopeProtection(sources.map((source) => source.replace("byteLength<=2048", "byteLength<=9999"))).length, 0);
    const sanitizerSource = sources.find((source) => source.includes("codex_truncated_breadcrumb_data") && source.includes("SKH:()=>r7"));
    const sanitizerAst = acorn.parse(sanitizerSource, { ecmaVersion: "latest" });
    const functions = new Map();
    function collect(node, inSanitizerModule = false) {
      if (!node || typeof node !== "object") return;
      if (node.type === "Property" && node.key?.value === 39092) inSanitizerModule = true;
      if (inSanitizerModule && node.type === "FunctionDeclaration" && ["r7", "ot", "on"].includes(node.id.name)) functions.set(node.id.name, sanitizerSource.slice(node.start, node.end));
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach((child) => collect(child, inSanitizerModule));
        else if (value?.type) collect(value, inSanitizerModule);
      }
    }
    collect(sanitizerAst);
    assert.equal(functions.size, 3);
    const truncate = vm.runInNewContext([...functions.values()].join(";") + ";r7", { TextEncoder, r8: "[Truncated: breadcrumb data exceeded 2 KiB]" });
    const small = { data: { message: "small" } };
    assert.equal(truncate(small), small);
    const large = { data: { arguments: "汉".repeat(5000), payload: "x".repeat(9000) } };
    const trimmed = truncate(large);
    assert.ok(new TextEncoder().encode(JSON.stringify(trimmed.data)).byteLength <= 2048);
    assert.equal(trimmed.data.codex_truncated_breadcrumb_data, true);
    assert.equal(large.data.payload.length, 9000);
    for (const name of ["devtools", "worker-limits", "sentry-scope", "cdp-screenshot", "copyright"]) {
      for (let pass = 0; pass < 2; pass++) {
        const result = run(name);
        assert.equal(result.status, 0, name + " " + result.stdout + result.stderr);
      }
    }
    const main = fs.readdirSync(build).find((f) => f.startsWith("early-bootstrap-499-"));
    const mainPath = path.join(build, main);
    const patched = fs.readFileSync(mainPath, "utf8");
    acorn.parse(patched, { ecmaVersion: "latest", sourceType: "module" });
    fs.copyFileSync(mainPath, path.join(build, "decoy.js"));
    assert.notEqual(run("worker-limits").status, 0);
    fs.unlinkSync(path.join(build, "decoy.js"));
    fs.unlinkSync(mainPath);
    for (const name of ["devtools", "worker-limits", "cdp-screenshot", "copyright"]) assert.notEqual(run(name).status, 0, name);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
