#!/usr/bin/env node
/**
 * 将 Remote Control 的本地状态同步限制在真实 ChatGPT 认证下。
 *
 * 上游本地状态同步组件和 gate bridge 会分别触发 Remote Control 状态更新；
 * 旧版本项目还曾强开相关 gate，因此可能留下 true。API-key Provider 无法
 * 建立该连接，任一入口继续发送 enable 都会反复触发认证失败。
 *
 * 本补丁不再强开任何 Remote Control / Connections gate。ChatGPT 认证保持
 * 官方行为；其他认证方式清除遗留启用值，并向当前 app-server 发送一次
 * disable，确保切换认证方式时不会遗留已启动的 Remote Control。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { literal, walk } = require("./patch-ast-util");
const { relPath, SRC_DIR } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];
const STORAGE_KEY = "local_remote_control_enabled";
const MARKER = "/* CodexRebuildRemoteControlAuthIsolation */";
const GATE_MARKER = "/* CodexRebuildRemoteControlGateAuthIsolation */";
const CATALOG_MARKER = "/* CodexRebuildRemoteControlCatalog */";

function propertyName(member) {
  if (member?.type !== "MemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  return literal(member.property);
}

function memberCallee(call) {
  let callee = call?.callee;
  if (callee?.type === "SequenceExpression") callee = callee.expressions.at(-1);
  return callee?.type === "MemberExpression" ? callee : null;
}

function functions(ast) {
  return ast.body.filter((node) => node.type === "FunctionDeclaration" && node.id?.name);
}

function descendants(root, predicate, { skipNestedFunctions = false } = {}) {
  const found = [];
  walk(root, (node) => {
    if (node === root) return;
    if (predicate(node)) found.push(node);
  }, { ownScope: skipNestedFunctions });
  return found;
}

function nextInitializer(allFunctions, target, source) {
  const following = allFunctions.filter((node) => node.start > target.end).sort((a, b) => a.start - b.start);
  const initializer = following[0];
  if (initializer == null || initializer.start - target.end > 200) {
    throw new Error(`${target.id.name} 的模块初始化器未找到`);
  }
  const arrows = descendants(initializer, (node) =>
    node.type === "ArrowFunctionExpression" && node.body.type === "BlockStatement");
  if (arrows.length !== 1 || !source.slice(initializer.start, initializer.end).includes("return")) {
    throw new Error(`${target.id.name} 的模块初始化器结构异常`);
  }
  return { function: initializer, body: arrows[0].body };
}

function findRemoteSync(allFunctions, source) {
  const candidates = allFunctions.filter((node) => {
    const text = source.slice(node.start, node.end);
    return text.includes(STORAGE_KEY) && text.includes("Failed to sync local remote control enablement");
  });
  if (candidates.length !== 1) {
    throw new Error(`Remote Control 本地状态同步组件数量异常（${candidates.length}）`);
  }
  const fn = candidates[0];
  const declarations = descendants(fn, (node) => node.type === "VariableDeclarator", {
    skipNestedFunctions: true,
  });
  const storage = declarations.filter((node) =>
    node.id?.type === "ArrayPattern" &&
    node.id.elements[0]?.type === "Identifier" &&
    node.init?.type === "CallExpression" &&
    node.init.callee.type === "Identifier" &&
    node.init.arguments.some((argument) => literal(argument) === STORAGE_KEY));
  if (storage.length !== 1) throw new Error("Remote Control 本地状态 Hook 结构异常");
  const storedValue = storage[0].id.elements[0].name;
  const storageHook = storage[0].init.callee.name;

  const catches = descendants(fn, (node) =>
    node.type === "CallExpression" &&
    propertyName(node.callee) === "catch" &&
    node.callee.object?.type === "CallExpression" &&
    node.callee.object.callee?.type === "Identifier" &&
    node.callee.object.arguments[1]?.type === "Identifier" &&
    node.callee.object.arguments[1].name === storedValue);
  if (catches.length !== 1 || catches[0].arguments.length !== 1) {
    throw new Error("Remote Control 同步及错误处理结构异常");
  }
  const syncCall = catches[0].callee.object;
  const syncFunction = syncCall.callee.name;
  const container = syncCall.arguments[0];
  if (container?.type !== "Identifier") throw new Error("Remote Control 容器参数结构异常");
  const containerDeclaration = declarations.find((node) => node.id?.name === container.name);
  if (containerDeclaration?.init == null) throw new Error("Remote Control 容器初始化结构异常");

  const effects = descendants(fn, (node) =>
    node.type === "CallExpression" && propertyName(memberCallee(node)) === "useEffect");
  const effectCallee = effects.length === 1 ? memberCallee(effects[0]) : null;
  if (effectCallee?.object.type !== "Identifier") {
    throw new Error("Remote Control useEffect 结构异常");
  }

  return {
    fn,
    container: container.name,
    containerExpression: source.slice(containerDeclaration.init.start, containerDeclaration.init.end),
    storedValue,
    storageHook,
    syncFunction,
    catchHandler: source.slice(catches[0].arguments[0].start, catches[0].arguments[0].end),
    react: effectCallee.object.name,
  };
}

function findCurrentAuth(allFunctions, source) {
  const candidates = [];
  for (const fn of allFunctions) {
    const text = source.slice(fn.start, fn.end);
    if (!["accountLoading", "authLoading", "authMethod", "authenticatedAccountId",
      "hasChatGptToken", "requiresAuth", "supportedSurface"]
      .every((value) => text.includes(value))) continue;
    const assignments = descendants(fn, (node) =>
      node.type === "AssignmentExpression" && node.operator === "=" &&
      node.left?.type === "Identifier" && node.right?.type === "CallExpression");
    const account = assignments.filter((node) => {
      if (node.left.name === fn.id.name) return false;
      const assignmentText = source.slice(node.start, node.end);
      return ["accountLoading", "authLoading", "authMethod", "authenticatedAccountId",
        "hasChatGptToken", "requiresAuth", "supportedSurface"]
        .every((value) => assignmentText.includes(value));
    });
    if (account.length !== 1) continue;
    const assigned = new Set(assignments.map((node) => node.left.name));
    const hooks = new Set();
    for (const hookFn of allFunctions) {
      const statements = hookFn.body?.body;
      if (statements?.length !== 1 || statements[0].type !== "ReturnStatement") continue;
      const call = statements[0].argument;
      if (call?.type !== "CallExpression" || call.callee?.type !== "Identifier" ||
          call.arguments.length !== 1 || call.arguments[0]?.type !== "Identifier" ||
          !assigned.has(call.arguments[0].name)) continue;
      hooks.add(call.callee.name);
    }
    if (hooks.size === 0) {
      // 新版移除了认证 selector 的单句 Hook 包装；从实际使用完整认证 atom
      // 且含 React effect 的组件中定位 Hook，避免把 selector 的 get 当成 Hook。
      for (const component of allFunctions) {
        const effects = descendants(component, (node) => node.type === "CallExpression" &&
          propertyName(memberCallee(node)) === "useEffect", { skipNestedFunctions: true });
        if (effects.length === 0) continue;
        const calls = descendants(component, (node) => node.type === "CallExpression" &&
          node.callee?.type === "Identifier" && node.arguments.length === 1 &&
          node.arguments[0]?.type === "Identifier" &&
          node.arguments[0].name === account[0].left.name, { skipNestedFunctions: true });
        for (const call of calls) hooks.add(call.callee.name);
      }
    }
    if (hooks.size !== 1) continue;
    candidates.push({
      initializer: fn,
      atom: account[0].left.name,
      hook: [...hooks][0],
    });
  }
  if (candidates.length !== 1) {
    throw new Error(`当前 App Server 认证状态数量异常（${candidates.length}）`);
  }
  return candidates[0];
}

function findGateBridge(allFunctions, source) {
  const candidates = allFunctions.filter((node) => {
    const text = source.slice(node.start, node.end);
    return (text.includes("set-remote-control-connections-enabled") || text.includes("setRemoteControlEnabled")) &&
      text.includes("remote-connections/gate-bridge") && text.includes("1042620455");
  });
  if (candidates.length !== 1) {
    throw new Error(`Remote Control gate bridge 数量异常（${candidates.length}）`);
  }
  const fn = candidates[0];
  const declarations = descendants(fn, (node) => node.type === "VariableDeclarator", {
    skipNestedFunctions: true,
  });
  const gateState = declarations.filter((node) => {
    if (node.id?.type !== "ObjectPattern" || node.init?.type !== "CallExpression" ||
        node.init.callee?.type !== "Identifier") return false;
    const properties = new Map(node.id.properties.map((property) => [
      property.key?.name ?? literal(property.key),
      property.value?.name,
    ]));
    return properties.has("checkGate") && properties.has("isLoading");
  });
  if (gateState.length !== 1) throw new Error("Remote Control gate 状态 Hook 结构异常");
  const gateProperties = new Map(gateState[0].id.properties.map((property) => [
    property.key?.name ?? literal(property.key),
    property.value?.name,
  ]));
  const checkGate = gateProperties.get("checkGate");
  const gateLoading = gateProperties.get("isLoading");
  const gateCalls = descendants(fn, (node) =>
    node.type === "CallExpression" && node.callee?.type === "Identifier" &&
    node.callee.name === checkGate, {
      skipNestedFunctions: true,
    });
  const remoteGate = gateCalls.filter((node) =>
    node.arguments.some((argument) => literal(argument) === "1042620455"));
  const oneToOneGate = gateCalls.filter((node) =>
    node.arguments.length === 1 && node.arguments[0]?.type === "Identifier");
  if (remoteGate.length !== 1 || oneToOneGate.length !== 1) {
    throw new Error("Remote Control gate 调用结构异常");
  }
  const catches = descendants(fn, (node) =>
    node.type === "CallExpression" && propertyName(node.callee) === "catch" &&
    node.callee.object?.type === "CallExpression" &&
    (node.callee.object.arguments.some((argument) =>
      literal(argument) === "set-remote-control-connections-enabled") ||
      propertyName(node.callee.object.callee) === "setRemoteControlEnabled"));
  if (catches.length !== 1 ||
      catches[0].arguments.length !== 1) {
    throw new Error("Remote Control gate bridge IPC 结构异常");
  }
  const effects = descendants(fn, (node) =>
    node.type === "CallExpression" && propertyName(memberCallee(node)) === "useEffect");
  const effectCallee = effects.length === 1 ? memberCallee(effects[0]) : null;
  if (effectCallee?.object.type !== "Identifier") {
    throw new Error("Remote Control gate bridge useEffect 结构异常");
  }
  const sync = catches[0].callee.object;
  let nativeService;
  if (propertyName(sync.callee) === "setRemoteControlEnabled") {
    const service = descendants(fn, node => node.type === "VariableDeclarator" &&
      node.id.name === sync.callee.object?.name && propertyName(node.init) === "remoteConnections");
    if (service.length !== 1 || sync.arguments.length !== 1 ||
        sync.arguments[0].type !== "ObjectExpression" ||
        !["enabled", "oneToOnePairingInAppEnabled"].every(name =>
          sync.arguments[0].properties.some(node => node.key?.name === name))) {
      throw new Error("Remote Control native bridge 结构异常");
    }
    nativeService = source.slice(service[0].init.start, service[0].init.end);
  } else if (sync.callee.type !== "Identifier") {
    throw new Error("Remote Control gate bridge IPC 结构异常");
  }
  return {
    fn,
    gateHook: gateState[0].init.callee.name,
    checkGate,
    gateLoading,
    oneToOneGate: oneToOneGate[0].arguments[0].name,
    ipc: catches[0].callee.object.callee.name,
    catchHandler: source.slice(catches[0].arguments[0].start, catches[0].arguments[0].end),
    react: effectCallee.object.name,
    nativeService,
  };
}

function count(source, value) {
  return source.split(value).length - 1;
}

function validatePatchedSource(source) {
  if (count(source, MARKER) !== 1) throw new Error(`${MARKER} 数量异常`);
  if (count(source, GATE_MARKER) !== 1) throw new Error(`${GATE_MARKER} 数量异常`);
  if (source.includes("codex-remote-gate:")) throw new Error("仍存在强制开启 Remote Control gate 的旧标记");
  if (!source.includes("__codexRemoteAccount?.authMethod!==`chatgpt`") ||
      !(source.includes("__codexSetRemoteEnabled(!1)") || source.includes(CATALOG_MARKER)) ||
      !source.includes("__codexRemoteAccount?.authLoading") ||
      !source.includes("__codexRemoteGateAccount?.authMethod===`chatgpt`") ||
      !source.includes("__codexRemoteGateAccount?.authLoading")) {
    throw new Error("Remote Control 认证隔离或遗留状态清理不完整");
  }
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const isolated = descendants(ast, node => node.type === "IfStatement" &&
    source.slice(node.test.start, node.test.end) === "__codexRemoteAccount?.authMethod!==`chatgpt`");
  if (isolated.length !== 1 || isolated[0].consequent.type !== "BlockStatement" ||
      isolated[0].consequent.body.at(-1)?.type !== "ReturnStatement") {
    throw new Error("Remote Control 非 ChatGPT disable 分支缺失");
  }
  const disableCalls = descendants(isolated[0].consequent, node => node.type === "CallExpression" &&
    propertyName(node.callee) === "catch" && node.callee.object?.type === "CallExpression" &&
    node.callee.object.callee.type === "Identifier" && node.callee.object.arguments.length === 2 &&
    node.callee.object.arguments[0].type === "Identifier" &&
    source.slice(node.callee.object.arguments[1].start, node.callee.object.arguments[1].end) === "!1");
  if (disableCalls.length !== 1) throw new Error("Remote Control 非 ChatGPT 未强制同步 disable");
}

function catalogContext(ast, allFunctions, source, resolveModule) {
  if (!resolveModule) throw new Error("Remote Control catalog 需要真实 import/export 依赖资源");
  const remote = allFunctions.filter(fn => source.slice(fn.start, fn.end)
    .includes("Failed to sync local remote control enablement"));
  if (remote.length !== 1) throw new Error("Remote Control catalog 同步组件数量异常");
  const fn = remote[0];
  const declarations = descendants(fn, node => node.type === "VariableDeclarator", { skipNestedFunctions: true });
  const catches = descendants(fn, node => node.type === "CallExpression" &&
    propertyName(node.callee) === "catch" && node.callee.object?.type === "CallExpression" &&
    node.callee.object.callee.type === "Identifier" && node.callee.object.arguments.length === 2);
  if (catches.length !== 1) throw new Error("Remote Control catalog 同步调用结构异常");
  const sync = catches[0].callee.object;
  const [container, stored] = sync.arguments;
  const state = declarations.find(node => node.id.name === stored?.name);
  const containerDeclaration = declarations.find(node => node.id.name === container?.name);
  if (state?.init?.type !== "CallExpression" || state.init.callee.type !== "Identifier" ||
      state.init.arguments.length !== 1 || state.init.arguments[0].type !== "Identifier" ||
      containerDeclaration?.init == null) throw new Error("Remote Control catalog atom 读取结构异常");
  const imports = ast.body.filter(node => node.type === "ImportDeclaration");
  const dependency = imports.find(node => node.specifiers.some(item => item.local.name === state.init.arguments[0].name));
  if (!dependency || !/^\.\/app-initial-[^/]+\.js$/.test(dependency.source.value)) {
    throw new Error("Remote Control catalog atom 来源异常");
  }
  const dependencySource = resolveModule(dependency.source.value);
  const dependencyAst = parse(dependencySource, { ecmaVersion: "latest", sourceType: "module" });
  const exports = dependencyAst.body.filter(node => node.type === "ExportNamedDeclaration").flatMap(node => node.specifiers);
  const imported = dependency.specifiers.find(item => item.local.name === state.init.arguments[0].name);
  const catalogExport = exports.find(item => item.exported.name === imported.imported.name);
  const catalog = descendants(dependencyAst, node => node.type === "AssignmentExpression" &&
    node.left.name === catalogExport?.local.name && descendants(node.right,
      member => propertyName(member) === "localRemoteControlEnabled").length === 1);
  if (catalog.length !== 1) throw new Error("Remote Control catalog enabled selector 定义异常");
  const fields = ["accountLoading", "authLoading", "authMethod", "authenticatedAccountId",
    "hasChatGptToken", "requiresAuth", "supportedSurface"];
  const accounts = [];
  for (const initializer of functions(dependencyAst)) {
    for (const assignment of descendants(initializer, node => node.type === "AssignmentExpression" &&
      node.left.type === "Identifier" && node.left.name !== initializer.id.name && node.right.type === "CallExpression")) {
      const text = dependencySource.slice(assignment.start, assignment.end);
      if (fields.every(field => text.includes(field))) accounts.push({ assignment, initializer });
    }
  }
  if (accounts.length !== 1) throw new Error(`当前 catalog App Server 认证 atom 数量异常（${accounts.length}）`);
  const account = accounts[0];
  let importText = "";
  const names = [account.assignment.left.name, account.initializer.id.name].map((name, index) => {
    const exported = exports.filter(item => item.local.name === name);
    if (exported.length !== 1) throw new Error("当前认证 atom 或初始化器未唯一导出");
    const local = dependency.specifiers.filter(item => item.imported?.name === exported[0].exported.name);
    if (local.length === 0 && index === 1 && !source.includes("__codexRemoteAuthInit")) {
      importText = `import{${exported[0].exported.name} as __codexRemoteAuthInit}from${JSON.stringify(dependency.source.value)};`;
      return "__codexRemoteAuthInit";
    }
    if (local.length !== 1) throw new Error("当前认证 atom 或初始化器未真实导入 runtime");
    return local[0].local.name;
  });
  const effect = descendants(fn, node => node.type === "CallExpression" &&
    propertyName(memberCallee(node)) === "useEffect");
  if (effect.length !== 1) throw new Error("Remote Control catalog effect 结构异常");
  return {
    remote: { fn, container: container.name, storedValue: stored.name,
      containerExpression: source.slice(containerDeclaration.init.start, containerDeclaration.init.end),
      catalogRead: source.slice(state.init.start, state.init.end), syncFunction: sync.callee.name,
      catchHandler: source.slice(catches[0].arguments[0].start, catches[0].arguments[0].end),
      react: memberCallee(effect[0]).object.name },
    currentAuth: { atom: names[0], hook: state.init.callee.name, initializer: { id: { name: names[1] } }, importText },
  };
}

function patchSource(source, { resolveModule } = {}) {
  if (source.includes(MARKER) || source.includes(GATE_MARKER)) {
    try {
      validatePatchedSource(source);
      return { status: "already-patched", source };
    } catch (error) {
      return { status: "unexpected-shape", source, reason: error.message };
    }
  }
  if (!source.includes("Failed to sync local remote control enablement")) {
    return { status: "not-applicable", source };
  }
  if (source.includes("codex-remote-gate:")) {
    return {
      status: "unexpected-shape",
      source,
      reason: "输入 Bundle 已包含旧 Remote Control gate 补丁，必须从官方资源重新生成",
    };
  }

  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const allFunctions = functions(ast);
    // 26.1021 改读 host catalog，没有旧本地开关 setter；仍通过原同步函数
    // 发送 app-server disable，并通过 native bridge 同步 false，不能伪造 ChatGPT。
    const catalog = !source.includes(STORAGE_KEY) ? catalogContext(ast, allFunctions, source, resolveModule) : null;
    const remote = catalog?.remote ?? findRemoteSync(allFunctions, source);
    const currentAuth = catalog?.currentAuth ?? findCurrentAuth(allFunctions, source);
    const gate = findGateBridge(allFunctions, source);
    const remoteInitializer = nextInitializer(allFunctions, remote.fn, source);
    const gateInitializer = nextInitializer(allFunctions, gate.fn, source);
    const stateRead = catalog ? `${remote.storedValue}=${remote.catalogRead}` :
      `[${remote.storedValue},__codexSetRemoteEnabled]=${remote.storageHook}(\`${STORAGE_KEY}\`)`;
    const clearLegacy = catalog ? "" : `${remote.storedValue}===!0&&__codexSetRemoteEnabled(!1),`;
    const replacement = `function ${remote.fn.id.name}(){let ${remote.container}=${remote.containerExpression},${stateRead},__codexRemoteAccount=${currentAuth.hook}(${currentAuth.atom});${remote.react}.useEffect(()=>{if(__codexRemoteAccount?.authLoading)return;if(__codexRemoteAccount?.authMethod!==\`chatgpt\`){${clearLegacy}${remote.syncFunction}(${remote.container},!1).catch(${remote.catchHandler});return}${remote.storedValue}!=null&&${remote.syncFunction}(${remote.container},${remote.storedValue}).catch(${remote.catchHandler})},[__codexRemoteAccount?.authMethod,__codexRemoteAccount?.authLoading,${remote.storedValue},${catalog ? "" : "__codexSetRemoteEnabled,"}${remote.container}]);return null}${MARKER}${catalog ? CATALOG_MARKER : ""}`;
    const syncGate = gate.nativeService ? `let __codexRemoteConnections=${gate.nativeService};__codexRemoteConnections!=null&&__codexRemoteConnections.setRemoteControlEnabled({enabled:o,oneToOnePairingInAppEnabled:i}).catch(${gate.catchHandler})` : `${gate.ipc}(\`set-remote-control-connections-enabled\`,{params:{enabled:o,oneToOnePairingInAppEnabled:i}}).catch(${gate.catchHandler})`;
    const gateReplacement = `function ${gate.fn.id.name}(){let{checkGate:${gate.checkGate},isLoading:${gate.gateLoading}}=${gate.gateHook}(),__codexRemoteGateAccount=${currentAuth.hook}(${currentAuth.atom}),i=__codexRemoteGateAccount?.authMethod===\`chatgpt\`&&${gate.checkGate}(${gate.oneToOneGate}),o=__codexRemoteGateAccount?.authMethod===\`chatgpt\`&&(${gate.checkGate}(\`1042620455\`)||i);${gate.react}.useEffect(()=>{if(${gate.gateLoading}||__codexRemoteGateAccount?.authLoading)return;${syncGate}},[${gate.gateLoading},i,o,__codexRemoteGateAccount?.authLoading,__codexRemoteGateAccount?.authMethod]);return null}${GATE_MARKER}`;
    const currentAuthInit = `${currentAuth.initializer.id.name}(),`;
    const edits = [
      { start: remote.fn.start, end: remote.fn.end, replacement },
      { start: gate.fn.start, end: gate.fn.end, replacement: gateReplacement },
      {
        start: remoteInitializer.body.start + 1,
        end: remoteInitializer.body.start + 1,
        replacement: currentAuthInit,
      },
      {
        start: gateInitializer.body.start + 1,
        end: gateInitializer.body.start + 1,
        replacement: currentAuthInit,
      },
    ].sort((a, b) => b.start - a.start);
    if (currentAuth.importText) edits.push({ start: 0, end: 0, replacement: currentAuth.importText });
    let next = source;
    for (const edit of edits) {
      next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
    }
    validatePatchedSource(next);
    return { status: "patched", source: next };
  } catch (error) {
    return { status: "unexpected-shape", source, reason: error.message };
  }
}

function targetDirectories(platform) {
  const requested = platform ? [platform] : PLATFORMS;
  return requested.map((item) => ({
    platform: item,
    path: path.join(SRC_DIR, item, "_asar", "webview", "assets"),
  })).filter((item) => fs.existsSync(item.path));
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => PLATFORMS.includes(arg));
  const check = args.includes("--check");
  const directories = targetDirectories(platform);
  let failed = 0;
  let patched = 0;

  for (const directory of directories) {
    try {
      const results = fs.readdirSync(directory.path)
        .filter((name) => name.endsWith(".js"))
        .map((name) => ({ name, path: path.join(directory.path, name) }))
        .map((file) => ({ ...file, source: fs.readFileSync(file.path, "utf8") }))
        .map((file) => ({ file, result: patchSource(file.source, { resolveModule: name =>
          fs.readFileSync(path.join(directory.path, name), "utf8") }) }))
        .filter((item) => item.result.status !== "not-applicable");
      if (results.length !== 1) throw new Error(`Remote Control Bundle 数量异常（${results.length}）`);
      const target = results[0];
      if (target.result.status === "unexpected-shape") throw new Error(target.result.reason);
      console.log(`  [${directory.platform}] ${relPath(target.file.path)}`);
      if (target.result.status === "already-patched") {
        console.log("    [ok] Remote Control 已按认证方式隔离");
      } else if (check) {
        console.log("    [ok] Remote Control 认证隔离结构已核对；dry-run 未写文件");
      } else {
        fs.writeFileSync(target.file.path, target.result.source, "utf8");
        patched++;
        console.log("    [ok] 非 ChatGPT 已同步禁用 Remote Control；ChatGPT 保持官方行为");
      }
    } catch (error) {
      failed++;
      console.error(`  [fail] ${directory.platform}: ${error.message}`);
    }
  }

  if (directories.length === 0) console.log("[skip] No generated platform assets found");
  if (failed > 0) process.exitCode = 1;
  else console.log(check ? "[check] Remote Control patch verified" : `[done] ${patched} file(s) patched`);
}

if (require.main === module) main();

module.exports = { MARKER, patchSource, validatePatchedSource };
