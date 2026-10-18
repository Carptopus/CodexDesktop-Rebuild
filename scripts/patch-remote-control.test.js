const assert = require("node:assert/strict");
const test = require("node:test");

const { MARKER, patchSource, validatePatchedSource } = require("./patch-remote-control");

function fixture() {
  return [
    "function remoteSync(){let e=(0,cache.c)(4),t=get(Container),[n]=shared(`local_remote_control_enabled`),r,i;return e[0]!==n||e[1]!==t?(r=()=>{n!=null&&sync(t,n).catch(e=>{handle(t,e),log.error(`Failed to sync local remote control enablement`,{error:e})})},i=[n,t],e[0]=n,e[1]=t,e[2]=r,e[3]=i):(r=e[2],i=e[3]),react.useEffect(r,i),null}",
    "var cache,react;",
    "function remoteInit(){return(remoteInit=once((()=>{cache=compiled(),base(),react=reactModule(),sharedInit(),syncInit()})))()}",
    "function serviceTier(e){let t=(0,serviceCache.c)(10),n=useAtom(defaultHost),r=e?.hostId??n,i=useHostAuth(r),a=i?.authMethod===`apikey`?`apikey`:(i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`),o=i?.authMethod??null,s={authMethod:o,hostId:r},c={serviceTierAccess:a,isLoading:!!i?.isLoading};return c}",
    "var serviceCache;",
    "function serviceInit(){return(serviceInit=once((()=>{serviceCache=compiled(),atomInit(),hostInit(),authInit()})))()}",
  ].join("");
}

test("API-key 清除旧启用值并禁用 Remote Control，ChatGPT 保留官方同步", () => {
  const result = patchSource(fixture());
  assert.equal(result.status, "patched", result.reason);
  validatePatchedSource(result.source);
  assert.equal(result.source.split(MARKER).length - 1, 1);
  assert.match(result.source, /__codexRemoteAuth\?\.authMethod!==`chatgpt`/);
  assert.match(result.source, /n===!0&&__codexSetRemoteEnabled\(!1\),sync\(t,!1\)/);
  assert.match(result.source, /n!=null&&sync\(t,n\)/);
  assert.match(result.source, /function remoteInit\(\).*serviceInit\(\),/);
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
