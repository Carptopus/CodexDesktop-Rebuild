const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HOME_CURRENT_MARKER,
  LEGACY_MARKERS,
  MARKER,
  patchSource,
} = require("./patch-api-key-home-navigation");

function fixture() {
  return [
    "function Track(){",
    "let e=cache(),t=store(),n=location(),{accountId:r,authMethod:i}=auth(),",
    "a=mode()!==`legacy`,o=capability(),s=productMode(),l;",
    "e[0]!==r||e[1]!==i||e[2]!==a||e[3]!==o?",
    "(l=null,a&&o&&(i===`chatgpt`&&r!=null?l=`chatgpt:${r}`:i!=null&&(l=`auth:${i}`)),",
    "e[0]=r,e[1]=i,e[2]=a,e[3]=o,e[4]=l):l=e[4];",
    "track(t,{accountKey:l,location:n,productMode:s});return l",
    "}",
    "function restore(e,{accountKey:t,auth:n,area:r,navigate:i,productMode:a,state:o}){",
    "let s=e.get(AE),c=e.get(CH),u=remembered(e,{accountKey:t,auth:n,area:r,productMode:a});",
    "if(s&&c!=null&&same(c,r).hash===c.hash&&areaOf(e,c)===r&&e.get(PM)===a&&",
    "(c.state?.sidebarProductMode==null||c.state.sidebarProductMode===a))return!0;",
    "if(u==null||!s&&u.departedAt==null||areaOf(e,u.location)!==r){i(`/`);return!0}",
    "return s?nativeRestore(e,u,o):(i(u.location.pathname,{state:o}),!0)",
    "}",
    "function Rail(e,o){let d={id:`builtin:home`};return()=>restore(e,{...o,area:`home`})}",
  ].join("");
}

function loadTracker(source, authValue, capabilityValue, modeValue = "current") {
  return Function("authValue", "capabilityValue", "modeValue", [
    "const cache=()=>[];const store=()=>({});const location=()=>({});",
    "const auth=()=>authValue;const mode=()=>modeValue;const capability=()=>capabilityValue;",
    "const productMode=()=>`codex`;const track=()=>{};",
    source,
    "return Track();",
  ].join(""))(authValue, capabilityValue, modeValue);
}

function clickHome(source, {
  accountKey = "auth:apikey",
  capability = false,
  currentArea = "home",
  rememberedArea = "home",
  rememberedDepartedAt = 1,
  rememberedPath = "/thread/remembered",
  hasRemembered = true,
} = {}) {
  const navigations = [];
  const current = currentArea == null ? null : {
    area: currentArea,
    hash: `same`,
    state: { sidebarProductMode: "codex" },
  };
  const rememberedValue = hasRemembered ? {
    departedAt: rememberedDepartedAt,
    location: { area: rememberedArea, pathname: rememberedPath },
  } : null;
  const activeStore = {
    get(key) {
      if (key === "AE") return capability;
      if (key === "CH") return current;
      if (key === "PM") return "codex";
      return null;
    },
  };
  const invoke = Function("activeStore", "accountKey", "rememberedValue", "recordNavigation", [
    "const AE=`AE`,CH=`CH`,PM=`PM`;",
    "const cache=()=>[];const store=()=>({});const location=()=>({});",
    "const auth=()=>({accountId:null,authMethod:`apikey`});const mode=()=>`current`;",
    "const capability=()=>false,productMode=()=>`codex`,track=()=>{};",
    "const remembered=()=>rememberedValue;const same=()=>({hash:`same`});",
    "const areaOf=(_store,value)=>value.area;const nativeRestore=()=>true;",
    source,
    "return Rail(activeStore,{accountKey,auth:{},navigate:path=>recordNavigation(path),",
    "productMode:`codex`,state:{}})();",
  ].join(""));
  invoke(activeStore, accountKey, rememberedValue, path => navigations.push(path));
  return navigations;
}

test("API-key 在 ChatGPT capability 关闭时仍写入与读取端一致的 accountKey", () => {
  const result = patchSource(fixture());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(MARKER));
  assert.match(result.source, /\(a&&o\|\|\/\* Codex：API-key 首页恢复写入。 \*\/i===`apikey`\)&&/);
  assert.equal(loadTracker(result.source, { accountId: null, authMethod: "apikey" }, false),
    "auth:apikey");
  assert.equal(loadTracker(result.source, { accountId: null, authMethod: "apikey" }, false, "legacy"),
    "auth:apikey");
});

test("builtin:home 通过公共恢复函数保持 API-key 当前首页会话", () => {
  const result = patchSource(fixture());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes("builtin:home"));
  assert.ok(result.source.includes(HOME_CURRENT_MARKER));
  assert.match(result.source,
    /\(s\|\|\/\* Codex：API-key 首页保持当前位置。 \*\/t===`auth:apikey`&&r===`home`\)&&c!=null/);
  assert.deepEqual(clickHome(result.source), []);
});

test("API-key 从设置页进入首页时恢复已记录的会话", () => {
  const result = patchSource(fixture());

  assert.deepEqual(clickHome(result.source, { currentArea: "settings" }), ["/thread/remembered"]);
});

test("API-key 没有首页记录时保留官方根路由 fallback", () => {
  const result = patchSource(fixture());

  assert.deepEqual(clickHome(result.source, { currentArea: "settings", hasRemembered: false }), ["/"]);
});

test("ChatGPT capability 可用时保持官方当前首页短路", () => {
  const result = patchSource(fixture());

  assert.deepEqual(clickHome(result.source, {
    accountKey: "chatgpt:account-1",
    capability: true,
  }), []);
});

test("ChatGPT capability 不可用时不会获得 API-key 特例", () => {
  const result = patchSource(fixture());

  assert.deepEqual(clickHome(result.source, {
    accountKey: "chatgpt:account-1",
    capability: false,
    rememberedDepartedAt: null,
  }), ["/"]);
});

test("其他认证方式不会获得 API-key 特例", () => {
  const result = patchSource(fixture());

  assert.deepEqual(clickHome(result.source, {
    accountKey: "auth:chatgptAuthTokens",
    rememberedDepartedAt: null,
  }), ["/"]);
});

test("API-key 的非首页区域不会获得首页当前位置特例", () => {
  const result = patchSource(fixture());
  const direct = result.source.replace("area:`home`", "area:`scheduled`");

  assert.deepEqual(clickHome(direct, {
    currentArea: "scheduled",
    rememberedArea: "scheduled",
    rememberedDepartedAt: null,
  }), ["/"]);
});

test("补丁可重复执行且不重复修改", () => {
  const patched = patchSource(fixture());
  const repeated = patchSource(patched.source);

  assert.equal(repeated.status, "already-patched");
  assert.equal(repeated.source, patched.source);
  assert.equal(repeated.source.split(MARKER).length - 1, 1);
  assert.equal(repeated.source.split(HOME_CURRENT_MARKER).length - 1, 1);
});

test("只有写入端改动的不完整补丁会被拒绝", () => {
  const incomplete = fixture().replace("a&&o&&",
    `(a&&o||${MARKER}i===\`apikey\`)&&`);
  const result = patchSource(incomplete);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /只完成了一部分/);
});

test("公共恢复条件缺失 home 限定时会被拒绝", () => {
  const patched = patchSource(fixture());
  const incomplete = patched.source.replace("&&r===`home`", "");
  const result = patchSource(incomplete);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /当前位置逻辑不完整/);
});

test("没有本项目标记的同形逻辑会被拒绝", () => {
  const patched = patchSource(fixture());
  const unmarked = patched.source.replace(HOME_CURRENT_MARKER, "");
  const result = patchSource(unmarked);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /缺少本项目标记/);
});

for (const marker of LEGACY_MARKERS) {
  test(`检测并拒绝旧入口级补丁：${marker}`, () => {
    const source = fixture().replace("function Rail", `${marker}function Rail`);
    const result = patchSource(source);

    assert.equal(result.status, "unexpected-shape");
    assert.match(result.reason, /旧入口级首页补丁/);
    assert.equal(result.source, source);
  });
}

test("ChatGPT 登录继续遵守官方 capability 与账户条件", () => {
  const result = patchSource(fixture());

  assert.equal(loadTracker(result.source,
    { accountId: "account-1", authMethod: "chatgpt" }, true), "chatgpt:account-1");
  assert.equal(loadTracker(result.source,
    { accountId: "account-1", authMethod: "chatgpt" }, false), null);
  assert.equal(loadTracker(result.source,
    { accountId: "account-1", authMethod: "chatgpt" }, true, "legacy"), null);
});

test("未认证及其他认证方式不会因写入补丁越过 capability", () => {
  const result = patchSource(fixture());

  assert.equal(loadTracker(result.source, { accountId: null, authMethod: null }, false), null);
  assert.equal(loadTracker(result.source,
    { accountId: null, authMethod: "chatgptAuthTokens" }, false), null);
  assert.equal(loadTracker(result.source,
    { accountId: null, authMethod: "chatgptAuthTokens" }, true), "auth:chatgptAuthTokens");
});

test("首页导航目标不唯一时明确失败", () => {
  const duplicate = fixture().replaceAll("Track", "Track2")
    .replaceAll("restore", "restore2").replaceAll("Rail", "Rail2");
  const source = fixture() + duplicate;
  const result = patchSource(source);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /首页导航跟踪器.*2|公共首页恢复当前位置分支.*2/);
  assert.equal(result.source, source);
});

test("无关 Bundle 保持不变", () => {
  const source = "function unrelated(){return `home`}";
  const result = patchSource(source);

  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});
