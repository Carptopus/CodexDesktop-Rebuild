const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  MODULE,
  SETTINGS_MARKER,
  THEME_MARKER,
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

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

async function runtimeModule() {
  return import(pathToFileURL(path.join(__dirname, "runtime", "accent-presets.mjs")).href);
}

test.afterEach(() => {
  delete globalThis.localStorage;
});

test("无账户主题时启用本地预设并保留加载态禁用", () => {
  const result = patchSettingsSource(settingsFixture());
  assert.equal(result.status, "patched", result.reason);
  assert.match(result.source, new RegExp(SETTINGS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.source, new RegExp(MODULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.source, /__codexCurrentAccent/);
  assert.match(result.source, /disabled:u===void 0/);
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
    (_accountTheme, fallback) => fallback,
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

test("本地设置、账户优先和自定义清理使用同一预设状态", async () => {
  const runtime = await runtimeModule();
  const storage = fakeStorage();
  globalThis.localStorage = storage;
  let localCalls = 0;
  let accountCalls = 0;
  let customValue = null;

  await runtime.selectAccentPreset(null, "blue", () => { localCalls++; }, () => { accountCalls++; });
  assert.equal(storage.values.get(runtime.ACCENT_PRESET_STORAGE_KEY), "blue");
  assert.equal(runtime.accentPresetSelection(null, "custom"), "blue");
  assert.equal(runtime.accentPresetSelection(undefined, "custom"), "custom");
  assert.equal(runtime.resolveAccentPreset("custom", null), "blue");
  assert.equal(localCalls, 1);
  assert.equal(accountCalls, 0);

  await runtime.selectAccentPreset({ chatTheme: "green" }, "green", () => { localCalls++; }, () => { accountCalls++; });
  assert.equal(storage.values.has(runtime.ACCENT_PRESET_STORAGE_KEY), false);
  assert.equal(accountCalls, 1);

  storage.values.set(runtime.ACCENT_PRESET_STORAGE_KEY, "blue");
  runtime.useCustomAccent(value => { customValue = value; }, "#123456");
  assert.equal(customValue, "#123456");
  assert.equal(storage.values.has(runtime.ACCENT_PRESET_STORAGE_KEY), false);
});

test("预设解析保留名称语义并拒绝无效本地值", async () => {
  const runtime = await runtimeModule();
  const storage = fakeStorage({ [runtime.ACCENT_PRESET_STORAGE_KEY]: "blue" });
  globalThis.localStorage = storage;
  assert.equal(runtime.resolveAccentPreset("custom", null), "blue");
  assert.equal(runtime.resolveAccentPreset("chatgpt", "green"), "green");
  assert.equal(runtime.resolveAccentPreset("custom", "green"), null);

  for (const preset of ["default", "blue", "black"]) {
    storage.values.set(runtime.ACCENT_PRESET_STORAGE_KEY, preset);
    assert.equal(runtime.resolveAccentPreset("custom", null), preset);
  }
  storage.values.set(runtime.ACCENT_PRESET_STORAGE_KEY, "not-a-preset");
  assert.equal(runtime.resolveAccentPreset("custom", null), null);
});

test("完整主题链复用官方预设气泡且账户主题优先", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-accent-theme-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, "runtime", "accent-presets.mjs"), path.join(directory, MODULE));
  const result = patchThemeSource(themeFixture());
  assert.equal(result.status, "patched", result.reason);
  const bundle = path.join(directory, "theme.mjs");
  fs.writeFileSync(bundle, result.source, "utf8");
  const theme = await import(`${pathToFileURL(bundle).href}?test=${Date.now()}`);
  const runtime = await runtimeModule();
  const storage = fakeStorage({ [runtime.ACCENT_PRESET_STORAGE_KEY]: "blue" });
  globalThis.localStorage = storage;

  const localBlue = theme.Tba({ accentSource: "custom", accent: "#custom" }, "light", null);
  assert.equal(localBlue["--color-background-user-message"], "#blue-bubble");
  assert.notEqual(localBlue["--color-background-user-message"], "neutral-bubble");

  const accountGreen = theme.Tba({ accentSource: "chatgpt", accent: "#custom" }, "light", "green");
  assert.equal(accountGreen["--color-background-user-message"], "#green-bubble");
  const accountCustom = theme.Tba({ accentSource: "custom", accent: "#custom" }, "light", "green");
  assert.equal(accountCustom["--color-background-user-message"], "neutral-bubble");

  for (const preset of ["default", "blue", "black"]) {
    storage.values.set(runtime.ACCENT_PRESET_STORAGE_KEY, preset);
    const rendered = theme.Tba({ accentSource: "custom", accent: "#custom" }, "light", null);
    assert.equal(rendered["--color-background-user-message"], `#${preset}-bubble`);
  }
});
