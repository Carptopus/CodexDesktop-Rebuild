#!/usr/bin/env node
/**
 * 补齐 API-key 模式的首页导航记录。
 *
 * 上游的读取端会使用 auth:apikey 查找最近位置，但写入端同时受
 * 新导航模式和 ChatGPT capability 限制，导致 API-key 下从不写入。
 * 同时，侧栏房子按钮使用独立的 openHome 分支直接导航到 `/`，不会进入
 * 上述首页恢复函数。这里只给该按钮传入真实 authMethod，并复用官方的
 * 首页区域分类器判断当前是否已经位于会话/首页区域。新版功能导航栏还有一条
 * “当前已经选中首页时再次点击”的直达 `/` 分支；API-key 必须跳过该分支，
 * 交回官方首页位置记录器，才能从设置等页面恢复最近会话。
 * 补丁不开启 ChatGPT 账户能力，也不改变其他认证方式。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { applyEdits, literal, nodes, unique } = require("./patch-ast-util");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "/* Codex：API-key 首页恢复写入。 */";
const CURRENT_HOME_MARKER = "/* Codex：API-key 当前首页保持会话。 */";
const HOME_RESELECT_MARKER = "/* Codex：API-key 首页恢复最近会话。 */";
const HOME_STATE_MARKER = "/* Codex：API-key 首页保持状态会话。 */";
const PLATFORMS = ["mac-arm64", "mac-x64", "win", "unix"];

function propertyName(property) {
  if (property?.type !== "Property") return null;
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  return literal(property.key);
}

function templatePrefix(node, prefix, expressionName) {
  return node?.type === "TemplateLiteral" && node.expressions.length === 1 &&
    node.quasis[0].value.cooked === prefix && node.quasis[1].value.cooked === "" &&
    node.expressions[0].type === "Identifier" && node.expressions[0].name === expressionName;
}

function objectBinding(pattern, name) {
  const property = pattern.properties.find(item => propertyName(item) === name);
  return property?.value?.type === "Identifier" ? property.value.name : null;
}

function optionBinding(pattern, name) {
  const property = pattern.properties.find(item => propertyName(item) === name);
  if (property?.value?.type === "Identifier") return property.value.name;
  return property?.value?.type === "AssignmentPattern" && property.value.left?.type === "Identifier"
    ? property.value.left.name : null;
}

function findTracker(ast) {
  const candidates = [];
  for (const fn of ast.body.filter(node => node.type === "FunctionDeclaration")) {
    const own = nodes(fn, () => true, { ownScope: true });
    const all = nodes(fn, () => true);
    const auth = own.filter(node => node.type === "VariableDeclarator" &&
      node.id?.type === "ObjectPattern" && node.init?.type === "CallExpression")
      .map(node => ({
        accountId: objectBinding(node.id, "accountId"),
        authMethod: objectBinding(node.id, "authMethod"),
      }))
      .filter(item => item.accountId && item.authMethod);
    if (auth.length !== 1) continue;

    const navigationObjects = all.filter(node => node.type === "ObjectExpression").map(node => {
      const properties = Object.fromEntries(node.properties
        .filter(item => item.type === "Property")
        .map(item => [propertyName(item), item.value]));
      return { node, properties };
    }).filter(item => ["accountKey", "location", "productMode"].every(name =>
      item.properties[name]?.type === "Identifier"));
    if (navigationObjects.length !== 1) continue;

    const accountKey = navigationObjects[0].properties.accountKey.name;
    const authAssignment = own.filter(node => node.type === "AssignmentExpression" &&
      node.operator === "=" && node.left?.type === "Identifier" &&
      node.left.name === accountKey &&
      templatePrefix(node.right, "auth:", auth[0].authMethod));
    const accountAssignment = own.filter(node => node.type === "AssignmentExpression" &&
      node.operator === "=" && node.left?.type === "Identifier" &&
      node.left.name === accountKey &&
      templatePrefix(node.right, "chatgpt:", auth[0].accountId));
    if (authAssignment.length !== 1 || accountAssignment.length !== 1) continue;

    const guards = own.filter(node => node.type === "LogicalExpression" && node.operator === "&&" &&
      node.start <= authAssignment[0].start && node.end >= authAssignment[0].end &&
      node.start <= accountAssignment[0].start && node.end >= accountAssignment[0].end);
    const outermost = guards.filter(node => !guards.some(other => other !== node &&
      other.start <= node.start && other.end >= node.end));
    if (outermost.length !== 1) continue;
    const guard = outermost[0];
    if (guard.left?.type !== "LogicalExpression") continue;

    candidates.push({ authMethod: auth[0].authMethod, gate: guard.left });
  }
  if (candidates.length > 1) throw new Error(`首页导航跟踪器 数量异常（${candidates.length}）`);
  return candidates[0] ?? null;
}

function isTrue(node) {
  return literal(node) === true || node?.type === "UnaryExpression" &&
    node.operator === "!" && literal(node.argument) === 0;
}

function memberName(node) {
  if (node?.type === "ChainExpression") node = node.expression;
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return literal(node.property);
}

function memberObject(node) {
  if (node?.type === "ChainExpression") node = node.expression;
  return node?.type === "MemberExpression" ? node.object : null;
}

function memberRoot(node) {
  let current = node;
  while (current?.type === "MemberExpression" || current?.type === "ChainExpression") {
    current = current.type === "ChainExpression" ? current.expression : current.object;
  }
  return current?.type === "Identifier" ? current.name : null;
}

function objectProperty(node, name) {
  return node?.properties?.find(property => propertyName(property) === name) ?? null;
}

function findOpenHomeRoute(ast, source) {
  const routes = [];
  for (const fn of ast.body.filter(node => node.type === "FunctionDeclaration")) {
    const options = fn.params[1];
    if (options?.type !== "ObjectPattern") continue;
    const bindings = Object.fromEntries([
      "codexLocalAccessStatus", "currentMode", "navigate", "nextMode", "openHome",
      "restoreNavigation", "startNewConversation", "authMethod",
    ].map(name => [name, optionBinding(options, name)]));
    if (["codexLocalAccessStatus", "currentMode", "navigate", "nextMode", "openHome",
      "restoreNavigation", "startNewConversation"].some(name => !bindings[name])) continue;

    const branches = nodes(fn, node => {
      if (node.type !== "IfStatement") return false;
      const testIdentifiers = nodes(node.test, item => item.type === "Identifier")
        .map(item => item.name);
      if (!testIdentifiers.includes(bindings.openHome)) return false;
      const body = nodes(node.consequent, () => true);
      return body.some(item => item.type === "ReturnStatement") &&
        body.some(item => item.type === "CallExpression" &&
          item.callee?.type === "Identifier" && item.callee.name === bindings.navigate &&
          literal(item.arguments[0]) === "/" &&
          item.arguments[1]?.type === "ObjectExpression" &&
          objectProperty(objectProperty(item.arguments[1], "state")?.value, "sidebarProductMode")?.value?.name === bindings.nextMode);
    }, { ownScope: true });
    if (branches.length !== 1) continue;

    const libraryRoots = new Set(nodes(fn, node => node.type === "CallExpression" &&
      memberName(node.callee) === "startsWith" && literal(node.arguments[0]) === "/library/" &&
      memberName(memberObject(node.callee)) === "pathname")
      .map(node => memberRoot(memberObject(node.callee))).filter(Boolean));
    const exactLibraryRoots = new Set(nodes(fn, node => node.type === "BinaryExpression" &&
      ["===", "=="].includes(node.operator) && literal(node.right) === "/library" &&
      memberName(node.left) === "pathname")
      .map(node => memberRoot(node.left)).filter(Boolean));
    const currentLocations = [...libraryRoots].filter(name => exactLibraryRoots.has(name));
    if (currentLocations.length !== 1) continue;
    routes.push({
      authMethod: bindings.authMethod,
      branch: branches[0],
      currentLocation: currentLocations[0],
      fn,
      options,
      name: fn.id?.name,
    });
  }
  const route = unique(routes, "房子按钮 openHome 路由");
  const callers = [];
  for (const fn of ast.body.filter(node => node.type === "FunctionDeclaration")) {
    const authBindings = nodes(fn, node => node.type === "VariableDeclarator" &&
      node.id?.type === "ObjectPattern", true)
      .map(node => objectBinding(node.id, "authMethod")).filter(Boolean);
    if (authBindings.length !== 1) continue;
    for (const call of nodes(fn, node => node.type === "CallExpression" &&
      node.callee?.type === "Identifier" && node.callee.name === route.name)) {
      const options = call.arguments[1];
      if (options?.type !== "ObjectExpression" ||
        !isTrue(objectProperty(options, "openHome")?.value) ||
        literal(objectProperty(options, "nextMode")?.value) !== "codex") continue;
      const homeClassifiers = nodes(fn, node => node.type === "BinaryExpression" &&
        ["===", "=="].includes(node.operator) && literal(node.right) === "home" &&
        node.left?.type === "CallExpression" && node.left.callee?.type === "Identifier" &&
        node.left.arguments.length === 1, { ownScope: true });
      if (homeClassifiers.length !== 1) continue;
      callers.push({
        authMethod: authBindings[0],
        call,
        homeClassifier: homeClassifiers[0].left.callee.name,
        options,
        passedAuthMethod: objectProperty(options, "authMethod")?.value,
      });
    }
  }
  const caller = unique(callers, "房子按钮调用点");
  const markedGuards = nodes(route.fn, node => node.type === "IfStatement" &&
    source.slice(node.start, node.consequent.start).includes(CURRENT_HOME_MARKER), { ownScope: true });
  if (markedGuards.length > 1) {
    throw new Error(`房子按钮当前会话守卫 数量异常（${markedGuards.length}）`);
  }
  const markerPresent = markedGuards.length === 1;
  const guardSource = markerPresent
    ? source.slice(markedGuards[0].test.start, markedGuards[0].test.end)
    : "";
  const currentAreaGuardPresent = guardSource.includes(
    `${caller.homeClassifier}(${route.currentLocation})===\`home\``,
  );
  return { ...route, caller, currentAreaGuardPresent, markerPresent };
}

function findHomeRailReselect(ast, source) {
  const candidates = [];
  for (const fn of ast.body.filter(node => node.type === "FunctionDeclaration")) {
    const authBindings = nodes(fn, node => node.type === "VariableDeclarator" &&
      node.id?.type === "ObjectPattern" && node.init?.type === "Identifier", true)
      .map(node => ({
        authMethod: objectBinding(node.id, "authMethod"),
        authState: node.init.name,
      }))
      .filter(item => item.authMethod);
    if (authBindings.length !== 1) continue;

    for (const arrow of nodes(fn, node => node.type === "ArrowFunctionExpression")) {
      const restoreCalls = nodes(arrow, node => {
        if (node.type !== "CallExpression" || node.arguments[1]?.type !== "ObjectExpression") return false;
        const options = node.arguments[1];
        return ["accountKey", "area", "navigate", "productMode", "state"].every(name =>
          objectProperty(options, name)?.value?.type === "Identifier");
      }, { ownScope: true });
      if (restoreCalls.length !== 1) continue;
      const restoreCall = restoreCalls[0];
      const options = restoreCall.arguments[1];
      const area = objectProperty(options, "area").value.name;
      const productMode = objectProperty(options, "productMode").value.name;
      const branches = nodes(arrow, node => {
        if (node.type !== "IfStatement" || node.start >= restoreCall.start) return false;
        const testNames = new Set(nodes(node.test, item => item.type === "Identifier")
          .map(item => item.name));
        if (!testNames.has(area) || !testNames.has(productMode)) return false;
        const body = nodes(node.consequent, () => true);
        return body.some(item => item.type === "ReturnStatement") &&
          body.some(item => memberName(item) === "path");
      }, { ownScope: true });
      if (branches.length !== 1) continue;
      const branch = branches[0];
      const store = restoreCall.arguments[0];
      if (store?.type !== "Identifier") continue;
      const currentLocationReads = nodes(branch.consequent, node =>
        node.type === "VariableDeclarator" && node.id?.type === "Identifier" &&
        node.init?.type === "CallExpression" && node.init.arguments.length === 1 &&
        memberName(node.init.callee) === "get" &&
        memberRoot(node.init.callee) === store.name &&
        node.init.arguments[0]?.type === "Identifier");
      if (currentLocationReads.length !== 1) continue;
      const currentLocationAtom = currentLocationReads[0].init.arguments[0].name;
      const parentFunctions = nodes(fn, node => /Function/.test(node.type))
        .filter(node => node !== arrow && node.start < arrow.start && node.end > arrow.end)
        .sort((left, right) => (left.end - left.start) - (right.end - right.start));
      const parentFunction = parentFunctions[0];
      if (parentFunction == null) continue;
      const visibleLocationReads = nodes(parentFunction, node =>
        node.type === "VariableDeclarator" && node.id?.type === "Identifier" &&
        node.init?.type === "CallExpression" && node.init.arguments.length === 1 &&
        memberName(node.init.callee) === "get" &&
        memberRoot(node.init.callee) === store.name &&
        node.init.arguments[0]?.type === "Identifier" &&
        node.init.arguments[0].name === currentLocationAtom, { ownScope: true });
      if (visibleLocationReads.length !== 1) continue;
      const markedStateGuards = nodes(arrow, node => node.type === "IfStatement" &&
        node.start < restoreCall.start &&
        source.slice(node.start, node.consequent.start).includes(HOME_STATE_MARKER),
      { ownScope: true });
      if (markedStateGuards.length > 1) {
        throw new Error(`功能导航栏当前首页守卫 数量异常（${markedStateGuards.length}）`);
      }
      candidates.push({
        authMethod: authBindings[0].authMethod,
        authState: authBindings[0].authState,
        branch,
        currentLocation: visibleLocationReads[0].id.name,
        markerPresent: source.slice(branch.start, restoreCall.start)
          .includes(HOME_RESELECT_MARKER),
        stateGuardSource: markedStateGuards.length === 1
          ? source.slice(markedStateGuards[0].test.start, markedStateGuards[0].test.end)
          : "",
        stateMarkerPresent: markedStateGuards.length === 1,
      });
    }
  }
  return unique(candidates, "功能导航栏首页重选分支");
}

function isApiKeyOverride(node, authMethod) {
  if (node?.type !== "LogicalExpression" || node.operator !== "||") return false;
  const comparison = node.right;
  return comparison?.type === "BinaryExpression" && ["===", "=="].includes(comparison.operator) &&
    comparison.left?.type === "Identifier" && comparison.left.name === authMethod &&
    literal(comparison.right) === "apikey";
}

function isApiKeyRailGuard(node, authState) {
  return nodes(node, item => item.type === "BinaryExpression" &&
    ["!==", "!="].includes(item.operator) &&
    memberName(item.left) === "authMethod" && memberRoot(item.left) === authState &&
    literal(item.right) === "apikey").length === 1;
}

function patchSource(source) {
  if (!["authMethod", "accountKey", "productMode", "auth:", "chatgpt:"].every(value =>
    source.includes(value))) {
    return { status: "not-applicable", source };
  }
  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const tracker = findTracker(ast);
    const openHome = findOpenHomeRoute(ast, source);
    const homeRail = findHomeRailReselect(ast, source);
    if (tracker == null || openHome == null || homeRail == null) {
      if (source.includes(MARKER) || source.includes(CURRENT_HOME_MARKER) ||
        source.includes(HOME_RESELECT_MARKER) || source.includes(HOME_STATE_MARKER)) {
        throw new Error("补丁标记存在但首页导航结构未知");
      }
      return { status: "not-applicable", source };
    }
    const trackerPatched = isApiKeyOverride(tracker.gate, tracker.authMethod);
    const openHomePatched = openHome.markerPresent && openHome.currentAreaGuardPresent &&
      openHome.authMethod === "__codexAuthMethod" &&
      openHome.caller.passedAuthMethod?.type === "Identifier" &&
      openHome.caller.passedAuthMethod.name === openHome.caller.authMethod;
    const homeRailPatched = homeRail.markerPresent && homeRail.stateMarkerPresent &&
      homeRail.stateGuardSource.includes(
        `${openHome.caller.homeClassifier}(${homeRail.currentLocation})===\`home\``,
      ) && isApiKeyRailGuard(homeRail.branch.test, homeRail.authState);
    if (trackerPatched) {
      const gateSource = source.slice(tracker.gate.start, tracker.gate.end);
      if (!gateSource.includes(MARKER)) throw new Error("API-key 放行逻辑存在但缺少本项目标记");
    } else if (tracker.gate.type !== "LogicalExpression" || tracker.gate.operator !== "&&" ||
      tracker.gate.left?.type !== "Identifier" || tracker.gate.right?.type !== "Identifier") {
      throw new Error("导航模式与 ChatGPT capability 条件结构未知");
    }
    const openHomePartiallyPatched = openHome.markerPresent || openHome.authMethod != null ||
      openHome.caller.passedAuthMethod != null;
    if (!openHomePatched && openHomePartiallyPatched) {
      throw new Error("房子按钮 API-key 保持逻辑不完整");
    }
    if ((homeRail.markerPresent || homeRail.stateMarkerPresent) && !homeRailPatched) {
      throw new Error("功能导航栏首页恢复逻辑不完整");
    }
    if (trackerPatched && openHomePatched && homeRailPatched) {
      return { status: "already-patched", source };
    }

    const edits = [];
    if (!trackerPatched) {
      const originalGate = source.slice(tracker.gate.start, tracker.gate.end);
      edits.push({
        start: tracker.gate.start,
        end: tracker.gate.end,
        replacement: `(${originalGate}||${MARKER}${tracker.authMethod}===\`apikey\`)`,
      });
    }
    if (!openHomePatched) {
      edits.push({
        start: openHome.options.start + 1,
        end: openHome.options.start + 1,
        replacement: "authMethod:__codexAuthMethod,",
      });
      edits.push({
        start: openHome.caller.options.start + 1,
        end: openHome.caller.options.start + 1,
        replacement: `authMethod:${openHome.caller.authMethod},`,
      });
      edits.push({
        start: openHome.branch.start,
        end: openHome.branch.start,
        replacement: `if(${CURRENT_HOME_MARKER}__codexAuthMethod===\`apikey\`&&${openHome.currentLocation}!=null&&${openHome.caller.homeClassifier}(${openHome.currentLocation})===\`home\`)return;`,
      });
    }
    if (!homeRailPatched) {
      const originalTest = source.slice(homeRail.branch.test.start, homeRail.branch.test.end);
      edits.push({
        start: homeRail.branch.start,
        end: homeRail.branch.start,
        replacement: `if(${HOME_STATE_MARKER}${homeRail.authState}.authMethod===\`apikey\`&&${homeRail.currentLocation}!=null&&${openHome.caller.homeClassifier}(${homeRail.currentLocation})===\`home\`)return;`,
      });
      edits.push({
        start: homeRail.branch.test.start,
        end: homeRail.branch.test.end,
        replacement: `(${HOME_RESELECT_MARKER}${homeRail.authState}.authMethod!==\`apikey\`&&(${originalTest}))`,
      });
    }
    const next = applyEdits(source, edits);
    return { status: "patched", source: next };
  } catch (error) {
    return { status: "unexpected-shape", source, reason: error.message };
  }
}

function targetDirectories(platform) {
  const directories = (platform ? [platform] : PLATFORMS)
    .map(name => ({ platform: name, path: path.join(SRC_DIR, name, "_asar", "webview", "assets") }))
    .filter(item => fs.existsSync(item.path));
  const legacy = path.join(SRC_DIR, "webview", "assets");
  if (!directories.length && fs.existsSync(legacy)) directories.push({ platform: "legacy", path: legacy });
  return directories;
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find(arg => PLATFORMS.includes(arg));
  const check = args.includes("--check");
  const directories = targetDirectories(platform);
  let failed = 0;
  let patched = 0;
  for (const directory of directories) {
    try {
      const results = fs.readdirSync(directory.path).filter(name => name.endsWith(".js"))
        .map(name => ({ name, path: path.join(directory.path, name) }))
        .map(file => ({ ...file, source: fs.readFileSync(file.path, "utf8") }))
        .filter(file => ["authMethod", "accountKey", "productMode", "auth:", "chatgpt:"]
          .every(value => file.source.includes(value)))
        .map(file => ({ file, result: patchSource(file.source) }))
        .filter(item => item.result.status !== "not-applicable");
      const target = unique(results, "首页导航 Bundle");
      if (target.result.status === "unexpected-shape") throw new Error(target.result.reason);
      console.log(`  [${directory.platform}] ${relPath(target.file.path)}`);
      if (target.result.status === "already-patched") {
        console.log("    [ok] API-key 首页导航记录和当前会话保持已启用");
      } else if (check) {
        console.log("    [ok] API-key 首页导航写入与当前会话锚点已核对；dry-run 未写文件");
      } else {
        fs.writeFileSync(target.file.path, target.result.source, "utf8");
        patched++;
        console.log("    [ok] API-key 将保存并恢复首页会话，当前会话点击首页保持不变");
      }
    } catch (error) {
      console.error(`  [x] ${directory.platform}: ${error.message}`);
      failed++;
    }
  }
  if (!directories.length) {
    console.error("  [x] 缺少目标平台界面资源");
    failed++;
  }
  if (failed) process.exitCode = 1;
  else console.log(`  [ok] ${patched} platform bundle(s) patched`);
}

if (require.main === module) main();
module.exports = {
  CURRENT_HOME_MARKER,
  HOME_RESELECT_MARKER,
  HOME_STATE_MARKER,
  MARKER,
  patchSource,
};
