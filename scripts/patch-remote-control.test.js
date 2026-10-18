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
