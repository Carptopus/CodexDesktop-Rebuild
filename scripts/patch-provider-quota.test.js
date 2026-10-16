const test = require("node:test");
const assert = require("node:assert/strict");

const { MARKER, getProviderMetadata, patchSource } = require("./patch-provider-quota");

function fixture() {
  return [
    "import{provider as threadProvider,quota as quotaAtom,hard as hardBlockAtom,host as hostAtom}from'./initial.js';",
    "function providerFor(store,id,config){return store.get(threadProvider,id)??config.model_provider}",
    "function Composer(props){",
    "let{submitDisabled:external}=props,scope=useScope(),conversation=currentConversation(),host=read(hostAtom,conversation),context;",
    "cacheMiss()?(context=conversation==null?null:{conversationId:conversation,hostId:host}):context=cached();",
    "let accountQuota=read(quotaAtom,context),config=useConfig(target),hardQuota=value(host===`local`&&hardBlockAtom);",
    "let disabled=external||accountQuota||config.isLoading||hardQuota;",
    "save(config.isConfigDataPending?null:config.resolvedConfig,scope.value.kind);",
    "return jsx(Editor,{submitDisabled:disabled})",
    "}",
  ].join("");
}

test("按新版 Composer 数据流隔离第三方 Provider 的官方额度门槛", () => {
  const result = patchSource(fixture());

  assert.equal(result.status, "patched", result.reason);
  assert.ok(result.code.includes(MARKER));
  assert.match(result.code, /const __codexQuotaThreadProvider=read\(threadProvider,conversation\)/);
  assert.match(result.code, /\(!__codexUsesCustomProvider&&accountQuota\)/);
  assert.match(result.code, /\(!__codexUsesCustomProvider&&hardQuota\)/);
  assert.equal(patchSource(result.code).status, "already");
});

test("多个 Provider 读取仍要求指向同一个会话 Provider atom", () => {
  const source = fixture().replace(
    "function Composer(props){",
    "function another(get,id,config){return get(threadProvider,id)??config.model_provider}function Composer(props){",
  );

  assert.equal(getProviderMetadata(source).threadProviderAtom, "threadProvider");
  const result = patchSource(source);
  assert.equal(result.status, "patched", result.reason);
});

test("会话 Provider atom 不唯一时拒绝补丁", () => {
  const source = fixture().replace(
    "function Composer(props){",
    "function other(get,id,config){return get(otherProvider,id)??config.model_provider}function Composer(props){",
  );
  const result = patchSource(source);

  assert.equal(result.status, "error");
  assert.match(result.reason, /thread-provider lookup is ambiguous/);
});
