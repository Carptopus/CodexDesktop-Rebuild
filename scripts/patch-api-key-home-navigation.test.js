const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HOME_CURRENT_MARKER,
  HOME_RESTORE_MARKER,
  HOME_STATE_MARKER,
  INVALID_TRACKER_MARKER,
  LEGACY_MARKERS,
  MARKER,
  patchSource,
} = require("./patch-api-key-home-navigation");

function fixture() {
  return fixtureParts().join("");
}

function fixtureParts() {
  return [
    "function Track(){",
    "let e=cache(),t=store(),n=location(),{accountId:r,authMethod:i}=auth(),",
    "a=mode()!==`legacy`,o=capability(),s=productMode(),l;",
    "e[0]!==r||e[1]!==i||e[2]!==a||e[3]!==o?",
    "(l=null,a&&o&&(i===`chatgpt`&&r!=null?l=`chatgpt:${r}`:i!=null&&(l=`auth:${i}`)),",
    "e[0]=r,e[1]=i,e[2]=a,e[3]=o,e[4]=l):l=e[4];",
    "track(t,{accountKey:l,location:n,productMode:s});return l",
    "}",
    "function Active(){let t=cache(17),n=store(),r=location(),i=useContext(Ctx),a=q(capability()),o=q(productMode()),s=q(project()),c=auth(),{accountId:l,authMethod:u,isLoading:d,userId:f}=c,p=null,m=i?.activeDestinationId??null,h;t[0]?h=()=>{QBa(n,{accountKey:p,auth:c,location:r,productMode:o,destinationId:m})}:h=t[7];let g;return (0,react.useLayoutEffect)(h,g),null}",
    "function restore(e,{accountKey:t,auth:n,area:r,navigate:i,productMode:a,state:o}){",
    "let s=e.get(AE),c=e.get(CH),u=remembered(e,{accountKey:t,auth:n,area:r,productMode:a});",
    "if(s&&c!=null&&same(c,r).hash===c.hash&&areaOf(e,c)===r&&e.get(PM)===a&&",
    "(c.state?.sidebarProductMode==null||c.state.sidebarProductMode===a))return!0;",
    "if(u==null||!s&&u.departedAt==null||areaOf(e,u.location)!==r){i(`/`);return!0}",
    "return s?nativeRestore(e,u,o):(i(u.location.pathname,{state:o}),!0)",
    "}",
    "function Rail(e,o){let d={id:`builtin:home`};return()=>restore(e,{...o,area:`home`})}",
  ];
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
  sidebarThreadLocationId = "chats",
  rememberedArea = "home",
  rememberedDepartedAt = 1,
  rememberedPath = "/thread/remembered",
  hasRemembered = true,
} = {}) {
  const navigations = [];
  const current = currentArea == null ? null : {
    area: currentArea === "home" ? null : currentArea,
    hash: `same`,
    pathname: currentArea === "settings" ? "/settings/general" : "/thread/current",
    state: { sidebarProductMode: "codex", sidebarThreadLocationId },
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
    "const areaOf=(_store,value)=>value.area;",
    "const nativeRestore=(_store,record)=>{recordNavigation(record.location.pathname);return true};",
    source,
    "return Rail(activeStore,{accountKey,auth:{},navigate:path=>recordNavigation(path),",
    "productMode:`codex`,state:{}})();",
  ].join(""));
  invoke(activeStore, accountKey, rememberedValue, path => navigations.push(path));
  return navigations;
}

test("API-key 在活动导航记录器写入真实会话", () => {
  const result = patchSource(fixture());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(MARKER));
  assert.match(result.source, /Codex：API-key 首页记录真实会话。 \*\/if\(u===`apikey`&&r\.state\?\.sidebarThreadLocationId!=null\)\{n\.set\(m,r\.pathname\);\}/);
  assert.doesNotMatch(result.source, /首页恢复写入/);
});

test("官方导航记录器保留 ChatGPT 条件并在 API-key 下记录真实会话", () => {
  const active = patchSource(fixture()).source.split("function Active(){")[1].split("function restore")[0];
  const statement = active.match(/if\(([A-Za-z_$][\w$]*)===`apikey`&&([A-Za-z_$][\w$]*)\.state\?\.sidebarThreadLocationId!=null\)\{([A-Za-z_$][\w$]*)\.set\(([A-Za-z_$][\w$]*),\2\.pathname\);\}/);
  assert.ok(statement, "API-key 记录语句应位于官方活动导航目标回调中");
  const [, authMethod, current, store, destination] = statement;
  const target = {};
  const location = { pathname: "/local/thread-1", state: { sidebarThreadLocationId: "thread-1" } };
  const run = method => Function("method", "current", "store", "destination", "target",
    `if(method===\"apikey\"&&current.state?.sidebarThreadLocationId!=null){target.local=current.pathname}`)
    (method, location, target, "local", target);
  run("apikey");
  assert.equal(target.local, "/local/thread-1");
  delete target.local;
  run("chatgptAuthTokens");
  assert.equal(target.local, undefined);
});

test("builtin:home 通过公共恢复函数保持 API-key 当前首页会话", () => {
  const result = patchSource(fixture());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes("builtin:home"));
  assert.ok(result.source.includes(HOME_CURRENT_MARKER));
  assert.ok(result.source.includes(HOME_STATE_MARKER));
  assert.ok(result.source.includes(HOME_RESTORE_MARKER));
  assert.match(result.source,
    /same\(c,r\)\.hash===c\.hash&&\(areaOf\(e,c\)===r\|\|\/\* Codex：API-key 首页保持当前。 \*\/c\.state\?\.sidebarThreadLocationId!=null\)/);
  assert.deepEqual(clickHome(result.source), []);
});

test("API-key 当前会话位于真实空首页分类时仍保持当前位置", () => {
  const result = patchSource(fixture());

  assert.deepEqual(clickHome(result.source, {
    currentArea: "home",
    sidebarThreadLocationId: "chats",
  }), []);
  assert.deepEqual(clickHome(result.source, {
    currentArea: "home",
    sidebarThreadLocationId: null,
    rememberedDepartedAt: null,
  }), ["/"]);
});

test("API-key 从设置页进入首页时恢复已记录的会话", () => {
  const result = patchSource(fixture());

  assert.deepEqual(clickHome(result.source, {
    currentArea: "settings",
    sidebarThreadLocationId: null,
  }), ["/thread/remembered"]);
});

test("API-key 没有首页记录时保留官方根路由 fallback", () => {
  const result = patchSource(fixture());

  assert.deepEqual(clickHome(result.source, {
    currentArea: "scheduled",
    sidebarThreadLocationId: null,
    hasRemembered: false,
  }), ["/"]);
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
  assert.equal(repeated.source.split(HOME_STATE_MARKER).length - 1, 1);
  assert.equal(repeated.source.split(HOME_RESTORE_MARKER).length - 1, 1);
});

test("上一版无效首页补丁明确拒绝，不自动剥离或修补", () => {
  const source = fixture().replace("function Rail", `${INVALID_TRACKER_MARKER}function Rail`);
  const result = patchSource(source);
  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /上一版首页恢复补丁/);
  assert.equal(result.source, source);
});

test("公共恢复条件缺少真实会话状态判据时会被拒绝", () => {
  const patched = patchSource(fixture());
  const incomplete = patched.source.replace(
    "&&(areaOf(e,c)===r||/* Codex：API-key 首页保持当前。 */c.state?.sidebarThreadLocationId!=null)", "");
  const result = patchSource(incomplete);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /补丁标记存在但首页导航结构未知|标记与结构不一致|逻辑不完整|缺少本项目标记/);
});

test("没有本项目标记的同形逻辑会被拒绝", () => {
  const patched = patchSource(fixture());
  const unmarked = patched.source.replace(HOME_CURRENT_MARKER, "");
  const unmarkedFirst = unmarked.replace(MARKER, "");
  const result = patchSource(unmarkedFirst);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /标记与结构不一致|缺少本项目标记|首页导航目标.*数量异常|公共首页恢复当前位置逻辑不完整/);
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
    .replaceAll("restore", "restore2").replaceAll("Rail", "Rail2")
    .replaceAll("Active", "Active2");
  const source = fixture() + duplicate;
  const result = patchSource(source);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /首页真实会话跟踪器.*2|首页活动目标跟踪器\s*数量异常（0|2）|公共首页恢复当前位置分支.*2|补丁标记存在但首页导航结构未知/);
  assert.equal(result.source, source);
});

test("无关 Bundle 保持不变", () => {
  const source = "function unrelated(){return `home`}";
  const result = patchSource(source);

  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});
