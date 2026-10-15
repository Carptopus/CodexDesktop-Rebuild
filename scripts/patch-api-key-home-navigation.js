#!/usr/bin/env node
/**
 * 补齐 API-key 模式的首页导航记录。
 *
 * 上游的读取端会使用 auth:apikey 查找最近位置，但写入端同时受
 * ChatGPT capability 限制，导致 API-key 下从不写入、点击首页落到空路由。
 * 这里只放行 apikey 写入，不开启 ChatGPT capability，也不改变其他认证方式。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "/* Codex：API-key 首页恢复写入。 */";
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
    if (guard.left?.type !== "LogicalExpression" || guard.left.operator !== "&&") continue;

    candidates.push({ authMethod: auth[0].authMethod, gate: guard.left.right });
  }
  if (candidates.length > 1) throw new Error(`首页导航跟踪器 数量异常（${candidates.length}）`);
  return candidates[0] ?? null;
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
    if (tracker == null) {
      if (source.includes(MARKER)) throw new Error("补丁标记存在但导航跟踪器结构未知");
      return { status: "not-applicable", source };
    }
    if (isApiKeyOverride(tracker.gate, tracker.authMethod)) {
      const gateSource = source.slice(tracker.gate.start, tracker.gate.end);
      if (!gateSource.includes(MARKER)) throw new Error("API-key 放行逻辑存在但缺少本项目标记");
      return { status: "already-patched", source };
    }
    if (tracker.gate.type !== "Identifier") {
      throw new Error("ChatGPT capability 条件结构未知");
    }
    const originalGate = source.slice(tracker.gate.start, tracker.gate.end);
    const replacement = `(${originalGate}||${MARKER}${tracker.authMethod}===\`apikey\`)`;
    const next = source.slice(0, tracker.gate.start) + replacement + source.slice(tracker.gate.end);
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
        console.log("    [ok] API-key 首页导航记录已启用");
      } else if (check) {
        console.log("    [ok] API-key 首页导航写入锚点已核对；dry-run 未写文件");
      } else {
        fs.writeFileSync(target.file.path, target.result.source, "utf8");
        patched++;
        console.log("    [ok] API-key 将使用 auth:apikey 保存并恢复当前会话");
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
module.exports = { MARKER, patchSource };
