const test = require("node:test");
const assert = require("node:assert/strict");
const { HELPER, MARKER, STORAGE_KEY, patchSource } = require("./patch-accent-presets");

function fixture() {
  return 'import{palette as P,options as O}from"./app.js";' +
    'function Accent(e){let{theme:r,variant:i,onSelect:a,onCustomColorChange:o}=e,s=scope(),u=read(themeAtom),d=read(pendingAtom),' +
    'f=r.accentSource===`chatgpt`?u?.chatTheme??`default`:`custom`,v=f!==`custom`&&jsx(`span`,{style:{backgroundColor:P(u?.effectiveTheme??f,i)}}),' +
    'x=O.map(e=>jsx(RadioItem,{disabled:u==null,value:e,onSelect:()=>{let t=s.get(account),n=s.get(settings).data,r=t!=null&&n?.eligibleNowOrBefore===!0;' +
    'a(e,()=>{r&&sync({accentColor:e})}).catch(()=>{toast("chatgptAccentPicker.ChatGptAccentPicker.updateError")})},children:e},e)),' +
    'S=()=>o(r.accent),D=f===`custom`?jsx(ColorInput,{value:r.accent,onChange:o}):null;return [v,x,S,D]}' ;
}

function helpers() {
  return Function(`${HELPER};return {selection:__codexAccentSelection,select:__codexSelectAccent,custom:__codexUseCustomAccent}`)();
}

test("无账户主题时启用本地预设并保留加载态禁用", () => {
  const result = patchSource(fixture());
  assert.equal(result.status, "patched", result.reason);
  assert.match(result.source, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.source, /disabled:u===void 0/);
  assert.match(result.source, /__codexSelectAccent\(u,e,i,P,o,\(\)=>a\(/);
  assert.match(result.source, /onChange:__codexColor=>__codexUseCustomAccent\(o,__codexColor\)/);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("未知强调色结构明确失败", () => {
  const result = patchSource('const x="chatgptAccentPicker.ChatGptAccentPicker.updateError accentSource"');
  assert.equal(result.status, "unexpected-shape");
});

test("本地预设使用官方 CSS 色值，账户可用时仍调用官方同步", async () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: name => name === "--brand-blue-400" ? "#3A83F7" : "" });
  const { selection, select, custom } = helpers();
  let local = null;
  let synced = 0;

  await select(null, "blue", "light", () => "var(--brand-blue-400)", value => { local = value; }, () => { synced++; });
  assert.equal(local, "#3a83f7");
  assert.equal(synced, 0);
  assert.equal(values.get(STORAGE_KEY), "blue");
  assert.equal(selection(null, "custom", "custom"), "blue");

  await select({ chatTheme: "default" }, "green", "light", () => "#53b559", () => {}, () => { synced++; });
  assert.equal(synced, 1);
  assert.equal(values.has(STORAGE_KEY), false);

  values.set(STORAGE_KEY, "blue");
  custom(value => { local = value; }, "#123456");
  assert.equal(local, "#123456");
  assert.equal(values.has(STORAGE_KEY), false);
  delete globalThis.localStorage;
  delete globalThis.document;
  delete globalThis.getComputedStyle;
});
