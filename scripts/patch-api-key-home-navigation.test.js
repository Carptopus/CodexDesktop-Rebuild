const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const acorn = require("acorn");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  HOME_CURRENT_MARKER,
  HOME_RESTORE_MARKER,
  HOME_STATE_MARKER,
  INVALID_TRACKER_MARKER,
  LEGACY_MARKERS,
  MARKER,
  patchSource,
} = require("./patch-api-key-home-navigation");

// 可选的官方资源功能验收；输入只读，直接执行已补丁的真实函数。
test("26.1016 真实 Bundle：首页记录、离开及完整状态恢复", {
  skip: !process.env.CODEX_PATCH_REAL_BUNDLE,
}, () => {
  const source = fs.readFileSync(process.env.CODEX_PATCH_REAL_BUNDLE, "utf8");
  const result = patchSource(source);
  assert.equal(result.status, "patched", result.reason);
  const again = patchSource(result.source);
  assert.equal(again.status, "already-patched", again.reason);
  assert.equal(again.source, result.source);
  const ast = acorn.parse(result.source, { ecmaVersion: "latest", sourceType: "module" });
  const functions = ["mEc", "uKa", "CKa", "xKa", "SKa", "$Ga", "eKa", "dKa", "pKa", "mKa", "bKa"]
    .map(name => {
      const matches = ast.body.filter(node => node.type === "FunctionDeclaration" && node.id.name === name);
      assert.equal(matches.length, 1, `真实函数 ${name} 必须唯一`);
      return result.source.slice(matches[0].start, matches[0].end);
    }).join("\n");
  const harness = Function("assert", `
    const atoms=Object.fromEntries(["jE","HE","EL","hC","sC","DKa","EKa","CD","OL","tg","Gy","kw","Aw","Ow","fEc"].map(id=>[id,{id}]));
    const {jE,HE,EL,hC,sC,DKa,EKa,CD,OL,tg,Gy,kw,Aw,Ow,fEc}=atoms;
    const values=new Map([[jE,false],[EL,"codex"],[hC,{projectId:"sample"}],[sC,{}]]),records=new Map();
    const store={get(atom,partition){assert.ok(atom?.id,"get 必须使用 atom");return atom===EKa?(records.get(partition)||{}):values.get(atom)},
      set(atom,...args){assert.ok(atom?.id,"set 必须使用 atom");if(atom===EKa)records.set(args[0],args[1]);else values.set(atom,args[0])}};
    let current,navigated=null;const auth={authMethod:"apikey"};
    values.set(CD,{prepareNavigation:(pathname,options)=>()=>{navigated={pathname,...options}}});
    const J={},uEc={},hEc={c:()=>[]},gEc={useContext:()=>null,useLayoutEffect:fn=>fn()};
    const E=()=>store,Wa=()=>current,DT=()=>auth,Z=atom=>store.get(atom);
    const gL={home:{destinationId:"builtin:home"}},Ty="/",wKa=480000;
    const qke={},Ewe={},BI="/review",ia=()=>null,no=()=>false,nOe=()=>null;
    const eb=({pathname})=>({routeKind:pathname.startsWith("/settings")?"other":"home"});
    const Me=location=>location.pathname,Cwn=()=>{};
    ${functions}
    return {visit(location){current=location;values.set(HE,location);mEc()},
      click(){navigated=null;pKa(store,{accountKey:"auth:apikey",auth,area:"home",navigate:pathname=>{navigated={pathname}},productMode:"codex",state:{}});return navigated},
      record(){return records.get("auth:apikey:codex")?.["builtin:home"]}};
  `)(assert);
  const thread = { pathname: "/local/sample-thread", key: "thread", search: "", hash: "",
    state: { sidebarThreadLocationId: "chats", sidebarProductMode: "codex", sidebarProductModeAccountKey: "auth:apikey" } };
  harness.visit(thread);
  assert.equal(harness.record().location.pathname, thread.pathname);
  assert.equal(harness.record().departedAt, null);
  assert.equal(harness.click(), null);
  harness.visit({ pathname: "/settings/general", key: "settings", search: "", hash: "", state: null });
  assert.equal(harness.record().location.pathname, thread.pathname);
  assert.ok(harness.record().departedAt > 0);
  const restored = harness.click();
  assert.equal(restored.pathname, thread.pathname);
  assert.equal(restored.state.sidebarThreadLocationId, "chats");
  assert.equal(restored.state.sidebarProductModeAccountKey, "auth:apikey");
});

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
  assert.match(result.source, /QBa\(n,\{accountKey:`auth:apikey`,auth:c,location:r,productMode:o\}\);return;/);
  assert.doesNotMatch(result.source, /n\.set\(m,r\.pathname\)/);
  assert.doesNotMatch(result.source, /首页恢复写入/);
});

test("活动回调在会话和设置页都委托官方记录器，且不向仓库传入导航 ID", () => {
  const source = patchSource(fixture()).source;
  const calls = [];
  const activeStore = { set() { assert.fail("不能将导航 ID 当作 atom 写入仓库"); } };
  const invoke = Function("current", "method", "activeStore", "record", [
    "const cache=()=>[true],store=()=>activeStore,location=()=>current;",
    "const useContext=()=>({activeDestinationId:null}),Ctx={},q=x=>x;",
    "const capability=()=>false,productMode=()=>`codex`,project=()=>null;",
    "const auth=()=>({authMethod:method}),QBa=record;",
    "const react={useLayoutEffect:callback=>callback()};",
    source,
    "Active();",
  ].join(""));
  for (const current of [
    { pathname: "/local/thread-1", state: { sidebarThreadLocationId: "chats" } },
    { pathname: "/settings/general", state: null },
  ]) {
    invoke(current, "apikey", activeStore, (store, options) => calls.push({ store, options }));
    const call = calls.at(-1);
    assert.equal(call.store, activeStore);
    assert.equal(call.options.accountKey, "auth:apikey");
    assert.equal(call.options.auth.authMethod, "apikey");
    assert.equal(call.options.location, current);
    assert.equal(call.options.productMode, "codex");
    assert.equal(Object.hasOwn(call.options, "destinationId"), false);
  }
  assert.equal(calls.length, 2, "每次路由变化只调用一次官方记录器");
});

test("拒绝曾导致真实 API-key 页面崩溃的旧写入补丁", () => {
  const broken = fixture().replace("function Rail", "/* Codex：API-key 首页记录真实会话。 */function Rail");
  const result = patchSource(broken);
  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /错误的状态仓库写入/);
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

test("CLI 从共享账户字段的多个 chunk 中选择唯一完整首页链路", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-chunks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "win", "_asar", "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  const unrelated = "const account={authMethod:`apikey`,accountKey:`auth:apikey`,productMode:`codex`,auth:`chatgpt:`};";
  const shared = path.join(assets, "app-shared-test.js");
  const primary = path.join(assets, "app-primary-test.js");
  fs.writeFileSync(shared, unrelated);
  fs.writeFileSync(primary, fixture());
  const run = check => spawnSync(process.execPath,
    [path.join(__dirname, "patch-api-key-home-navigation.js"), "win", ...(check ? ["--check"] : [])],
    { encoding: "utf8", env: { ...process.env, CODEX_PATCH_SOURCE_DIR: root } });
  const checked = run(true);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(fs.readFileSync(primary, "utf8"), fixture());
  const applied = run(false);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const patched = fs.readFileSync(primary, "utf8");
  assert.ok(patched.includes(MARKER));
  assert.equal(fs.readFileSync(shared, "utf8"), unrelated);
  assert.equal(run(true).status, 0);
  assert.equal(fs.readFileSync(primary, "utf8"), patched);
  fs.writeFileSync(shared, unrelated + MARKER);
  assert.equal(run(true).status, 1, "无跟踪器却包含残缺补丁时仍须拒绝");
});

test("26.1021 真实资源：首页记录、离开和设置页完整恢复", {
  skip: !process.env.CODEX_REBUILD_1021_ASSETS,
}, () => {
  const directory = process.env.CODEX_REBUILD_1021_ASSETS;
  const input = fs.readFileSync(path.join(directory, "app-primary-844e405f2b90.js"), "utf8");
  assert.equal(require("node:crypto").createHash("sha256").update(input).digest("hex"),
    "298f4c7bafe278563aa82ef8d8d4c1afe3f581d54915917849065085f7f621d2");
  const result = patchSource(input);
  assert.equal(result.status, "patched", result.reason);
  const ast = acorn.parse(result.source, { ecmaVersion: "latest", sourceType: "module" });
  const functions = ["oNn", "HOt", "ekt", "jOt", "MOt", "ZOt", "$Ot", "QOt", "UOt", "KOt", "GOt"]
    .map(name => {
      const found = ast.body.filter(node => node.type === "FunctionDeclaration" && node.id.name === name);
      assert.equal(found.length, 1, `真实函数 ${name} 必须唯一`);
      return result.source.slice(found[0].start, found[0].end);
    }).join("\n");
  const harness = Function("assert", `
    const atoms=Object.fromEntries(["PS","Wy","BD","vE","uP","lP","kS","iKe","xZe","xG"].map(id=>[id,{id}]));
    const {PS,Wy,BD,vE,uP,lP,kS,iKe,xZe,xG}=atoms;
    const values=new Map([[PS,false],[BD,"codex"],[vE,{projectId:"sample"}]]),records=new Map();
    const store={get(atom,partition){assert.ok(atom?.id,"get 必须使用 atom");return atom===lP?(records.get(partition)||{}):values.get(atom)},
      set(atom,...args){assert.ok(atom?.id,"set 必须使用 atom");if(atom===lP)records.set(args[0],args[1]);else values.set(atom,args[0])}};
    let current,navigated=null;const auth={authMethod:"apikey"};
    values.set(kS,{prepareNavigation:(pathname,options)=>()=>{navigated={pathname,...options}}});
    const q={},yG={},sNn={c:()=>[]},cNn={useContext:()=>null,useLayoutEffect:fn=>fn()};
    const Jd=()=>store,_n=()=>current,rw=()=>auth,X=atom=>store.get(atom);
    const Fm={home:{destinationId:"builtin:home"}},sm="/orbit",tkt=480000;
    const Sne="/site",Nte="/review",Co=()=>null,Ys=()=>null,jo=()=>false;
    const sD=({pathname})=>({routeKind:pathname.startsWith("/settings")?"other":"home"});
    const Ga=location=>location.pathname,m0e=(target,project)=>target.set(vE,project);
    ${functions}
    return {visit(location){current=location;values.set(Wy,location);oNn()},
      click(){navigated=null;GOt(store,{accountKey:"auth:apikey",auth,area:"home",navigate:pathname=>{navigated={pathname}},productMode:"codex",state:{}});return navigated},
      record(){return records.get("auth:apikey:codex")?.["builtin:home"]}};
  `)(assert);
  const thread = { pathname: "/local/sample-thread", key: "thread", search: "", hash: "",
    state: { sidebarThreadLocationId: "chats", sidebarProductMode: "codex", sidebarProductModeAccountKey: "auth:apikey" } };
  harness.visit(thread);
  assert.equal(harness.record().location.pathname, thread.pathname);
  assert.equal(harness.click(), null);
  harness.visit({ pathname: "/settings/general", key: "settings", search: "", hash: "", state: null });
  assert.equal(harness.record().location.pathname, thread.pathname);
  assert.ok(harness.record().departedAt > 0);
  const restored = harness.click();
  assert.equal(restored.pathname, thread.pathname);
  assert.equal(restored.state.sidebarThreadLocationId, "chats");
  assert.equal(restored.state.sidebarProductModeAccountKey, "auth:apikey");
  assert.equal(patchSource(result.source).status, "already-patched");
});
