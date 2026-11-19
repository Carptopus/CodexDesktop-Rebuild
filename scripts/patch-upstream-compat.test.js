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
