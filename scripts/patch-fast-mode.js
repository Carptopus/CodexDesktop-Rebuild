#!/usr/bin/env node
/**
 * 为 API-key / 自定义 Provider 接入新版 serviceTierAccess。
 *
 * 官方账户会从 ChatGPT requirements 读取 Fast / Ultrafast 权限；API-key
 * 没有这份账户数据，因此 UI 和请求层都会得到 null。这里仅为 apikey
 * 跳过账户查询，模型是否显示具体档位仍由官方 model/list 返回的
 * serviceTierOptions 决定。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];
const SETTINGS_AUTH_MARKER = "/* CodexRebuildServiceTierApiKeyAuth */";
const SETTINGS_ACCESS_MARKER = "/* CodexRebuildServiceTierApiKeyAccess */";
const REQUEST_ACCESS_MARKER = "/* CodexRebuildServiceTierApiKeyRequest */";

function isFunctionNode(node) {
  return node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression";
}

function nodes(root, predicate, { skipNestedFunctions = false } = {}) {
  const found = [];
  function visit(node, parent = null) {
    if (!node || typeof node !== "object") return;
    if (node !== root && skipNestedFunctions && isFunctionNode(node)) return;
    if (node.type && predicate(node, parent)) found.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (["type", "start", "end"].includes(key)) continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item, node);
      } else {
        visit(child, node);
      }
    }
  }
  visit(root);
  return found;
}

function literal(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

function flattenLogical(node, operator) {
  if (node?.type !== "LogicalExpression" || node.operator !== operator) return [node];
  return [...flattenLogical(node.left, operator), ...flattenLogical(node.right, operator)];
}

function comparisonOperand(node, source, operator, value) {
  if (node?.type !== "BinaryExpression" || node.operator !== operator) return null;
  if (literal(node.right) === value) return source.slice(node.left.start, node.left.end);
  if (literal(node.left) === value) return source.slice(node.right.start, node.right.end);
  return null;
}

function exactAuthPair(node, source, logicalOperator, comparisonOperator) {
  if (node?.type !== "LogicalExpression" || node.operator !== logicalOperator) return null;
  const terms = flattenLogical(node, logicalOperator);
  if (terms.length !== 2) return null;
  const chatGpt = terms.map((term) =>
    comparisonOperand(term, source, comparisonOperator, "chatgpt")).find(Boolean);
  const token = terms.map((term) =>
    comparisonOperand(term, source, comparisonOperator, "personalAccessToken")).find(Boolean);
  return chatGpt != null && chatGpt === token ? chatGpt : null;
}

function count(source, value) {
  return source.split(value).length - 1;
}

function returnsNull(statement) {
  return statement?.type === "ReturnStatement" && literal(statement.argument) === null;
}

function findSettingsTarget(ast, source) {
  const candidates = [];
  for (const fn of nodes(ast, isFunctionNode)) {
    const fnSource = source.slice(fn.start, fn.end);
    if (!["serviceTierAccess", "isLoading", "chatgpt", "personalAccessToken", "authMethod"]
      .every((value) => fnSource.includes(value))) continue;

    const declarations = nodes(fn, (node) => node.type === "VariableDeclarator", {
      skipNestedFunctions: true,
    });
    const authDeclarations = declarations.filter((node) =>
      node.id?.type === "Identifier" &&
      exactAuthPair(node.init, source, "||", "===") != null);
    if (authDeclarations.length !== 1) continue;
    const authDeclaration = authDeclarations[0];
    const gate = authDeclaration.id.name;
    const authExpression = exactAuthPair(authDeclaration.init, source, "||", "===");

    const pendingTerms = nodes(fn, (node) =>
      node.type === "LogicalExpression" && node.operator === "&&" &&
      node.left?.type === "Identifier" && node.left.name === gate &&
      node.right?.type === "Identifier", { skipNestedFunctions: true });
    const accessConditions = nodes(fn, (node) => {
      if (node.type !== "ConditionalExpression" || literal(node.alternate) !== null ||
          node.consequent?.type !== "CallExpression") return false;
      const identifiers = nodes(node.test, (item) => item.type === "Identifier")
        .map((item) => item.name);
      return identifiers.includes(gate) && source.slice(node.test.start, node.test.end).includes("!=null");
    }, { skipNestedFunctions: true });
    if (pendingTerms.length !== 1 || accessConditions.length !== 1) continue;
    candidates.push({
      authDeclaration,
      authExpression,
      gate,
      pending: pendingTerms[0],
      access: accessConditions[0],
    });
  }
  if (candidates.length !== 1) {
    throw new Error(`serviceTierAccess 设置门槛数量异常（${candidates.length}）`);
  }
  return candidates[0];
}

function findRequestTarget(ast, source) {
  const declarations = new Map(nodes(ast, (node) => node.type === "FunctionDeclaration")
    .filter((node) => node.id?.name)
    .map((node) => [node.id.name, node]));
  const callers = nodes(ast, (node) => isFunctionNode(node) &&
    source.slice(node.start, node.end).includes("Failed to read service tier for request"));
  if (callers.length !== 1) {
    throw new Error(`service tier 请求读取器数量异常（${callers.length}）`);
  }
  const awaitedNames = nodes(callers[0], (node) =>
    node.type === "AwaitExpression" &&
    node.argument?.type === "CallExpression" &&
    node.argument.callee?.type === "Identifier", { skipNestedFunctions: true })
    .map((node) => node.argument.callee.name);
  const candidates = [];
  for (const name of awaitedNames) {
    const fn = declarations.get(name);
    if (!fn?.async) continue;
    const guards = nodes(fn, (node) =>
      node.type === "IfStatement" &&
      returnsNull(node.consequent) &&
      exactAuthPair(node.test, source, "&&", "!==") != null,
    { skipNestedFunctions: true });
    if (guards.length !== 1) continue;
    candidates.push({
      authExpression: exactAuthPair(guards[0].test, source, "&&", "!=="),
      guard: guards[0],
    });
  }
  if (candidates.length !== 1) {
    throw new Error(`serviceTierAccess 请求门槛数量异常（${candidates.length}）`);
  }
  return candidates[0];
}

function validatePatchedSource(source) {
  for (const marker of [SETTINGS_AUTH_MARKER, SETTINGS_ACCESS_MARKER, REQUEST_ACCESS_MARKER]) {
    if (count(source, marker) !== 1) throw new Error(`${marker} 数量异常`);
  }
  const escapedMarker = SETTINGS_AUTH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`===\`apikey\`\\?${escapedMarker}\`apikey\`:`).test(source)) {
    throw new Error("API-key serviceTierAccess 认证标记结构异常");
  }
  if (!source.includes(`{fast:!0,ultrafast:!0}${SETTINGS_ACCESS_MARKER}`) ||
      !source.includes(`{fast:!0,ultrafast:!0}${REQUEST_ACCESS_MARKER}`)) {
    throw new Error("API-key Fast/Ultrafast 权限标记结构异常");
  }
  parse(source, { ecmaVersion: "latest", sourceType: "module" });
}

function patchSource(source) {
  const markerCount = [SETTINGS_AUTH_MARKER, SETTINGS_ACCESS_MARKER, REQUEST_ACCESS_MARKER]
    .reduce((total, marker) => total + count(source, marker), 0);
  if (markerCount > 0) {
    try {
      validatePatchedSource(source);
      return { status: "already-patched", source, patches: [] };
    } catch (error) {
      return { status: "unexpected-shape", source, patches: [], reason: error.message };
    }
  }
  if (!["serviceTierAccess", "personalAccessToken", "Failed to read service tier for request"]
    .every((value) => source.includes(value))) {
    return { status: "not-applicable", source, patches: [] };
  }

  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const settings = findSettingsTarget(ast, source);
    const request = findRequestTarget(ast, source);
    const originalAuth = source.slice(settings.authDeclaration.init.start, settings.authDeclaration.init.end);
    const originalPending = source.slice(settings.pending.start, settings.pending.end);
    const originalAccess = source.slice(settings.access.start, settings.access.end);
    const edits = [
      {
        id: "service_tier_settings_auth",
        start: settings.authDeclaration.init.start,
        end: settings.authDeclaration.init.end,
        replacement: `${settings.authExpression}===\`apikey\`?${SETTINGS_AUTH_MARKER}\`apikey\`:(${originalAuth})`,
      },
      {
        id: "service_tier_settings_pending",
        start: settings.pending.start,
        end: settings.pending.end,
        replacement: `${settings.gate}!==\`apikey\`&&(${originalPending})`,
      },
      {
        id: "service_tier_settings_access",
        start: settings.access.start,
        end: settings.access.end,
        replacement: `${settings.gate}===\`apikey\`?{fast:!0,ultrafast:!0}${SETTINGS_ACCESS_MARKER}:(${originalAccess})`,
      },
      {
        id: "service_tier_request_access",
        start: request.guard.start,
        end: request.guard.start,
        replacement: `if(${request.authExpression}===\`apikey\`)return{fast:!0,ultrafast:!0}${REQUEST_ACCESS_MARKER};`,
      },
    ].sort((a, b) => b.start - a.start);
    let next = source;
    for (const edit of edits) {
      next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
    }
    validatePatchedSource(next);
    return { status: "patched", source: next, patches: edits };
  } catch (error) {
    return { status: "unexpected-shape", source, patches: [], reason: error.message };
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
      const results = fs.readdirSync(directory.path).filter((name) => name.endsWith(".js"))
        .map((name) => ({ name, path: path.join(directory.path, name) }))
        .map((file) => ({ ...file, source: fs.readFileSync(file.path, "utf8") }))
        .filter((file) => file.source.includes("serviceTierAccess") ||
          file.source.includes(REQUEST_ACCESS_MARKER))
        .map((file) => ({ file, result: patchSource(file.source) }))
        .filter((item) => item.result.status !== "not-applicable");
      if (results.length !== 1) throw new Error(`Fast/Ultrafast Bundle 数量异常（${results.length}）`);
      const target = results[0];
      if (target.result.status === "unexpected-shape") throw new Error(target.result.reason);
      console.log(`  [${directory.platform}] ${relPath(target.file.path)}`);
      if (target.result.status === "already-patched") {
        console.log("    [ok] API-key Fast/Ultrafast serviceTierAccess 已接入");
      } else if (check) {
        console.log("    [ok] API-key serviceTierAccess 设置与请求门槛已核对；dry-run 未写文件");
      } else {
        fs.writeFileSync(target.file.path, target.result.source, "utf8");
        patched++;
        console.log("    [ok] API-key 跳过账户权限查询；显示档位仍由模型 serviceTierOptions 决定");
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
  REQUEST_ACCESS_MARKER,
  SETTINGS_ACCESS_MARKER,
  SETTINGS_AUTH_MARKER,
  patchSource,
};
