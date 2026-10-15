const test = require("node:test");
const assert = require("node:assert/strict");

const { MARKER, patchSource } = require("./patch-api-key-home-navigation");

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
  ].join("");
}

function load(source, auth, capability) {
  return Function("auth", "capabilityValue", [
    "const cache=()=>[];const store=()=>({});const location=()=>({});",
    "const mp=()=>auth;const mode=()=>`current`;const capability=()=>capabilityValue;",
    "const productMode=()=>`codex`;const project=()=>null;const yti=()=>{};",
    source,
    "return Lhc();",
  ].join(""))(auth, capability);
}

test("API-key 在 ChatGPT capability 关闭时仍写入与读取端一致的 accountKey", () => {
  const result = patchSource(fixture());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(MARKER));
  assert.equal(load(result.source, { accountId: null, authMethod: "apikey" }, false), "auth:apikey");
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("ChatGPT 登录继续遵守官方 capability 与账户条件", () => {
  const result = patchSource(fixture());

  assert.equal(load(result.source, { accountId: "account-1", authMethod: "chatgpt" }, true), "chatgpt:account-1");
  assert.equal(load(result.source, { accountId: "account-1", authMethod: "chatgpt" }, false), null);
  assert.equal(load(result.source, { accountId: null, authMethod: "chatgpt" }, true), "auth:chatgpt");
});

test("未认证及其他认证方式不会因补丁越过 capability", () => {
  const result = patchSource(fixture());

  assert.equal(load(result.source, { accountId: null, authMethod: null }, false), null);
  assert.equal(load(result.source, { accountId: null, authMethod: "chatgptAuthTokens" }, false), null);
  assert.equal(load(result.source, { accountId: null, authMethod: "chatgptAuthTokens" }, true), "auth:chatgptAuthTokens");
});

test("导航跟踪器不唯一时明确失败", () => {
  const source = fixture() + fixture().replaceAll("Lhc", "Mhc");
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
