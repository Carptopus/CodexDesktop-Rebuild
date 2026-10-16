#!/usr/bin/env node
/**
 * 补齐 API-key 模式的首页导航记录。
 *
 * 上游的读取端会使用 auth:apikey 查找最近位置，但写入端同时受
 * 新导航模式和 ChatGPT capability 限制，导致 API-key 下从不写入。
 * 同时，侧栏房子按钮使用独立的 openHome 分支直接导航到 `/`，不会进入
 * 上述首页恢复函数。这里只给该按钮传入真实 authMethod，并在 API-key 已经
 * 位于 `/local/<id>` 或 `/remote/<id>` 时短路；根路径和非会话页面仍执行
 * 官方导航。
 * 补丁不开启 ChatGPT 账户能力，也不改变其他认证方式。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "/* Codex：API-key 首页恢复写入。 */";
const CURRENT_HOME_MARKER = "/* Codex：API-key 当前首页保持会话。 */";
const PLATFORMS = ["mac-arm64", "mac-x64", "win", "unix"];

function walk(node, visit, root = node, ownScope = false) {
  if (!node || typeof node !== "object" || !node.type) return;
  if (ownScope && node !== root && /Function/.test(node.type)) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, root, ownScope);
    } else if (value?.type) {
      walk(value, visit, root, ownScope);
    }
  }
}

function nodes(root, predicate, ownScope = false) {
  const found = [];
  walk(root, node => { if (predicate(node)) found.push(node); }, root, ownScope);
  return found;
}

function literal(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

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

function unique(items, label) {
  if (items.length !== 1) throw new Error(`${label} 数量异常（${items.length}）`);
  return items[0];
}

function findTracker(ast) {
  const candidates = [];
  for (const fn of ast.body.filter(node => node.type === "FunctionDeclaration")) {
    const own = nodes(fn, () => true, true);
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
    }, true);
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
      callers.push({
        authMethod: authBindings[0],
        call,
        options,
        passedAuthMethod: objectProperty(options, "authMethod")?.value,
      });
    }
  }
  const caller = unique(callers, "房子按钮调用点");
  const markerPresent = source.slice(route.fn.start, route.fn.end).includes(CURRENT_HOME_MARKER);
  return { ...route, caller, markerPresent };
}

function isApiKeyOverride(node, authMethod) {
  if (node?.type !== "LogicalExpression" || node.operator !== "||") return false;
  const comparison = node.right;
  return comparison?.type === "BinaryExpression" && ["===", "=="].includes(comparison.operator) &&
    comparison.left?.type === "Identifier" && comparison.left.name === authMethod &&
    literal(comparison.right) === "apikey";
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
    if (tracker == null || openHome == null) {
      if (source.includes(MARKER) || source.includes(CURRENT_HOME_MARKER)) {
        throw new Error("补丁标记存在但首页导航结构未知");
      }
      return { status: "not-applicable", source };
    }
    const trackerPatched = isApiKeyOverride(tracker.gate, tracker.authMethod);
    const openHomePatched = openHome.markerPresent &&
      openHome.authMethod === "__codexAuthMethod" &&
      openHome.caller.passedAuthMethod?.type === "Identifier" &&
      openHome.caller.passedAuthMethod.name === openHome.caller.authMethod;
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
    if (trackerPatched && openHomePatched) return { status: "already-patched", source };

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
        replacement: `if(${CURRENT_HOME_MARKER}__codexAuthMethod===\`apikey\`&&${openHome.currentLocation}!=null&&(${openHome.currentLocation}.pathname.startsWith(\`/local/\`)||${openHome.currentLocation}.pathname.startsWith(\`/remote/\`)))return;`,
      });
    }
    let next = source;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
    }
    parse(next, { ecmaVersion: "latest", sourceType: "module" });
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
module.exports = { CURRENT_HOME_MARKER, MARKER, patchSource };
