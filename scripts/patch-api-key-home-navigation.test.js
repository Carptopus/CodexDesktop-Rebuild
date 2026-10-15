const test = require("node:test");
const assert = require("node:assert/strict");

const { CURRENT_HOME_MARKER, MARKER, patchSource } = require("./patch-api-key-home-navigation");

function fixture() {
  return [
    "function Lhc(){",
    "let e=cache(),t=store(),n=location(),{accountId:r,authMethod:i}=mp(),",
    "a=mode()!==`legacy`,o=capability(),s=productMode(),c=project(),l;",
    "e[0]!==r||e[1]!==i||e[2]!==a||e[3]!==o?",
    "(l=null,a&&o&&(i===`chatgpt`&&r!=null?l=`chatgpt:${r}`:i!=null&&(l=`auth:${i}`)),",
    "e[0]=r,e[1]=i,e[2]=a,e[3]=o,e[4]=l):l=e[4];",
    "yti(t,{accountKey:l,location:n,productMode:s});return l",
    "}",
    "function Sti(e,{accountKey:t,auth:n,area:r,navigate:i,productMode:a,state:o}){",
    "let s=e.get(wc),c=e.get(Ug),u=bti(e,{accountKey:t,auth:n,area:r,productMode:a});",
    "if(s&&c!=null&&sti(c,r).hash===c.hash&&Ati(e,c)===r&&e.get(lj)===a&&",
    "(c.state?.sidebarProductMode==null||c.state.sidebarProductMode===a))return!0;",
    "if(u==null||!s&&u.departedAt==null||Ati(e,u.location)!==r){i(`/`);return!0}",
    "return i(ym(u.location)),!0}",
  ].join("");
}

function load(source, auth, capability, modeValue = "current") {
  return Function("auth", "capabilityValue", "modeValue", [
    "const cache=()=>[];const store=()=>({});const location=()=>({});",
    "const mp=()=>auth;const mode=()=>modeValue;const capability=()=>capabilityValue;",
    "const productMode=()=>`codex`;const project=()=>null;const yti=()=>{};",
    source,
    "return Lhc();",
  ].join(""))(auth, capability, modeValue);
}

test("API-key 在 ChatGPT capability 关闭时仍写入与读取端一致的 accountKey", () => {
  const result = patchSource(fixture());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(MARKER));
  assert.match(result.source, /\(a&&o\|\|\/\* Codex：API-key 首页恢复写入。 \*\/i===`apikey`\)&&/);
  assert.equal(load(result.source, { accountId: null, authMethod: "apikey" }, false), "auth:apikey");
  assert.equal(load(result.source, { accountId: null, authMethod: "apikey" }, false, "legacy"), "auth:apikey");
  assert.equal(patchSource(result.source).status, "already-patched");
});

function restore(source, accountKey, {
  currentPath = "/local/thread-1",
  saved = { departedAt: null, location: { pathname: "/local/thread-1" } },
} = {}) {
  const navigations = [];
  const current = currentPath == null ? null : { hash: "", pathname: currentPath, state: null };
  const store = {
    get(key) {
      if (key === "wc") return false;
      if (key === "Ug") return current;
      if (key === "lj") return "codex";
      return null;
    },
  };
  const run = Function("store", "navigate", "accountKey", "saved", [
    "const wc=`wc`,Ug=`Ug`,lj=`lj`;",
    "const bti=()=>saved;",
    "const sti=location=>({hash:location.hash??``});",
    "const Ati=(_store,location)=>location.pathname===`/`||location.pathname.startsWith(`/local/`)?`home`:null;",
    "const ym=location=>location.pathname;",
    source,
    "return Sti(store,{accountKey,area:`home`,navigate,productMode:`codex`});",
  ].join(""));
  return { navigations, value: run(store, path => navigations.push(path), accountKey, saved) };
}

test("API-key 旧导航模式下点击首页保持当前会话", () => {
  const result = patchSource(fixture());
  const restored = restore(result.source, "auth:apikey");

  assert.ok(result.source.includes(CURRENT_HOME_MARKER));
  assert.equal(restored.value, true);
  assert.deepEqual(restored.navigations, []);
});

test("API-key 根路径不短路，保留官方空数据落地页导航", () => {
  const result = patchSource(fixture());
  const restored = restore(result.source, "auth:apikey", {
    currentPath: "/",
    saved: null,
  });

  assert.equal(restored.value, true);
  assert.deepEqual(restored.navigations, ["/"]);
});

test("API-key 尚无当前路由时不访问空对象", () => {
  const result = patchSource(fixture());
  const restored = restore(result.source, "auth:apikey", {
    currentPath: null,
    saved: null,
  });

  assert.equal(restored.value, true);
  assert.deepEqual(restored.navigations, ["/"]);
});

test("ChatGPT 旧导航模式不获得当前首页短路", () => {
  const result = patchSource(fixture());
  const restored = restore(result.source, "chatgpt:account-1");

  assert.equal(restored.value, true);
  assert.deepEqual(restored.navigations, ["/"]);
});

test("API-key 从设置页仍恢复已经离开的首页会话", () => {
  const result = patchSource(fixture());
  const restored = restore(result.source, "auth:apikey", {
    currentPath: "/settings/appearance",
    saved: { departedAt: Date.now(), location: { pathname: "/local/thread-1" } },
  });

  assert.equal(restored.value, true);
  assert.deepEqual(restored.navigations, ["/local/thread-1"]);
});

test("ChatGPT 登录继续遵守官方 capability 与账户条件", () => {
  const result = patchSource(fixture());

  assert.equal(load(result.source, { accountId: "account-1", authMethod: "chatgpt" }, true), "chatgpt:account-1");
  assert.equal(load(result.source, { accountId: "account-1", authMethod: "chatgpt" }, false), null);
  assert.equal(load(result.source, { accountId: "account-1", authMethod: "chatgpt" }, true, "legacy"), null);
  assert.equal(load(result.source, { accountId: null, authMethod: "chatgpt" }, true), "auth:chatgpt");
});

test("旧版只绕过 capability 的不完整补丁会被拒绝", () => {
  const incomplete = fixture().replace(
    "a&&o&&",
    `a&&(o||${MARKER}i===\`apikey\`)&&`,
  );
  const result = patchSource(incomplete);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /导航模式与 ChatGPT capability/);
});

test("未认证及其他认证方式不会因补丁越过 capability", () => {
  const result = patchSource(fixture());

  assert.equal(load(result.source, { accountId: null, authMethod: null }, false), null);
  assert.equal(load(result.source, { accountId: null, authMethod: "chatgptAuthTokens" }, false), null);
  assert.equal(load(result.source, { accountId: null, authMethod: "chatgptAuthTokens" }, true), "auth:chatgptAuthTokens");
});

test("导航跟踪器不唯一时明确失败", () => {
  const source = fixture() + fixture().replaceAll("Lhc", "Mhc").replaceAll("Sti", "Tti");
  const result = patchSource(source);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /首页导航跟踪器.*2/);
  assert.equal(result.source, source);
});

test("无关 Bundle 保持不变", () => {
  const source = "function unrelated(){return `home`}";
  const result = patchSource(source);

  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});
