#!/usr/bin/env node
/**
 * 补齐 API-key 模式的首页导航记录。
 *
 * 上游的读取端会使用 auth:apikey 查找最近位置，但写入端同时受
 * 新导航模式和 ChatGPT capability 限制，导致 API-key 下从不写入。
 * 同时，旧导航模式不会把“当前会话已经属于首页”视为已到达目标，最终让
 * 首页按钮落到空路由。这里只允许非根路径的 API-key 当前会话短路；根路径
 * 仍须继续执行官方落地页导航，避免空数据启动停在没有页面组件的 `/`。
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

function returnsTrue(statement) {
  if (statement?.type !== "ReturnStatement") return false;
  if (literal(statement.argument) === true) return true;
  return statement.argument?.type === "UnaryExpression" && statement.argument.operator === "!" &&
    literal(statement.argument.argument) === 0;
}

function memberName(node) {
  if (node?.type === "ChainExpression") node = node.expression;
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return literal(node.property);
}

function memberRoot(node) {
  let current = node;
  while (current?.type === "MemberExpression" || current?.type === "ChainExpression") {
    current = current.type === "ChainExpression" ? current.expression : current.object;
  }
  return current?.type === "Identifier" ? current.name : null;
}

function findCurrentHomeGuard(ast) {
  const candidates = [];
  for (const fn of ast.body.filter(node => node.type === "FunctionDeclaration")) {
    const options = fn.params[1];
    if (options?.type !== "ObjectPattern") continue;
    const accountKey = objectBinding(options, "accountKey");
    const area = objectBinding(options, "area");
    const productMode = objectBinding(options, "productMode");
    if (!accountKey || !area || !productMode) continue;

    const guards = nodes(fn, node => {
      if (node.type !== "IfStatement" || !returnsTrue(node.consequent)) return false;
      const own = nodes(node.test, () => true);
      const identifiers = new Set(own.filter(item => item.type === "Identifier")
        .map(item => item.name));
      return own.some(item => memberName(item) === "sidebarProductMode") &&
        identifiers.has(area) && identifiers.has(productMode);
    }, true);
    if (guards.length !== 1) continue;

    const sidebarModeMembers = nodes(guards[0].test,
      node => node.type === "MemberExpression" && memberName(node) === "sidebarProductMode");
    if (sidebarModeMembers.length !== 2) continue;
    const currentLocations = new Set(sidebarModeMembers.map(memberRoot).filter(Boolean));
    if (currentLocations.size !== 1) continue;
    const currentLocation = [...currentLocations][0];

    const modeChecks = nodes(guards[0].test, node => node.type === "LogicalExpression" &&
      node.operator === "&&" &&
      (node.left?.type === "Identifier" ||
        isAccountKeyOverride(node.left, accountKey, currentLocation)) &&
      node.right?.type === "BinaryExpression" && ["!=", "!=="].includes(node.right.operator) &&
      literal(node.right.right) === null);
    if (modeChecks.length !== 1) continue;
    candidates.push({
      accountKey,
      currentLocation,
      gate: modeChecks[0].left,
    });
  }
  if (candidates.length > 1) {
    throw new Error(`当前首页短路 数量异常（${candidates.length}）`);
  }
  return candidates[0] ?? null;
}

function isApiKeyOverride(node, authMethod) {
  if (node?.type !== "LogicalExpression" || node.operator !== "||") return false;
  const comparison = node.right;
  return comparison?.type === "BinaryExpression" && ["===", "=="].includes(comparison.operator) &&
    comparison.left?.type === "Identifier" && comparison.left.name === authMethod &&
    literal(comparison.right) === "apikey";
}

function isAccountKeyOverride(node, accountKey, currentLocation) {
  if (node?.type !== "LogicalExpression" || node.operator !== "||") return false;
  const override = node.right;
  if (override?.type !== "LogicalExpression" || override.operator !== "&&") return false;
  const account = override.left;
  const pathname = override.right;
  return account?.type === "BinaryExpression" && ["===", "=="].includes(account.operator) &&
    account.left?.type === "Identifier" && account.left.name === accountKey &&
    literal(account.right) === "auth:apikey" &&
    pathname?.type === "BinaryExpression" && ["!==", "!=", "===", "=="].includes(pathname.operator) &&
    memberName(pathname.left) === "pathname" && memberRoot(pathname.left) === currentLocation &&
    literal(pathname.right) === "/" && ["!==", "!="].includes(pathname.operator);
}

function patchSource(source) {
  if (!["authMethod", "accountKey", "productMode", "auth:", "chatgpt:"].every(value =>
    source.includes(value))) {
    return { status: "not-applicable", source };
  }
  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const tracker = findTracker(ast);
    const currentHome = findCurrentHomeGuard(ast);
    if (tracker == null || currentHome == null) {
      if (source.includes(MARKER) || source.includes(CURRENT_HOME_MARKER)) {
        throw new Error("补丁标记存在但首页导航结构未知");
      }
      return { status: "not-applicable", source };
    }
    const trackerPatched = isApiKeyOverride(tracker.gate, tracker.authMethod);
    const currentHomePatched = isAccountKeyOverride(
      currentHome.gate,
      currentHome.accountKey,
      currentHome.currentLocation,
    );
    if (trackerPatched) {
      const gateSource = source.slice(tracker.gate.start, tracker.gate.end);
      if (!gateSource.includes(MARKER)) throw new Error("API-key 放行逻辑存在但缺少本项目标记");
    } else if (tracker.gate.type !== "LogicalExpression" || tracker.gate.operator !== "&&" ||
      tracker.gate.left?.type !== "Identifier" || tracker.gate.right?.type !== "Identifier") {
      throw new Error("导航模式与 ChatGPT capability 条件结构未知");
    }
    if (currentHomePatched) {
      const gateSource = source.slice(currentHome.gate.start, currentHome.gate.end);
      if (!gateSource.includes(CURRENT_HOME_MARKER)) {
        throw new Error("API-key 当前首页逻辑存在但缺少本项目标记");
      }
    } else if (currentHome.gate.type !== "Identifier") {
      throw new Error("当前首页导航模式条件结构未知");
    }
    if (trackerPatched && currentHomePatched) return { status: "already-patched", source };

    const edits = [];
    if (!trackerPatched) {
      const originalGate = source.slice(tracker.gate.start, tracker.gate.end);
      edits.push({
        start: tracker.gate.start,
        end: tracker.gate.end,
        replacement: `(${originalGate}||${MARKER}${tracker.authMethod}===\`apikey\`)`,
      });
    }
    if (!currentHomePatched) {
      const originalGate = source.slice(currentHome.gate.start, currentHome.gate.end);
      edits.push({
        start: currentHome.gate.start,
        end: currentHome.gate.end,
        replacement: `(${originalGate}||${CURRENT_HOME_MARKER}${currentHome.accountKey}===\`auth:apikey\`&&${currentHome.currentLocation}?.pathname!==\`/\`)`,
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
