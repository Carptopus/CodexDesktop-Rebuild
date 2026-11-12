const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parse } = require("acorn");

const {
  NEW_COPYRIGHT_HTML,
  OLD_COPYRIGHT_HTML,
  collectPatches: collectCopyrightPatches,
} = require("./patch-copyright");
const {
  findComposerBundles,
  hasNativeWorkspaceRootPropagation,
  hasRspackWorkspaceRootPropagation,
} = require("./patch-composer-workspace-root");
const { patchSource: patchI18n } = require("./patch-i18n");
const {
  findPluginAuthPatches,
  findStatsigGatePatches,
  inspectNativeGoalGate,
} = require("./patch-plugin-auth");
const { hasNativeArchiveDelete } = require("./patch-archive-delete");
const {
  isElectronBootstrap,
  resolveDeclaredMain,
  selectMainEntry,
} = require("./patch-crash-forensics");
const {
  LIMITS,
  patchSource: patchWorkerLimits,
} = require("./patch-worker-limits");
const {
  patchSource: patchDiffLimits,
} = require("./patch-diff-limits");
const {
  TARGETS,
  hasNativeScopeProtection,
  inspectNativeScopeProtection,
  patchOne: patchSentryFile,
} = require("./patch-sentry-scope");
const { isOwlRuntime } = require("./build-from-upstream");

function applyPatches(source, patches) {
  let next = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    next = next.slice(0, patch.start) + patch.replacement + next.slice(patch.end);
  }
  return next;
}

test("版权补丁兼容新版 About HTML", () => {
  const source = `const html=\`<main>${OLD_COPYRIGHT_HTML}</main>\`;`;
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const patches = collectCopyrightPatches(ast, source);

  assert.equal(patches.length, 1);
  assert.equal(applyPatches(source, patches).includes(NEW_COPYRIGHT_HTML), true);
});

test("保留旧 ESM 工作区根目录原生链 matcher", () => {
  const primarySource = [
    "function Qut({localConversationCwd:e,selectedRemoteProjectPath:t,defaultCwd:n,workspaceRoots:r,activeWorkspaceRoot:i,codexHome:a,canUseProjectlessThreads:o}){return e||t||n||r[0]||i}",
  ].join("");
  const sharedSource = "const query=`active-workspace-roots`;";

  assert.equal(
    hasNativeWorkspaceRootPropagation(primarySource, sharedSource),
    true,
  );
  assert.equal(
    hasNativeWorkspaceRootPropagation(
      primarySource.replace("activeWorkspaceRoot:", "root:"),
      sharedSource,
    ),
    false,
  );
});

test("识别 26.1106 Rspack 工作区根目录完整传递链路", () => {
  const primarySource = [
    "function Qut({localConversationCwd:e,selectedRemoteProjectPath:t,defaultCwd:n,workspaceRoots:r,activeWorkspaceRoot:i,codexHome:a,canUseProjectlessThreads:o}){",
    "if(e)return e;if(t)return t;if(n)return n;let s=r.find(e=>isRoot(e,a??void 0));return s||(i&&\"/\"!==i?i:o?fallback:\"/\")",
    "}({localConversationCwd:pending?.cwd,selectedRemoteProjectPath:null,defaultCwd:base,workspaceRoots:roots,activeWorkspaceRoot:active,canUseProjectlessThreads:true});",
  ].join("");
  const sharedSource = "const query=`active-workspace-roots`;";

  assert.equal(
    hasRspackWorkspaceRootPropagation(primarySource, sharedSource),
    true,
  );
  assert.equal(
    hasRspackWorkspaceRootPropagation(
      primarySource.replace("activeWorkspaceRoot:", "root:"),
      sharedSource,
    ),
    false,
  );
  assert.equal(
    hasRspackWorkspaceRootPropagation(
      primarySource.replace("canUseProjectlessThreads:true", "projectless:true"),
      sharedSource,
    ),
    false,
  );
});

test("旧 ESM 非 Rspack composer bundle 仍扫描原生 resolver", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "win", "_asar", "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "query.js"), "const key=`active-workspace-roots`;");
  const composer = path.join(assets, "composer-old.js");
  fs.writeFileSync(composer, [
    "function Resolve({localConversationCwd:e,selectedRemoteProjectPath:t,defaultCwd:n,workspaceRoots:r,activeWorkspaceRoot:i,codexHome:a,canUseProjectlessThreads:o}){return e||t||n||r[0]||i}",
  ].join(""));

  const targets = findComposerBundles("win", root);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].path, composer);
  assert.equal(targets[0].kind, "legacy-native");
  assert.equal(targets[0].native, true);
});

test("i18n 改写保留可重入的 enable_i18n 标记", () => {
  const source = 'const value=provider?.get("enable_i18n",!1);';
  const result = patchI18n(source);

  assert.equal(result.status, "patched");
  assert.match(result.source, /\/\* Codex：启用界面语言 enable_i18n \*\/!0/);
  assert.equal(patchI18n(result.source).status, "already-patched");
  assert.equal(patchI18n('const text="enable_i18n";').status, "unrecognized-gate");
});

test("插件 query 认证、序列成员浏览器 gate 与原生 goal 链可分别识别", () => {
  const authSource = [
    'const query={queryFn:async()=>{if(await (0,d.s)(scope,host)!=="chatgpt")return empty;',
    'return request("/ps/plugins/list")}};',
  ].join("");
  const authAst = parse(authSource, { ecmaVersion: "latest", sourceType: "module" });
  assert.equal(findPluginAuthPatches(authAst, authSource).length, 1);
  const callSiteOnly = 'function query(){return request("/ps/plugins/list",{label:"chatgpt"})}';
  assert.equal(
    findPluginAuthPatches(
      parse(callSiteOnly, { ecmaVersion: "latest", sourceType: "module" }),
      callSiteOnly,
    ).length,
    0,
  );

  const browserSource = [
    'function availability(){let gate=(0,h.Zj)("410262010");',
    'return{enabled:gate,featureName:"browser_use"}}',
  ].join("");
  const browserAst = parse(browserSource, { ecmaVersion: "latest", sourceType: "module" });
  assert.equal(findStatsigGatePatches(browserAst, browserSource).length, 1);

  const goalSource = [
    'function rg(e,t){return"cloud"!==t&&("local"!==e.kind||"side"!==e.placement)}',
    "function Composer(){const value=state();const t=rg(value,mode);let eO=t;let enabled=eO&&visible;",
    'return{id:"composer.goalSlashCommand",enabled}}',
  ].join("");
  assert.equal(inspectNativeGoalGate(goalSource), true);
  assert.equal(
    inspectNativeGoalGate(goalSource.replace("enabled}}", "available}}")),
    false,
  );
});

test("识别上游原生归档会话删除功能", () => {
  const dataControls = [
    "function DataControls(manager,ui){",
    "const [pending,setPending]=useState(null);",
    "const run=async target=>target.kind===`all`?manager.deleteAllArchivedConversations():manager.deleteArchivedConversation(target.thread.id);",
    "const mutationConfig={mutationKey:[`delete-archived-conversations`],mutationFn:run};",
    "const mutation=useMutation(mutationConfig);const confirm=()=>{if(pending){setPending(null);mutation.mutate(pending)}};",
    "return ui(Dialog,{onConfirm:confirm,children:ui(Group,{onDelete:thread=>setPending({kind:`single`,thread})})});}",
    "function Group(input){const {onDelete:openDelete}=input;",
    "return ui(Row,{showDeleteButton:!0,onDelete:()=>openDelete(thread)})}",
    "function Row(input){const {showDeleteButton:show,onDelete:remove}=input;",
    "return show?button({onClick:()=>remove()}):null}",
  ].join("");
  const protocol = [
    "class Manager{deleteArchivedConversation(id){return this.runtime.deleteArchivedThreads(`local`,id)}",
    "deleteAllArchivedConversations(){return this.runtime.deleteArchivedThreads(`local`)}}",
    "const runtime={async deleteArchivedThreads(host,id){let service=this.threadArchive;",
    "return id==null?await service.deleteAllArchivedThreads({hostId:host}):await service.deleteArchivedThread({hostId:host,threadId:id})}};",
    "async function deleteOne(appServer,id){return appServer.sendAppServerRequest(`thread/delete`,{threadId:id})}",
    "function notification(event,manager){if(event.method===`thread/deleted`)manager.handleThreadDeletion([event.params.threadId])}",
  ].join("");

  assert.equal(hasNativeArchiveDelete(dataControls, protocol), true);
  assert.equal(
    hasNativeArchiveDelete(dataControls.replace("onDelete:thread=>setPending", "onDelete:thread=>noop"), protocol),
    false,
  );
  assert.equal(
    hasNativeArchiveDelete(dataControls, protocol.replace("thread/delete", "thread/archive")),
    false,
  );
  assert.equal(
    hasNativeArchiveDelete(dataControls.replace("onConfirm:confirm", "onCancel:confirm"), protocol),
    false,
  );
  assert.equal(
    hasNativeArchiveDelete(dataControls.replace("onDelete:()=>openDelete(thread)", "onDelete:noop"), protocol),
    false,
  );
  assert.equal(
    hasNativeArchiveDelete(dataControls.replace("mutation.mutate(pending)", "mutation.mutate(other);void pending"), protocol),
    false,
  );
  assert.equal(
    hasNativeArchiveDelete(dataControls, protocol.replaceAll("this.runtime.deleteArchivedThreads", "this.runtime.archiveThreads")),
    false,
  );
  assert.equal(
    hasNativeArchiveDelete(dataControls, protocol.replaceAll("this.runtime.deleteArchivedThreads", "this.dead.deleteArchivedThreads")),
    false,
  );
  assert.equal(
    hasNativeArchiveDelete(dataControls, protocol.replace(
      "return appServer.sendAppServerRequest(`thread/delete`,{threadId:id})",
      "void `thread/delete`;return appServer.sendAppServerRequest(`thread/archive`,{threadId:id})",
    )),
    false,
  );
  assert.equal(
    hasNativeArchiveDelete(dataControls, protocol.replace(
      "if(event.method===`thread/deleted`)manager.handleThreadDeletion([event.params.threadId])",
      "if(event.method===`thread/deleted`){noop()}else{manager.handleThreadDeletion([event.params.threadId])}",
    )),
    false,
  );
});

test("主进程入口兼容 bootstrap 与哈希 main 文件", () => {
  assert.deepEqual(selectMainEntry(["bootstrap.js", "main-abc.js"]), {
    count: 1,
    file: "bootstrap.js",
  });
  assert.deepEqual(selectMainEntry(["main.js", "main-abc.js"]), {
    count: 1,
    file: "main-abc.js",
  });
  assert.deepEqual(selectMainEntry(["main-a.js", "main-b.js"]), {
    count: 2,
    file: null,
  });
  assert.equal(isElectronBootstrap('const electron=require("electron");'), true);
  assert.equal(isElectronBootstrap('const fs=require("node:fs");'), false);
});

test("优先使用上游 package.json 声明的真实主入口", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-main-test-"));
  const buildDir = path.join(directory, ".vite", "build");
  try {
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      main: ".vite/build/early-bootstrap.js",
    }));
    const expected = path.join(buildDir, "early-bootstrap.js");
    fs.writeFileSync(expected, "Promise.resolve();");
    assert.equal(resolveDeclaredMain(directory), expected);
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ main: "../escape.js" }));
    assert.equal(resolveDeclaredMain(directory), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("worker 内存限制兼容 transferList 且不误匹配快照 worker", () => {
  const source = [
    "new M.Worker(snapshot,{name:`child-process-snapshot`,workerData:data});",
    "class Manager{ensureWorker(){",
    "return new M.Worker(file,{name:this.id,workerData:data,transferList:port==null?[]:[port]});",
    "}}",
  ].join("");
  const result = patchWorkerLimits(source);

  assert.equal(result.status, "patched");
  assert.equal(result.mode, "added");
  assert.equal(result.source.includes(LIMITS), true);
  assert.equal(result.source.includes("transferList:port==null?[]:[port]"), true);
  assert.equal(patchWorkerLimits(result.source).status, "already-patched");
});

test("diff 上限按数值结构匹配，不依赖压缩变量名", () => {
  const source = [
    "var jce=5*1024*1024,Z2=32*1024*1024,Mce=64*1024*1024;",
    "function cap(e){return e==null?Z2:Math.min(e,Z2)}",
  ].join("");
  const result = patchDiffLimits(source);

  assert.equal(result.status, "patched");
  assert.match(result.source, /Z2=8\*1024\*1024/);
  assert.equal(patchDiffLimits(result.source).status, "already-patched");
});

test("Sentry 补丁覆盖新版主进程 chunk 并保持幂等", () => {
  assert.equal(TARGETS[1].test("window-all-closed-abc.js"), true);
  assert.equal(TARGETS[1].test("workspace-root-drop-handler-abc.js"), true);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sentry-test-"));
  const file = path.join(directory, "window-all-closed-test.js");
  try {
    fs.writeFileSync(file, "const options={dsn:config.dsn,environment:config.env};");
    assert.equal(patchSentryFile(file, false), true);
    const patched = fs.readFileSync(file, "utf-8");
    assert.match(patched, /maxBreadcrumbs:20/);
    assert.equal(patchSentryFile(file, false), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Sentry 初始化锚点兼容新版 transport 配置且保持幂等", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sentry-transport-"));
  const file = path.join(directory, "worker.js");
  try {
    fs.writeFileSync(file, "const internal={...e,dsn:e.dsn??process.env.SENTRY_DSN,environment:e.environment??process.env.SENTRY_ENVIRONMENT,transport:e.transport??fallback};const init=client({dsn:e.dsn,transport:e=>e.buffer,environment:e.buildFlavor,release:(n=a.version,`codex@${n}`),dist:e.buildNumber??void 0,tracesSampleRate:0,integrations:e=>e});");
    assert.equal(patchSentryFile(file, false), true);
    const patched = fs.readFileSync(file, "utf-8");
    assert.match(patched, /dsn:e\.dsn,maxBreadcrumbs:20,beforeBreadcrumb:/);
    parse(patched, { ecmaVersion: "latest", sourceType: "module" });
    assert.equal(patchSentryFile(file, false), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Sentry 原生保护接受唯一条件分支中的跨模块数据裁剪", () => {
  const source = [
    "var bundle={72629:function(e,t,n){const r=n(89477),o=n(25838);",
    "try{(0,r.statSync)('scope_v3.json').size>2097152&&(0,r.unlinkSync)('scope_v3.json')}catch{}",
    "init({dsn:v.dsn,environment:v.buildFlavor,beforeBreadcrumb:e=>quiet?null:(0,o.SKH)(e)})},",
    "25838:function(e,t,n){n.d(t,{SKH:()=>oi});",
    "function oi(e){let{data:t}=e;return oo(t)?e:{...e,data:{codex_truncated_breadcrumb_data:!0}}}",
    "function oo(e){return new TextEncoder().encode(JSON.stringify(e)).byteLength<=2048}}};",
  ].join("");

  assert.deepEqual(inspectNativeScopeProtection([source]), [
    { moduleId: 72629, sanitizerModuleId: 25838, sanitizerName: "oi" },
  ]);
  assert.deepEqual(
    inspectNativeScopeProtection([source.replace("(0,o.SKH)(e)", "(0,o.unknown)(e)")]),
    [],
  );
  assert.deepEqual(
    inspectNativeScopeProtection([source.replace("byteLength<=2048", "byteLength<=9999")]),
    [],
  );
});

test("识别上游原生 Sentry scope 防膨胀保护", () => {
  const source = [
    "const codex_truncated_breadcrumb_data=true;",
    "Sentry.init({beforeBreadcrumb:trim});",
    "const scope=`scope_v3.json`;",
    "const maxBytes=2097152;",
  ].join("");

  assert.equal(hasNativeScopeProtection(source), true);
  assert.equal(
    hasNativeScopeProtection(source.replace("scope_v3.json", "scope.json")),
    false,
  );
});

test("识别新版 Windows Owl runtime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-owl-test-"));
  try {
    fs.mkdirSync(path.join(directory, "resources"));
    fs.writeFileSync(path.join(directory, "owl-shell-runtime.json"), "{}");
    fs.writeFileSync(path.join(directory, "resources", "owl-electron-app.json"), "{}");
    assert.equal(isOwlRuntime(directory), true);
    fs.unlinkSync(path.join(directory, "resources", "owl-electron-app.json"));
    assert.equal(isOwlRuntime(directory), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
