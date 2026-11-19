const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  MODULE,
  SETTINGS_MARKER,
  THEME_MARKER,
  findThemeTarget,
  patchSettingsSource,
  patchThemeSource,
} = require("./patch-accent-presets");

function settingsFixture() {
  return 'import{palette as P,options as O}from"./app.js";' +
    'function Accent(e){let{theme:r,variant:i,onSelect:a,onCustomColorChange:o}=e,s=scope(),u=read(themeAtom),d=read(pendingAtom),' +
    'f=r.accentSource===`chatgpt`?u?.chatTheme??`default`:`custom`,v=f!==`custom`&&jsx(`span`,{style:{backgroundColor:P(u?.effectiveTheme??f,i)}}),' +
    'x=O.map(e=>jsx(RadioItem,{disabled:u==null,value:e,onSelect:()=>{let t=s.get(account),n=s.get(settings).data,r=t!=null&&n?.eligibleNowOrBefore===!0;' +
    'a(e,()=>{r&&sync({accentColor:e})}).catch(()=>{toast("chatgptAccentPicker.ChatGptAccentPicker.updateError")})},children:e},e)),' +
    'S=()=>o(r.accent),D=f===`custom`?jsx(ColorInput,{value:r.accent,onChange:o}):null;return [v,x,S,D]}';
}

function themeFixture() {
  return 'const presets={' +
    'default:{accent:`#default-accent`,userMessageBackground:`#default-bubble`,userMessageText:`#default-text`,soft:`#default-soft`},' +
    'blue:{accent:`#blue-accent`,userMessageBackground:`#blue-bubble`,userMessageText:`#blue-text`,soft:`#blue-soft`},' +
    'green:{accent:`#green-accent`,userMessageBackground:`#green-bubble`,userMessageText:`#green-text`,soft:`#green-soft`},' +
    'black:{accent:`#black-accent`,userMessageBackground:`#black-bubble`,userMessageText:`#black-text`,soft:`#black-soft`}};' +
    'function dba(e,t){return presets[e]}' +
    'function Tba(e,t,n,r=!0,i=!1){let a=e.accentSource===`chatgpt`&&n!=null?dba(n??`default`,t,r):null,' +
    'd={"--color-image-generation-accent":a!=null&&n===`black`?`black-image`:e.accent,"--color-background-user-message":`neutral-bubble`};' +
    'return a==null?d:{...d,"--color-background-user-message":a.userMessageBackground,"--color-text-user-message":a.userMessageText,"--app-color-background-accent":a.soft}}export{Tba}';
}

const defaults = {
  readingWidthPercent: 50,
  markdownBoldColorMode: "default",
  markdownBoldCustomColor: "#7c3aed",
  accentPreset: null,
};
let snapshot = { ...defaults };
let failWrites = false;
const listeners = new Set();
function replaceSnapshot(next) {
  snapshot = { ...next };
  for (const listener of listeners) listener({ ...snapshot });
}
globalThis.electronBridge = { rebuildSettings: {
  read: () => ({ ...snapshot }),
  async write(patch) {
    if (failWrites) throw new Error("settings unavailable");
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener({ ...snapshot });
    return { ...snapshot };
  },
  onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
} };

async function runtimeModule() {
  return import(pathToFileURL(path.join(__dirname, "runtime", "accent-presets.mjs")).href);
}

test.afterEach(() => {
  failWrites = false;
  replaceSnapshot(defaults);
});

test("无账户主题时启用本地预设并保留加载态禁用", () => {
  const result = patchSettingsSource(settingsFixture());
  assert.equal(result.status, "patched", result.reason);
  assert.match(result.source, new RegExp(SETTINGS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.source, new RegExp(MODULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.source, /__codexCurrentAccent/);
  assert.match(result.source, /disabled:u===void 0/);
  assert.match(result.source, /__codexAccentSelection\(u,r\.accentSource,/);
  assert.match(result.source, /__codexSelectAccentPreset\(u,e,\(\)=>o\(r\.accent\),\(\)=>a\(/);
  assert.match(result.source, /onChange:__codexColor=>__codexUseCustomAccent\(o,__codexColor\)/);
  assert.equal(patchSettingsSource(result.source).status, "already-patched");
});

test("设置组件在属性解构后才读取主题", () => {
  const result = patchSettingsSource(settingsFixture());
  assert.equal(result.status, "patched", result.reason);
  const executable = result.source.replace(/import[^;]+;/g, "");
  const Accent = Function(
    "P", "O", "scope", "read", "themeAtom", "pendingAtom", "jsx", "RadioItem", "ColorInput",
    "account", "settings", "sync", "toast", "__codexAccentSelection", "__codexSelectAccentPreset", "__codexUseCustomAccent",
    `${executable};return Accent;`,
  )(
    () => "color", ["default", "blue"], () => ({ get: () => null }), () => null, {}, {},
    (_type, props) => props, "radio", "color", {}, {}, () => {}, () => {},
    (_accountTheme, _accentSource, fallback) => fallback,
    () => Promise.resolve(),
    (onChange, value) => onChange(value),
  );

  assert.doesNotThrow(() => Accent({
    theme: { accent: "#123456", accentSource: "custom" },
    variant: "light",
    onSelect: () => Promise.resolve(),
    onCustomColorChange: () => {},
  }));
});

test("旧版在属性解构前读取主题的崩溃补丁会被拒绝", () => {
  const patched = patchSettingsSource(settingsFixture());
  assert.equal(patched.status, "patched", patched.reason);
  const broken = patched.source.replace("function Accent(e){let", "function Accent(e){const __codexCurrentAccent=r.accent;let");
  const result = patchSettingsSource(broken);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /本地强调色设置标记不完整/);
});

test("设置和主题未知结构均明确失败", () => {
  const settings = patchSettingsSource('const x="chatgptAccentPicker.ChatGptAccentPicker.updateError accentSource"');
  assert.equal(settings.status, "unexpected-shape");
  const theme = patchThemeSource('const x="--color-background-user-message --color-image-generation-accent accentSource"');
  assert.equal(theme.status, "unexpected-shape");
});

test("主题函数唯一注入本地预设解析器并保持幂等", () => {
  const result = patchThemeSource(themeFixture());
  assert.equal(result.status, "patched", result.reason);
  assert.match(result.source, new RegExp(THEME_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.source, /__codexResolveAccentPreset\(e\.accentSource,n\)/);
  assert.match(result.source, /e=\{\.\.\.e,accentSource:`chatgpt`\}/);
  assert.equal(patchThemeSource(result.source).status, "already-patched");
});

test("CLI 按主题签名定位旧新 chunk，并拒绝重复目标", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-accent-locator-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "general-settings-fixture.js"), settingsFixture());
  const env = { ...process.env, CODEX_PATCH_SOURCE_DIR: root };
  for (const name of ["app-initial-legacy.js", "app-theme-current.js"]) {
    fs.writeFileSync(path.join(assets, name), themeFixture());
    assert.equal(findThemeTarget(assets).name, name);
    assert.match(execFileSync(process.execPath, [path.join(__dirname, "patch-accent-presets.js"), "--check"], { env, encoding: "utf8" }), /主题生成器结构已核对/);
    fs.unlinkSync(path.join(assets, name));
  }
  fs.writeFileSync(path.join(assets, "app-initial-a.js"), themeFixture());
  fs.writeFileSync(path.join(assets, "app-theme-b.js"), themeFixture());
  assert.throws(() => findThemeTarget(assets), /主题资源数量异常（2）/);
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, "patch-accent-presets.js"), "--check"], { env, encoding: "utf8" }), /强调色主题资源数量异常（2）/);
});

test("真实资源路径可核对 26.1021 设置与主题 Bundle", { skip: !process.env.CODEX_REBUILD_ACCENT_ASSETS }, () => {
  const assets = process.env.CODEX_REBUILD_ACCENT_ASSETS;
  const settingsFiles = fs.readdirSync(assets).filter(name => /^general-settings-.*\.js$/.test(name) &&
    fs.readFileSync(path.join(assets, name), "utf8").includes("chatgptAccentPicker.ChatGptAccentPicker.updateError"));
  const themeFiles = fs.readdirSync(assets).filter(name => /^app-theme-.*\.js$/.test(name) &&
    ["--color-background-user-message", "--color-image-generation-accent", "accentSource"]
      .every(value => fs.readFileSync(path.join(assets, name), "utf8").includes(value)));
  assert.equal(settingsFiles.length, 1, "设置组件应唯一定位");
  assert.equal(themeFiles.length, 1, "主题生成器应唯一定位");
  const settings = patchSettingsSource(fs.readFileSync(path.join(assets, settingsFiles[0]), "utf8"));
  const theme = patchThemeSource(fs.readFileSync(path.join(assets, themeFiles[0]), "utf8"));
  assert.equal(settings.status, "patched", settings.reason);
  assert.equal(theme.status, "patched", theme.reason);
  assert.match(settings.source, /disabled:[^,}]*===void 0/);
  assert.match(theme.source, /__codexResolveAccentPreset\(/);
  assert.equal(patchThemeSource(theme.source).status, "already-patched");
});

test("本地设置、账户同步和显式自定义使用同一预设状态", async () => {
  const runtime = await runtimeModule();
  let localCalls = 0;
  let accountCalls = 0;
  let customValue = null;

  await runtime.selectAccentPreset(null, "blue", () => { localCalls++; }, () => { accountCalls++; });
  assert.equal(snapshot.accentPreset, "blue");
  assert.equal(runtime.accentPresetSelection(null, "custom", "custom"), "blue");
  assert.equal(runtime.accentPresetSelection({ chatTheme: "green" }, "custom", "custom"), "blue");
  assert.equal(runtime.accentPresetSelection(undefined, "custom", "custom"), "custom");
  assert.equal(runtime.accentPresetSelection({ chatTheme: "green" }, "chatgpt", "green"), "green");
  assert.equal(runtime.resolveAccentPreset("custom", null), "blue");
  assert.equal(localCalls, 1);
  assert.equal(accountCalls, 0);

  await runtime.selectAccentPreset({ chatTheme: "green" }, "green", () => { localCalls++; }, () => { accountCalls++; });
  assert.equal(snapshot.accentPreset, "green");
  assert.equal(accountCalls, 1);

  failWrites = true;
  await runtime.selectAccentPreset({ chatTheme: "purple" }, "purple", () => { localCalls++; }, () => { accountCalls++; });
  assert.equal(accountCalls, 2);

  await runtime.selectAccentPreset({ chatTheme: "future" }, "future-preset", () => { localCalls++; }, () => { accountCalls++; });
  assert.equal(accountCalls, 3);
  assert.equal(snapshot.accentPreset, "green");

  await runtime.selectAccentPreset(null, "future-preset", () => { localCalls++; }, () => { accountCalls++; });
  assert.equal(accountCalls, 4);
  assert.equal(localCalls, 1);

  failWrites = false;
  replaceSnapshot({ ...snapshot, accentPreset: "blue" });
  await runtime.useCustomAccent(value => { customValue = value; }, "#123456");
  assert.equal(customValue, "#123456");
  assert.equal(snapshot.accentPreset, "custom");
  assert.equal(runtime.accentPresetSelection(null, "custom", "custom"), "custom");
  assert.equal(runtime.resolveAccentPreset("custom", null), null);
});

test("预设解析补齐官方默认有效色并拒绝无效本地值", async () => {
  const runtime = await runtimeModule();
  assert.equal(runtime.accentPresetSelection(null, "custom", "custom"), "default");
  assert.equal(runtime.resolveAccentPreset("custom", null), "blue");
  replaceSnapshot({ ...snapshot, accentPreset: "blue" });
  assert.equal(runtime.resolveAccentPreset("custom", null), "blue");
  assert.equal(runtime.resolveAccentPreset("chatgpt", "green"), "green");
  assert.equal(runtime.resolveAccentPreset("custom", "green"), "blue");

  for (const preset of ["blue", "black"]) {
    replaceSnapshot({ ...snapshot, accentPreset: preset });
    assert.equal(runtime.resolveAccentPreset("custom", null), preset);
  }
  replaceSnapshot({ ...snapshot, accentPreset: "default" });
  assert.equal(runtime.accentPresetSelection(null, "custom"), "default");
  assert.equal(runtime.resolveAccentPreset("custom", null), "blue");
  replaceSnapshot({ ...snapshot, accentPreset: "not-a-preset" });
  assert.equal(runtime.resolveAccentPreset("custom", null), "blue");
});

test("完整主题链复用官方预设气泡且账户主题优先", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-accent-theme-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, "runtime", "accent-presets.mjs"), path.join(directory, MODULE));
  fs.copyFileSync(path.join(__dirname, "runtime", "rebuild-settings.mjs"), path.join(directory, "rebuild-settings.mjs"));
  const result = patchThemeSource(themeFixture());
  assert.equal(result.status, "patched", result.reason);
  const bundle = path.join(directory, "theme.mjs");
  fs.writeFileSync(bundle, result.source, "utf8");
  const theme = await import(`${pathToFileURL(bundle).href}?test=${Date.now()}`);
  const runtime = await runtimeModule();
  replaceSnapshot({ ...snapshot, accentPreset: null });

  const localImplicitDefault = theme.Tba({ accentSource: "custom", accent: "#custom" }, "light", null);
  assert.equal(localImplicitDefault["--color-background-user-message"], "#blue-bubble");

  replaceSnapshot({ ...snapshot, accentPreset: "blue" });
  const localBlue = theme.Tba({ accentSource: "custom", accent: "#custom" }, "light", null);
  assert.equal(localBlue["--color-background-user-message"], "#blue-bubble");
  assert.notEqual(localBlue["--color-background-user-message"], "neutral-bubble");

  const accountGreen = theme.Tba({ accentSource: "chatgpt", accent: "#custom" }, "light", "green");
  assert.equal(accountGreen["--color-background-user-message"], "#green-bubble");
  const localWithAccountData = theme.Tba({ accentSource: "custom", accent: "#custom" }, "light", "green");
  assert.equal(localWithAccountData["--color-background-user-message"], "#blue-bubble");

  for (const preset of ["blue", "black"]) {
    replaceSnapshot({ ...snapshot, accentPreset: preset });
    const rendered = theme.Tba({ accentSource: "custom", accent: "#custom" }, "light", null);
    assert.equal(rendered["--color-background-user-message"], `#${preset}-bubble`);
  }
  replaceSnapshot({ ...snapshot, accentPreset: "default" });
  const localDefault = theme.Tba({ accentSource: "custom", accent: "#custom" }, "light", null);
  assert.equal(localDefault["--color-background-user-message"], "#blue-bubble");

  replaceSnapshot({ ...snapshot, accentPreset: "custom" });
  const localCustom = theme.Tba({ accentSource: "custom", accent: "#custom" }, "light", null);
  assert.equal(localCustom["--color-background-user-message"], "neutral-bubble");
});
