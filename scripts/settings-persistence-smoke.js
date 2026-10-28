#!/usr/bin/env node
/** 用真实生成 main/preload 资源贯通 IPC 与磁盘；不启动 GUI，不冒充候选原生验收。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const { execFileSync } = require("node:child_process");
const { parse } = require("acorn");
const { SRC_DIR } = require("./patch-util");
const { CHANNELS } = require("./runtime/rebuild-settings.cjs");
const raw = path.resolve(process.env.RAW_ASAR_DIR || path.join(SRC_DIR, "win", "_asar"));
const parent = path.resolve(process.env.REBUILD_SETTINGS_SMOKE_ROOT || os.tmpdir());
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "settings-persistence-"));
const generated = path.join(root, "source", "win", "_asar"), build = path.join(generated, ".vite", "build");
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}
async function main() {
  fs.mkdirSync(build, { recursive: true }); fs.mkdirSync(path.join(generated, "webview", "assets"), { recursive: true });
  fs.copyFileSync(path.join(raw, "package.json"), path.join(generated, "package.json"));
  const originalBuild = path.join(raw, ".vite", "build");
  const names = fs.readdirSync(originalBuild).filter(name => /^main-.*\.js$/.test(name) && fs.readFileSync(path.join(originalBuild, name), "utf8").includes("exports.runMainAppStartup="));
  assert.equal(names.length, 1, "需要唯一的真实官方 main 资源");
  for (const name of [names[0], "early-bootstrap.js", "preload.js"]) fs.copyFileSync(path.join(originalBuild, name), path.join(build, name));
  const patch = (flags, platform = "win") => execFileSync(process.execPath, [path.join(__dirname, "patch-rebuild-settings.js"), ...(platform ? [platform] : []), ...flags], { env: { ...process.env, CODEX_PATCH_SOURCE_DIR: path.join(root, "source") }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const sourceBefore = fs.readFileSync(path.join(build, names[0]));
  patch(["--check"], null); assert.deepEqual(fs.readFileSync(path.join(build, names[0])), sourceBefore, "自动选择现有 Windows 平台且 --check 不写入");
  patch(["--check"]); assert.deepEqual(fs.readFileSync(path.join(build, names[0])), sourceBefore, "--check 不改 main");
  assert.equal(fs.existsSync(path.join(build, "codex-rebuild-settings.cjs")), false, "--check 不复制模块");
  patch([], null);
  const patchedMain = fs.readFileSync(path.join(build, names[0]), "utf8"), patchedPreload = fs.readFileSync(path.join(build, "preload.js"), "utf8");
  patch([]); assert.equal(fs.readFileSync(path.join(build, names[0]), "utf8"), patchedMain); assert.equal(fs.readFileSync(path.join(build, "preload.js"), "utf8"), patchedPreload);
  assert.deepEqual(fs.readFileSync(path.join(generated, "webview", "assets", "rebuild-settings.mjs")), fs.readFileSync(path.join(__dirname, "runtime", "rebuild-settings.mjs")));
  const handlers = new Map(), ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); };
  ipcMain.removeHandler = channel => handlers.delete(channel);
  const codexHome = path.join(root, "isolated-codex-home"), file = path.join(codexHome, "codex-rebuild-settings.json");
  const senders = [], trusted = event => senders.includes(event.sender) && !event.sender.destroyed && event.senderFrame === event.sender.mainFrame && event.sender.mainFrame.url === "app://-/index.html";
  let dispose;
  const tree = parse(patchedMain, { ecmaVersion: "latest", sourceType: "script" }), installs = [];
  walk(tree, node => {
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.name === "install" && node.callee.object.type === "CallExpression" && node.callee.object.callee.name === "require" && node.callee.object.arguments[0]?.value === "./codex-rebuild-settings.cjs") installs.push(node);
  });
  assert.equal(installs.length, 1);
  const install = installs[0], args = Object.fromEntries(install.arguments[0].properties.map(prop => [prop.key.name, prop.value]));
  const context = {
    require(name) { assert.equal(name, "./codex-rebuild-settings.cjs"); return { install(options) { dispose = require(path.join(build, "codex-rebuild-settings.cjs")).install({ ...options, electron: { ipcMain } }); } }; },
    [args.codexHome.object.name]: { codexHome }, [args.isTrustedIpcEvent.name]: trusted,
  };
  vm.runInNewContext(patchedMain.slice(install.start, install.end), context);
  function renderer({ allowed = true, frame = true } = {}) {
    const sender = new EventEmitter(), ipcRenderer = new EventEmitter();
    sender.destroyed = false; sender.isDestroyed = () => sender.destroyed; sender.mainFrame = { url: "app://-/index.html" };
    sender.send = (channel, value) => ipcRenderer.emit(channel, {}, value);
    if (allowed) senders.push(sender);
    const event = () => ({ sender, senderFrame: frame ? sender.mainFrame : { url: sender.mainFrame.url } });
    ipcRenderer.send = () => {};
    ipcRenderer.sendSync = channel => {
      if (channel === CHANNELS.read) { const request = event(); ipcMain.emit(channel, request); assert.ok(Object.hasOwn(request, "returnValue"), "同步请求必须返回明确结果"); return request.returnValue; }
      if (channel.endsWith("get-sentry-init-options")) return { appVersion: "fixture", codexAppSessionId: "fixture" };
      if (channel.endsWith("get-shared-object-snapshot")) return {};
      return "light";
    };
    ipcRenderer.invoke = (channel, value) => { assert.equal(channel, CHANNELS.write); return handlers.get(channel)(event(), value); };
    const exposed = {}, win = { addEventListener() {}, dispatchEvent() {}, location: { origin: "app://-" } };
    vm.runInNewContext(patchedPreload, { require(name) { assert.equal(name, "electron"); return { ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } }, webUtils: {} }; }, window: win, document: { documentElement: { dataset: {} } }, performance: { timeOrigin: 0 }, process: { platform: "win32", arch: "x64" }, console });
    return { bridge: exposed.electronBridge.rebuildSettings, sender, destroy() { sender.destroyed = true; sender.emit("destroyed"); } };
  }
  const a = renderer(), b = renderer(), outsider = renderer({ allowed: false }), subframe = renderer({ frame: false });
  const clean = value => JSON.parse(JSON.stringify(value));
  const defaults = { readingWidthPercent: 50, markdownBoldColorMode: "default", markdownBoldCustomColor: "#7c3aed", accentPreset: null };
  assert.deepEqual(clean(a.bridge.read()), defaults); assert.equal(fs.existsSync(file), false, "缺文件读取不落盘");
  assert.deepEqual(clean(b.bridge.read()), defaults);
  assert.equal(typeof outsider.bridge.read().error, "string"); assert.equal(typeof subframe.bridge.read().error, "string");
  await assert.rejects(outsider.bridge.write({ readingWidthPercent: 70 }), /未受信任/);
  await assert.rejects(subframe.bridge.write({ readingWidthPercent: 70 }), /未受信任/);
  let changes = 0, outsiderChanges = 0, latest;
  const stop = b.bridge.onChange(value => { changes++; latest = value; }); outsider.bridge.onChange(() => outsiderChanges++);
  const saved = await a.bridge.write({ readingWidthPercent: 70, markdownBoldColorMode: "custom", markdownBoldCustomColor: "#407aed" });
  assert.deepEqual(saved, { ...defaults, readingWidthPercent: 70, markdownBoldColorMode: "custom", markdownBoldCustomColor: "#407aed" });
  assert.equal(changes, 1); assert.deepEqual(latest, saved); assert.equal(outsiderChanges, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), saved);
  const globalKeys = ["electronBridge", "window", "document", "localStorage"], originalGlobals = new Map(globalKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const effects = [];
  try {
    const styles = new Map(), widthsAtApply = [], dataset = new Proxy({}, { set(target, key, value) { if (key === "codexRebuildReadingWidth") widthsAtApply.push(value); target[key] = value; return true; } });
    globalThis.electronBridge = { rebuildSettings: a.bridge };
    globalThis.window = new EventTarget();
    globalThis.document = { documentElement: { dataset }, getElementById: id => styles.get(id), createElement(tag) { assert.equal(tag, "style"); return { id: "", textContent: "" }; }, head: { append(style) { styles.set(style.id, style); } } };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("独立配置流程禁止读取 localStorage"); } });
    const reading = await import(pathToFileURL(path.join(__dirname, "runtime", "reading-width.mjs")).href);
    const accent = await import(pathToFileURL(path.join(__dirname, "runtime", "accent-presets.mjs")).href);
    const style = styles.get("codex-rebuild-reading-style");
    assert.deepEqual(widthsAtApply, ["70"], "首次样式直接使用持久值，没有先应用默认宽度");
    assert.equal(dataset.codexRebuildReadingWidth, "70"); assert.ok(style.textContent.includes("#407aed"));
    const controls = [], react = { Fragment: Symbol("Fragment"), useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; }, useEffect(effect) { effects.push(effect()); } };
    const ui = { jsx(type, props) { if (props["data-codex-rebuild-width-control"]) controls.push(props); return { type, props }; }, jsxs(type, props) { return this.jsx(type, props); } };
    reading.renderReadingWidth(react, ui, function Row() {}, { locale: "zh-CN" });
    assert.equal(controls.length, 1); assert.equal(controls[0].value, "70");
    await controls[0].onChange({ currentTarget: { value: "85" } });
    const fromSlider = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(fromSlider, { ...saved, readingWidthPercent: 85 });
    assert.equal(dataset.codexRebuildReadingWidth, "85"); assert.ok(style.textContent.includes("max(48rem,85%)") && style.textContent.includes("#407aed"));
    let localApplied = false;
    await accent.selectAccentPreset(null, "green", () => { localApplied = true; }, () => { throw new Error("本地强调色不应选择账户预设"); });
    assert.equal(localApplied, true); assert.equal(accent.readLocalAccentPreset(), "green");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ...fromSlider, accentPreset: "green" });
  } finally {
    for (const cleanup of effects) cleanup?.();
    for (const key of globalKeys) { const descriptor = originalGlobals.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
  await Promise.all([a.bridge.write({ readingWidthPercent: 85 }), b.bridge.write({ accentPreset: "blue" })]);
  assert.deepEqual(clean(renderer().bridge.read()), { ...saved, readingWidthPercent: 85, accentPreset: "blue" });
  const external = { ...saved, readingWidthPercent: 100, accentPreset: "green" };
  fs.writeFileSync(file, JSON.stringify(external));
  assert.deepEqual(await a.bridge.write({ markdownBoldColorMode: "accent" }), { ...external, markdownBoldColorMode: "accent" }, "写入前读取最新磁盘，保留外部修改");
  for (const bad of [{ arbitraryPath: "ignored" }, { readingWidthPercent: 71 }, { accentPreset: "unknown" }, { markdownBoldColorMode: "invalid" }, { markdownBoldCustomColor: "red" }, { readingWidthPercent: null }]) await assert.rejects(a.bridge.write(bad));
  const previous = fs.readFileSync(file, "utf8"), notifications = changes;
  const writeFile = fs.writeFileSync;
  let partialDescriptor;
  try {
    // 文件已创建且写入部分字节后故障，仍需关闭句柄并删除本次临时文件。
    fs.writeFileSync = (target, ...options) => {
      if (typeof target === "number") { partialDescriptor = target; fs.writeSync(target, "{partial"); throw new Error("模拟磁盘写入中断"); }
      return writeFile(target, ...options);
    };
    await assert.rejects(a.bridge.write({ readingWidthPercent: 75 }), /磁盘写入中断/);
    assert.equal(typeof partialDescriptor, "number"); assert.throws(() => fs.fstatSync(partialDescriptor), /EBADF/);
    assert.equal(fs.readFileSync(file, "utf8"), previous); assert.equal(changes, notifications);
    assert.deepEqual(fs.readdirSync(codexHome), ["codex-rebuild-settings.json"], "部分写入故障不残留临时文件");
  } finally { fs.writeFileSync = writeFile; }
  const rename = fs.renameSync;
  try {
    // 在完整桥调用内模拟最终磁盘提交失败，确认 UI 不收到已保存通知且原文件保留。
    fs.renameSync = (source, target) => { if (target === file) throw Object.assign(new Error("模拟磁盘提交失败"), { code: "EACCES" }); return rename(source, target); };
    await assert.rejects(a.bridge.write({ readingWidthPercent: 75 }), /磁盘提交失败/);
    assert.equal(fs.readFileSync(file, "utf8"), previous); assert.equal(changes, notifications);
    assert.deepEqual(fs.readdirSync(codexHome), ["codex-rebuild-settings.json"]);
  } finally { fs.renameSync = rename; }
  for (const invalid of ["{bad-json", JSON.stringify({ readingWidthPercent: 70 }), JSON.stringify({ ...defaults, extra: 1 }), " ".repeat(65537)]) {
    fs.writeFileSync(file, invalid); assert.equal(typeof a.bridge.read().error, "string");
    await assert.rejects(a.bridge.write({ readingWidthPercent: 75 })); assert.equal(fs.readFileSync(file, "utf8"), invalid, "损坏文件不被写入覆盖");
  }
  assert.equal(changes, notifications, "失败写入不广播"); fs.writeFileSync(file, previous);
  stop(); await a.bridge.write({ accentPreset: null }); assert.equal(changes, notifications, "取消监听后不再回调");
  b.sender.mainFrame.url = "https://example.invalid";
  await a.bridge.write({ accentPreset: "pink" }); assert.equal(b.sender.listenerCount("destroyed"), 0, "导航离开可信页面后清除订阅");
  a.destroy(); assert.equal(a.sender.listenerCount("destroyed"), 0);
  assert.deepEqual(fs.readdirSync(codexHome), ["codex-rebuild-settings.json"], "成功与失败后无临时文件残留");
  dispose(); assert.equal(ipcMain.listenerCount(CHANNELS.read), 0); assert.equal(handlers.size, 0);
  vm.runInNewContext(patchedMain.slice(install.start, install.end), context);
  assert.deepEqual(clean(renderer().bridge.read()), JSON.parse(fs.readFileSync(file, "utf8")), "main 重新安装后从磁盘恢复"); dispose();
  const drifted = fs.readFileSync(path.join(originalBuild, "preload.js"), "utf8").replaceAll("exposeInMainWorld", "driftedExposeInMainWorld");
  fs.writeFileSync(path.join(build, "preload.js"), drifted);
  assert.throws(() => patch(["--check"]), /electronBridge/); assert.equal(fs.readFileSync(path.join(build, "preload.js"), "utf8"), drifted, "锚点漂移失败不写入");
  console.log("[ok] 真实 main/preload 与生产外观模块贯通：首屏持久值、滑杆/强调色保存、重载、并发补丁、部分写入/落盘失败、可信广播及锚点漂移拒绝");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  // 只清理本脚本刚创建的随机目录，不处理调用者提供的父目录。
  if (path.dirname(root) === parent && path.basename(root).startsWith("settings-persistence-")) fs.rmSync(root, { recursive: true, force: true });
});
