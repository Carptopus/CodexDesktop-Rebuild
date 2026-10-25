const test = require("node:test");
const assert = require("node:assert/strict");
const acorn = require("acorn");
const vm = require("node:vm");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { nodes } = require("./patch-ast-util");

const {
  DIRECT_ACTION_ID,
  LEGACY_MARKER,
  MARKER,
  SIDEBAR_MARKER,
  hasSidebarMenuSignatures,
  hasNativeDirectAction,
  patchSidebarSource,
  patchSource,
  selectTargets,
} = require("./patch-thread-file-manager-action");

test("26.1016 真实 Bundle：普通目录入口、远程排除和工作区原生打开链路", {
  skip: !process.env.CODEX_PATCH_REAL_BUNDLE && !process.env.CODEX_PATCH_REAL_ASAR,
}, async () => {
  let original;
  if (process.env.CODEX_PATCH_REAL_BUNDLE) {
    original = fs.readFileSync(process.env.CODEX_PATCH_REAL_BUNDLE, "utf8");
  } else {
    const asar = require("@electron/asar");
    const archive = process.env.CODEX_PATCH_REAL_ASAR;
    const entries = asar.listPackage(archive).filter(name => /app-(initial|primary)-[^/\\]+\.js$/.test(name));
    const sources = entries.map(name => asar.extractFile(archive, name.replace(/^[/\\]/, "")).toString());
    const matches = sources.filter(source => source.includes(LEGACY_MARKER));
    assert.equal(matches.length, 1, "当前成品应唯一包含待替换的旧入口");
    [original] = matches;
  }
  const menu = patchSource(original);
  assert.equal(menu.status, "patched");
  const copy = require("./patch-thread-copy-markdown").patchSource(menu.source);
  assert.equal(copy.status, "patched", "同一真实 Bundle 还须能够组合应用 Markdown 复制修复");
  const result = patchSidebarSource(copy.source);
  assert.ok(["patched", "already-patched"].includes(result.status));
  assert.equal(patchSource(result.source).source, result.source);
  assert.equal(patchSidebarSource(result.source).source, result.source);
  const ast = acorn.parse(result.source, { ecmaVersion: "latest", sourceType: "module" });
  const selectors = nodes(ast, node => node.type === "AssignmentExpression" &&
    node.left?.name === "VUc");
  assert.equal(selectors.length, 1);
  const selector = selectors[0].right.arguments[1];
  const select = vm.runInNewContext(`(${result.source.slice(selector.start, selector.end)})`, { ah: "remote" });
  for (const connections of [[], [{ hostId: "local" }], [{ hostId: "other" }]]) {
    assert.equal(select({ conversationId: "thread", hostId: "local" }, {
      get: atom => { assert.equal(atom, "remote"); return connections; },
    }), !connections.some(item => item.hostId === "local"));
  }
  const callers = nodes(ast, node => node.type === "LogicalExpression" &&
    node.right?.type === "CallExpression" && node.right.callee?.property?.name === "push" &&
    result.source.slice(node.start, node.end).includes("...LUc("));
  assert.equal(callers.length, 1);
  const expression = result.source.slice(callers[0].start, callers[0].end);
  for (const cwd of [null, "C:\\plain-folder"]) {
    const context = { v: cwd, e: { get: () => true }, VUc: {}, g: "thread", _: "local",
      L: [], is: value => value, LUc: () => [{ id: DIRECT_ACTION_ID }] };
    vm.runInNewContext(expression, context);
    assert.equal(context.L.length, cwd == null ? 0 : 1);
  }
  const builder = ast.body.find(node => node.type === "FunctionDeclaration" && node.id.name === "LUc");
  assert.ok(builder);
  const builderSource = result.source.slice(builder.start, builder.end);
  assert.doesNotMatch(builderSource, /onSelect:\(\)=>Bq\(/);
  let opened, preferredWrites = 0, errors = 0, failure = false;
  const context = { navigator: { platform: "Win32" }, Iq: {}, DJt: {}, ay: {},
    GE: {}, QZn: {}, KE: {}, i$a: {}, nl: {}, y_: {},
    GZn: async () => { context.latestWorkspace = "C:/最新工作树"; },
    RUc: input => [{ id: "open-workspace-in", icon: "icon", onOpenInTarget: input.onOpenInTarget }] };
  const scope = { get: atom => {
      if (atom === context.GE) return true;
      if (atom === context.QZn) return { data: { latestWorktree: { workspaceRoot: context.latestWorkspace } } };
      if (atom === context.i$a) return { mutateAsync: async params => { opened = params; return { success: !failure }; } };
      if (atom === context.nl) return { danger: () => errors++ };
      if (atom === context.y_) return { formatMessage: message => message.defaultMessage };
      return null;
    },
    getOwnValue() { throw new Error("Missing scope instance"); },
    query: { getData: () => ({ targets: [{ target: "fileManager", available: true, resolvedIcon: "folder-icon" }] }),
      getOptions: () => ({ queryKey: [] }), fetch: async () => ({}), setData: () => preferredWrites++ },
    queryClient: { getQueryState: () => ({ status: "success" }) } };
  context.scope = scope;
  vm.runInNewContext(`${builderSource};items=LUc({scope,conversationId:'thread',cwd:'C:/plain-folder',hostId:'local'})`, context);
  assert.equal(context.items[0].id, DIRECT_ACTION_ID);
  assert.equal(context.items[0].message.id, "sidebarElectron.openWorkspaceRootInExplorer");
  context.items[0].onSelect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.target, "fileManager");
  assert.equal(opened.cwd, "C:/最新工作树");
  assert.equal(opened.hostId, "local");
  assert.equal(opened.persistPreferredTargetPath, undefined);
  assert.equal(preferredWrites, 0);
  context.items[1].onOpenInTarget("vscode", "C:/Code.exe");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.target, "vscode");
  assert.equal(opened.persistPreferredTargetPath, "C:/最新工作树");
  assert.equal(preferredWrites, 1);
  failure = true;
  context.items[0].onSelect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors, 1, "真实系统打开失败仍走原生提示");
});

function createGroupedMenuBundle(options = {}) {
  const openHelper = options.includeOpenHelper === false
    ? ""
    : [
        "function openItem(input){",
        "let{scope,appPath,openInSidePanel,cwd,hostId,path,",
        "persistPreferredTargetPath,target,openMode}=input;",
        "if(target!=null||openMode===`workspace`||persistPreferredTargetPath!=null){",
        "scope.open({path,cwd,hostId,target,appPath});return}",
        "if(openInSidePanel)scope.open({path,cwd,hostId,target:`fileManager`})",
        "}",
      ].join("");
  const menuBuilder = [
    "function buildOpenItems({scope:s,cwd:c,hostId:h}){",
    "let request={cwd:c,hostId:h,path:void 0};",
    "let data=s.query.getData(targets,request);",
    "s.query.fetch(targets,request).catch(()=>{});",
    "let report=()=>`localConversation.openTarget.error`;",
    "return makeOpenMenu({",
    "targets:data?.targets.map(item=>item),",
    "message:`localConversationPage.openPrimaryTarget`,",
    "onOpenInTarget:(target,appPath)=>{",
    "s.get(openMutation).mutate({path:c,cwd:c,hostId:h,target,appPath,",
    "openMode:`workspace`,persistPreferredTargetPath:c},{onError:report})",
    "}",
    "})",
    "}",
    ...(options.includeCopySignature === false
      ? []
      : ["const copyMessage=`threadHeader.copyActions`;"]),
  ].join("");
  return openHelper + menuBuilder;
}

function evaluatePatchedMenu(source, platform, options = {}) {
  const context = {
    navigator: { userAgentData: { platform } },
    targets: {},
    openMutation: {},
    store: {},
    derive: (_store, selector) => selector,
    opened: null,
    makeOpenMenu: input => [{ id: "open-workspace-in", icon: "open-icon", onOpenInTarget: input.onOpenInTarget }],
  };
  context.scope = {
    get: () => ({
      mutate(params) { context.opened = params; },
      async mutateAsync(params) {
        if (options.reject) throw new Error("测试打开失败");
        context.opened = params;
        return { success: options.success !== false };
      },
    }),
    getOwnValue() { throw new Error("Missing scope instance"); },
    open() { throw new Error("不能从全局侧栏调用文件预览函数"); },
    query: {
      fetch: () => Promise.resolve(),
      setData() { context.preferredTargetChanged = true; },
      getData: () => ({
        targets: [{ target: "fileManager", resolvedIcon: "folder-icon" }],
      }),
    },
  };
  context.ensureWorkspace = async () => { context.resolvedWorkspace = "C:\\最新工作树"; };
  context.resolveWorkspace = fallback => context.resolvedWorkspace ?? fallback;
  context.reportError = () => { context.reportedErrors = (context.reportedErrors ?? 0) + 1; };
  vm.runInNewContext(
    `${source};result=buildOpenItems({scope,cwd:\`C:\\\\repo\`,hostId:\`local\`})`,
    context,
  );
  return context;
}

function createSidebarMenuBundle() {
  return [
    "function buildThreadMenu({scope:s,target:t}){",
    "let{conversationId:id,hostId:h,cwd:c}=t,items=[];",
    "let primary=[{id:`rename-thread`},{id:`archive-thread`}];",
    "return c!=null&&!getState(s.get,`remote_control_connections`)",
    "?.some(item=>item.hostId===h)&&s.get(gitBacked,id)",
    "&&items.push(...buildOpenItems({scope:s,cwd:normalize(c),hostId:h})),",
    "items.push({id:`open-in-new-window`}),",
    "[...primary,...items]",
    "}",
  ].join("");
}

function createSelectorSidebarMenuBundle() {
  return [
    "let sidebarGate=derive(store,({conversationId:id,hostId:h},{get:g})=>",
    "id!=null&&g(gitBacked,id)&&!getState(g,`remote_control_connections`)",
    "?.some(item=>item.hostId===h));",
    "function buildThreadMenu({scope:s,target:t}){",
    "let{conversationId:id,hostId:h,cwd:c}=t,items=[];",
    "let primary=[{id:`rename-thread`},{id:`archive-thread`}];",
    "return c!=null&&s.get(sidebarGate,{conversationId:id,hostId:h})",
    "&&items.push(...buildOpenItems({scope:s,cwd:normalize(c),hostId:h})),",
    "items.push({id:`open-in-new-window`}),",
    "[...primary,...items]",
    "}",
  ].join("");
}

function evaluatePatchedSidebar(source, options = {}) {
  const context = {
    gitBacked: {},
    getState: () => options.remoteConnections ?? [],
    derive: (_store, selector) => selector,
    store: {},
    normalize: (cwd) => cwd,
    buildOpenItems: () => [{ id: DIRECT_ACTION_ID }],
    scope: {
      get: (value, argument) =>
        typeof value === "function"
          ? value(argument, { get: () => false })
          : false,
    },
  };
  vm.runInNewContext(
    `${source};result=buildThreadMenu({scope,target:{` +
      `conversationId:\`thread-1\`,hostId:\`local\`,cwd:${
        options.cwd === null ? "null" : "`C:\\\\repo`"
      }}})`,
    context,
  );
  return context.result;
}

test("新版对话菜单增加顶层文件管理器入口并保留打开方式子菜单", () => {
  const result = patchSource(createGroupedMenuBundle());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(MARKER));
  assert.ok(result.source.includes(`id:\`${DIRECT_ACTION_ID}\``));
  assert.match(
    result.source,
    /onSelect:\(\)=>__codexOpenWorkspaceInTarget\(`fileManager`\)/,
  );
  assert.match(
    result.source,
    /sidebarElectron\.openWorkspaceRootInExplorer/,
  );
  assert.match(result.source, /navigator\?\.userAgentData\?\.platform/);
  assert.match(result.source, /\.toLowerCase\(\)/);
  assert.match(result.source, /\.startsWith\(`mac`\)/);
  assert.match(result.source, /\.\.\.__codexOpenWorkspaceItems/);
  assert.doesNotThrow(() =>
    acorn.parse(result.source, {
      ecmaVersion: "latest",
      sourceType: "module",
    }),
  );
});

test("候选识别不依赖上游已移除的复制动作签名", () => {
  const source = createGroupedMenuBundle({ includeCopySignature: false });

  assert.equal(source.includes("threadHeader.copyActions"), false);
  assert.equal(patchSource(source).status, "patched");
});

test("侧边栏普通目录会话不再受 Git 仓库门控", () => {
  const original = createSidebarMenuBundle();
  const result = patchSidebarSource(original);

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(SIDEBAR_MARKER));
  assert.doesNotMatch(result.source, /s\.get\(gitBacked,id\)/);
  assert.equal(
    evaluatePatchedSidebar(result.source).some(
      (item) => item.id === DIRECT_ACTION_ID,
    ),
    true,
  );
  assert.doesNotThrow(() =>
    acorn.parse(result.source, {
      ecmaVersion: "latest",
      sourceType: "module",
    }),
  );
});

test("侧边栏入口仍要求工作目录且排除远程控制连接", () => {
  const { source } = patchSidebarSource(createSidebarMenuBundle());

  assert.equal(
    evaluatePatchedSidebar(source, { cwd: null }).some(
      (item) => item.id === DIRECT_ACTION_ID,
    ),
    false,
  );
  assert.equal(
    evaluatePatchedSidebar(source, {
      remoteConnections: [{ hostId: "local" }],
    }).some((item) => item.id === DIRECT_ACTION_ID),
    false,
  );
});

test("兼容 26.908 将 Git 限制移入派生选择器的结构", () => {
  const result = patchSidebarSource(createSelectorSidebarMenuBundle());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(`!0${SIDEBAR_MARKER}`));
  assert.doesNotMatch(result.source, /g\(gitBacked,id\)/);
  assert.equal(
    evaluatePatchedSidebar(result.source).some(
      (item) => item.id === DIRECT_ACTION_ID,
    ),
    true,
  );
  assert.equal(
    evaluatePatchedSidebar(result.source, {
      remoteConnections: [{ hostId: "local" }],
    }).some((item) => item.id === DIRECT_ACTION_ID),
    false,
  );
});

test("兼容 26.911 将侧边栏菜单合并到 app-initial 的结构", () => {
  const original = createGroupedMenuBundle() + createSelectorSidebarMenuBundle();

  assert.equal(hasSidebarMenuSignatures(original), true);
  assert.equal(hasSidebarMenuSignatures(createGroupedMenuBundle()), false);

  const openMenuResult = patchSource(original);
  assert.equal(openMenuResult.status, "patched");

  const sidebarResult = patchSidebarSource(openMenuResult.source);
  assert.equal(sidebarResult.status, "patched");
  assert.ok(sidebarResult.source.includes(MARKER));
  assert.ok(sidebarResult.source.includes(SIDEBAR_MARKER));
  assert.doesNotThrow(() =>
    acorn.parse(sidebarResult.source, {
      ecmaVersion: "latest",
      sourceType: "module",
    }),
  );
});

test("侧边栏补丁重复执行保持幂等", () => {
  const first = patchSidebarSource(createSidebarMenuBundle());
  const second = patchSidebarSource(first.source);

  assert.equal(first.status, "patched");
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, first.source);
});

test("侧边栏结构变化时明确失败而不是静默跳过", () => {
  const result = patchSidebarSource(
    "function changedThreadMenu(){return [{id:`rename-thread`}]}",
  );

  assert.equal(result.status, "unexpected-sidebar-menu-gate-count");
  assert.equal(result.count, 0);
});

test("补丁重复执行保持幂等", () => {
  const first = patchSource(createGroupedMenuBundle());
  const second = patchSource(first.source);

  assert.equal(first.status, "patched");
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, first.source);
});

test("顶层入口按系统显示文案并复用 fileManager 打开链路", () => {
  const { source } = patchSource(createGroupedMenuBundle());
  const cases = [
    ["Windows", "sidebarElectron.openWorkspaceRootInExplorer"],
    ["macOS", "sidebarElectron.openWorkspaceRootInFinder"],
    ["Linux", "sidebarElectron.openWorkspaceRootInFileManager"],
  ];

  for (const [platform, messageId] of cases) {
    const context = evaluatePatchedMenu(source, platform);
    assert.equal(context.result[0].id, DIRECT_ACTION_ID);
    assert.equal(context.result[0].message.id, messageId);
    assert.equal(context.result[0].icon, "folder-icon");
    assert.equal(context.result[1].id, "open-workspace-in");

    context.result[0].onSelect();
    assert.equal(context.opened.target, "fileManager");
    assert.equal(context.opened.cwd, "C:\\repo");
    assert.equal(context.opened.persistPreferredTargetPath, undefined);
    assert.equal(context.preferredTargetChanged, undefined);
  }
});

test("旧版已有顶层 open-thread-folder 时安全跳过", () => {
  const source =
    "const items=[{id:`open-thread-folder`,message:folder,onSelect:openFolder}];";

  assert.equal(hasNativeDirectAction(source), true);
  assert.equal(patchSource(source).status, "native");
});

test("新旧菜单实现共存时优先修补新版动作聚合器", () => {
  const source =
    "const legacy=[{id:`open-thread-folder`,onSelect:openFolder}];" +
    createGroupedMenuBundle();
  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(MARKER));
});

test("工作区菜单不依赖要求 ThreadScope 的文件预览函数", () => {
  const result = patchSource(createGroupedMenuBundle({ includeOpenHelper: false }));
  assert.equal(result.status, "patched");
  const context = evaluatePatchedMenu(result.source, "Windows");
  context.result[0].onSelect();
  assert.equal(context.opened.path, "C:\\repo");
});

test("原生工作区打开回调缺失时保留原文并报错", () => {
  const original = createGroupedMenuBundle().replace("onOpenInTarget:", "changedOpenHandler:");
  const result = patchSource(original);
  assert.equal(result.status, "missing-workspace-open-callback");
  assert.equal(result.source, original);
});

function createCurrentWorkspaceBundle() {
  return createGroupedMenuBundle().replace(
    "onOpenInTarget:(target,appPath)=>{s.get(openMutation).mutate({path:c,cwd:c,hostId:h,target,appPath,openMode:`workspace`,persistPreferredTargetPath:c},{onError:report})}",
    "onOpenInTarget:async(target,appPath)=>{try{await ensureWorkspace();let cwd=resolveWorkspace(c);s.query.setData(targets,request,data=>({...data,preferredTarget:target}));let result=await s.get(openMutation).mutateAsync({path:cwd,cwd,hostId:h,target,appPath,openMode:`workspace`,persistPreferredTargetPath:cwd});if(!result.success)reportError()}catch(error){reportError()}}",
  );
}

test("打开最新工作树且不改变默认编辑器，原生子菜单仍保存偏好", async () => {
  const result = patchSource(createCurrentWorkspaceBundle());
  assert.equal(result.status, "patched");
  const context = evaluatePatchedMenu(result.source, "Windows");
  await context.result[0].onSelect();
  assert.equal(context.opened.path, "C:\\最新工作树");
  assert.equal(context.opened.cwd, "C:\\最新工作树");
  assert.equal(context.opened.target, "fileManager");
  assert.equal(context.opened.persistPreferredTargetPath, undefined);
  assert.equal(context.preferredTargetChanged, undefined);
  await context.result[1].onOpenInTarget("vscode", "C:\\Code.exe");
  assert.equal(context.preferredTargetChanged, true);
  assert.equal(context.opened.persistPreferredTargetPath, "C:\\最新工作树");
  assert.equal(context.opened.target, "vscode");
});

test("系统打开返回失败或异常仍显示原生错误提示", async () => {
  const result = patchSource(createCurrentWorkspaceBundle());
  for (const options of [{ success: false }, { reject: true }]) {
    const context = evaluatePatchedMenu(result.source, "Windows", options);
    await context.result[0].onSelect();
    assert.equal(context.reportedErrors, 1);
  }
});

test("只替换已知旧注入并保持原生菜单，未知旧改动不被删除", () => {
  const source = createGroupedMenuBundle();
  const old = source.replace("return makeOpenMenu({", "let __codexOpenWorkspaceItems=makeOpenMenu({")
    .replace("})}const copyMessage", `});let __codexDesktopPlatform=\`win\`;return[{${LEGACY_MARKER}id:\`${DIRECT_ACTION_ID}\`,onSelect:()=>openItem({scope:s,path:c,cwd:c,hostId:h,target:\`fileManager\`,openMode:\`workspace\`})},...__codexOpenWorkspaceItems]}const copyMessage`);
  const result = patchSource(old);
  assert.equal(result.status, "patched");
  assert.equal(result.source.includes(LEGACY_MARKER), false);
  assert.equal(result.source.split(DIRECT_ACTION_ID).length - 1, 1);
  const context = evaluatePatchedMenu(result.source, "Windows");
  context.result[0].onSelect();
  assert.equal(context.opened.target, "fileManager");
  assert.equal(patchSource(result.source).status, "already-patched");
  const unknown = old.replace(`return[{${LEGACY_MARKER}`, `changed();return[{${LEGACY_MARKER}`);
  assert.equal(patchSource(unknown).status, "unexpected-legacy-menu");
  assert.equal(patchSource(unknown).source, unknown);
});

test("菜单迁移到 app-primary 且无远程配置名时仍定位两类补丁", () => {
  const sidebar = "const remoteConnections=derive(store,({get})=>get(config).remoteControl);" +
    createSelectorSidebarMenuBundle().replace("getState(g,`remote_control_connections`)", "g(remoteConnections)");
  const source = createCurrentWorkspaceBundle() + sidebar;
  assert.equal(source.includes("remote_control_connections"), false);
  const targets = selectTargets([
    { platform: "win", path: "app-initial-new.js", source: "const initial=true;" },
    { platform: "win", path: "app-primary-new.js", source },
  ]);
  assert.deepEqual(targets.map(({ path, patchKind }) => [path, patchKind]), [
    ["app-primary-new.js", "open-menu"], ["app-primary-new.js", "sidebar"],
  ]);
  let patched = source;
  for (const target of targets) {
    const result = (target.patchKind === "sidebar" ? patchSidebarSource : patchSource)(patched);
    assert.equal(result.status, "patched");
    patched = result.source;
  }
  const context = { store: {}, config: {}, gitBacked: {}, derive: (_store, selector) => selector };
  const gate = vm.runInNewContext(`${patched};sidebarGate`, context);
  for (const connections of [[], [{ hostId: "local" }], [{ hostId: "other" }]]) {
    assert.equal(gate({ conversationId: "thread", hostId: "local" }, { get: () => connections }),
      !connections.some(connection => connection.hostId === "local"));
  }
});

test("按平台独立选择实际菜单，支持旧版分离 chunk 与原生入口", () => {
  const targets = selectTargets([
    { platform: "mac-arm64", path: "mac/app-initial.js", source: createGroupedMenuBundle() },
    { platform: "win", path: "win/app-initial.js", source: "const initial=true;" },
    { platform: "mac-arm64", path: "mac/app-primary.js", source: createSidebarMenuBundle() },
    { platform: "win", path: "win/app-primary.js", source: createGroupedMenuBundle() + createSidebarMenuBundle() },
  ]);
  assert.deepEqual(targets.map(({ path, patchKind }) => [path, patchKind]), [
    ["mac/app-initial.js", "open-menu"], ["mac/app-primary.js", "sidebar"],
    ["win/app-primary.js", "open-menu"], ["win/app-primary.js", "sidebar"],
  ]);
  const native = selectTargets([
    { platform: "win", path: "app-initial.js", source: "const initial=true;" },
    { platform: "win", path: "app-primary.js", source: "const items=[{id:`open-thread-folder`}];" },
  ]);
  assert.equal(native.length, 1);
  assert.equal(native[0].path, "app-primary.js");
  assert.equal(patchSource(native[0].source).status, "native");
});

test("菜单未知时仍进入检查并失败，不因 chunk 变化静默跳过", () => {
  const targets = selectTargets([
    { platform: "win", path: "app-initial.js", source: "const changedMenu=true;" },
    { platform: "win", path: "app-primary.js", source: "const primary=true;" },
  ]);
  assert.equal(targets.length, 1);
  assert.equal(patchSource(targets[0].source).status, "unexpected-menu-builder-count");
});

test("CLI 在实际资源目录执行 check → apply → check，重复目标在写入前被拒绝", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-file-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "win", "_asar", "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  const initial = path.join(assets, "app-initial-test.js");
  const primary = path.join(assets, "app-primary-test.js");
  const source = createCurrentWorkspaceBundle() + createSelectorSidebarMenuBundle();
  fs.writeFileSync(initial, "const initial=true;");
  fs.writeFileSync(primary, source);
  const run = check => spawnSync(process.execPath,
    [path.join(__dirname, "patch-thread-file-manager-action.js"), "win", ...(check ? ["--check"] : [])],
    { encoding: "utf8", env: { ...process.env, CODEX_PATCH_SOURCE_DIR: root } });
  const checked = run(true);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(fs.readFileSync(primary, "utf8"), source);
  const applied = run(false);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const patched = fs.readFileSync(primary, "utf8");
  assert.ok(patched.includes(MARKER) && patched.includes(SIDEBAR_MARKER));
  assert.equal(run(true).status, 0);
  assert.equal(fs.readFileSync(primary, "utf8"), patched);
  const menu = evaluatePatchedMenu(patched, "Windows");
  return menu.result[0].onSelect().then(() => {
    assert.equal(menu.opened.target, "fileManager");
    fs.writeFileSync(initial, source);
    fs.writeFileSync(primary, source);
    const ambiguous = run(false);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /ambiguous open-menu bundles/);
    assert.equal(fs.readFileSync(initial, "utf8"), source);
    assert.equal(fs.readFileSync(primary, "utf8"), source);
  });
});
