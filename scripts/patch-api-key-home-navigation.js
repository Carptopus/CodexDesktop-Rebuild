#!/usr/bin/env node
/**
 * 补齐 API-key 模式的首页导航记录。
 *
 * 上游的读取端会使用 auth:apikey 查找最近位置，但写入端同时受
 * 新导航模式和 ChatGPT capability 限制，导致 API-key 下从不写入。
 * 官方公共首页恢复函数也只在 ChatGPT capability 可用时保持当前首页位置；
 * API-key 因而会把仍在使用的当前会话判为不可恢复并回退到空的 `/` 路由。
 * 这里让 auth:apikey 仅在请求 home 且当前位置仍属于 home 时复用官方短路，
 * 离开首页后仍由官方记录恢复逻辑处理，不再逐个修改具体按钮入口。
 * 补丁不开启 ChatGPT 账户能力，也不改变其他认证方式或其他导航区域。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { applyEdits, literal, nodes, unique } = require("./patch-ast-util");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "/* Codex：API-key 首页恢复写入。 */";
const HOME_CURRENT_MARKER = "/* Codex：API-key 首页保持当前位置。 */";
const HOME_STATE_MARKER = "/* Codex：API-key 首页保持当前。 */";
const HOME_RESTORE_MARKER = "/* Codex：API-key 首页从其他页面恢复会话。 */";
const LEGACY_MARKERS = [
  "/* Codex：API-key 当前首页保持会话。 */",
  "/* Codex：API-key 首页恢复最近会话。 */",
  "/* Codex：API-key 首页保持状态会话。 */",
];
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
    if (outermost.length !== 1 || outermost[0].left?.type !== "LogicalExpression") continue;

    candidates.push({ authMethod: auth[0].authMethod, gate: outermost[0].left });
  }
  if (candidates.length > 1) throw new Error(`首页导航跟踪器 数量异常（${candidates.length}）`);
  return candidates[0] ?? null;
}

function isTrue(node) {
  return literal(node) === true || node?.type === "UnaryExpression" &&
    node.operator === "!" && literal(node.argument) === 0;
}

function returnsTrue(node) {
  if (node?.type === "ReturnStatement") return isTrue(node.argument);
  return node?.type === "BlockStatement" && node.body.length === 1 &&
    node.body[0].type === "ReturnStatement" && isTrue(node.body[0].argument);
}

function equalityWithIdentifier(node, identifier) {
  if (node?.type !== "BinaryExpression" || !["===", "=="].includes(node.operator)) return null;
  if (node.left?.type === "Identifier" && node.left.name === identifier) return node.right;
  if (node.right?.type === "Identifier" && node.right.name === identifier) return node.left;
  return null;
}

function isNotNullComparison(node, identifier) {
  if (node?.type !== "BinaryExpression" || !["!=", "!=="].includes(node.operator)) return false;
  return (node.left?.type === "Identifier" && node.left.name === identifier &&
    literal(node.right) === null) ||
    (node.right?.type === "Identifier" && node.right.name === identifier &&
    literal(node.left) === null);
}

function firstAndOperand(node) {
  let current = node;
  while (current?.type === "LogicalExpression" && current.operator === "&&") current = current.left;
  return current;
}

function logicalOperands(node, operator) {
  if (node?.type !== "LogicalExpression" || node.operator !== operator) return [node];
  return [...logicalOperands(node.left, operator), ...logicalOperands(node.right, operator)];
}

function comparison(node, identifier, value) {
  if (node?.type !== "BinaryExpression" || !["===", "=="].includes(node.operator)) return false;
  return (node.left?.type === "Identifier" && node.left.name === identifier &&
    literal(node.right) === value) ||
    (node.right?.type === "Identifier" && node.right.name === identifier &&
    literal(node.left) === value);
}

function isApiKeyHomeGate(node, capability, accountKey, area) {
  if (node?.type !== "LogicalExpression" || node.operator !== "||" ||
    node.left?.type !== "Identifier" || node.left.name !== capability) return false;
  const conditions = logicalOperands(node.right, "&&");
  return conditions.length === 2 &&
    conditions.some(item => comparison(item, accountKey, "auth:apikey")) &&
    conditions.some(item => comparison(item, area, "home"));
}

function currentHomeMatch(node, current, area) {
  if (node?.type !== "BinaryExpression" || !["===", "=="].includes(node.operator)) return null;
  const left = node.left;
  if (left?.type !== "CallExpression" || left.arguments.length !== 2 ||
      left.callee?.type !== "Identifier" || left.arguments[1]?.type !== "Identifier" ||
      left.arguments[1].name !== current || node.right?.type !== "Identifier" ||
      node.right.name !== area) return null;
  return left.callee.name;
}

function sidebarThreadMember(node, current) {
  const member = node?.type === "ChainExpression" ? node.expression : node;
  return member?.type === "MemberExpression" && member.optional === true &&
    member.object?.type === "MemberExpression" && member.object.optional !== true &&
    member.object.object?.type === "Identifier" && member.object.object.name === current &&
    member.object.property?.type === "Identifier" && member.object.property.name === "state" &&
    member.property?.type === "Identifier" && member.property.name === "sidebarThreadLocationId"
    ? member : null;
}

function isSidebarThreadLocationMember(node, current) {
  return sidebarThreadMember(node, current) != null;
}

function sidebarThreadLocationPresence(node, current) {
  if (node?.type !== "BinaryExpression" || !["!=", "!=="].includes(node.operator)) return null;
  return isSidebarThreadLocationMember(node.left, current) && literal(node.right) === null ? node : null;
}

function currentHomeDirect(node, current, area) {
  const classifier = currentHomeMatch(node, current, area);
  return classifier == null ? null : { classifier, home: node, state: null };
}

function findCurrentHomeCheck(fn, current, area, source) {
  const candidates = [];
  // 当前首页判断所在分支的文本范围用于核对 marker；结构判定仍只认官方条件本身。
  const branchRange = nodes(fn,
    item => item.type === "IfStatement" && item.consequent.type === "ReturnStatement" &&
      item.test?.type === "LogicalExpression" && item.test.operator === "&&",
    { ownScope: true })
    .map(item => item.test)
    .find(item => nodes(item, node => currentHomeDirect(node, current, area) != null).length >= 1) ?? null;
  const orExpressions = nodes(fn,
    item => item.type === "LogicalExpression" && item.operator === "||",
    { ownScope: true });
  for (const node of nodes(fn, item => item.type === "BinaryExpression" &&
    ["===", "=="].includes(item.operator), { ownScope: true })) {
    const direct = currentHomeDirect(node, current, area);
    if (direct == null) continue;
    const alternatives = orExpressions
      .filter(item => item.start <= node.start && item.end >= node.end)
      .map(item => ({ item, parts: logicalOperands(item, "||") }))
      .filter(({ parts }) => parts.length === 2 && parts.includes(node))
      .map(({ item, parts }) => {
        const state = parts.find(part => part !== node);
        return sidebarThreadLocationPresence(state, current) == null
          ? null : { item, state };
      })
      .filter(Boolean)
      .sort((left, right) => left.item.end - left.item.start - (right.item.end - right.item.start));
    const alternative = alternatives[0] ?? null;
    // 无状态条件时扫描整个分支，避免残留 marker 被误判为已完成。
    const patchedRange = alternative?.item ?? node;
    const markerRange = branchRange == null ? patchedRange : {
      start: Math.min(patchedRange.start, branchRange.start),
      end: Math.max(patchedRange.end, branchRange.end),
    };
    const markerPresent = source.slice(markerRange.start, markerRange.end).includes(HOME_STATE_MARKER);
    const statePatched = alternative?.state != null && markerPresent;
    candidates.push({
      ...direct,
      state: statePatched ? alternative.state : null,
      node: patchedRange,
      markerPresent,
    });
  }
  if (candidates.length !== 1) throw new Error(`首页当前位置判定 数量异常（${candidates.length}）`);
  return candidates[0];
}

function findHomeRestore(ast, source) {
  const candidates = [];
  for (const fn of ast.body.filter(node => node.type === "FunctionDeclaration")) {
    if (fn.params.length < 2 || fn.params[0]?.type !== "Identifier" ||
      fn.params[1]?.type !== "ObjectPattern") continue;
    const store = fn.params[0].name;
    const options = fn.params[1];
    const bindings = Object.fromEntries(["accountKey", "auth", "area", "navigate", "productMode", "state"]
      .map(name => [name, optionBinding(options, name)]));
    if (Object.values(bindings).some(value => value == null)) continue;

    for (const branch of nodes(fn, node => node.type === "IfStatement" && returnsTrue(node.consequent),
      { ownScope: true })) {
      const areaCalls = nodes(branch.test, node => {
        const other = equalityWithIdentifier(node, bindings.area);
        return other?.type === "CallExpression";
      }).map(node => equalityWithIdentifier(node, bindings.area));
      const currentNames = areaCalls.flatMap(call => call.arguments
        .filter(argument => argument?.type === "Identifier" && argument.name !== store)
        .map(argument => argument.name));
      const current = [...new Set(currentNames)].find(name =>
        nodes(branch.test, node => isNotNullComparison(node, name)).length === 1);
      if (current == null) continue;

      const productChecks = nodes(branch.test,
        node => equalityWithIdentifier(node, bindings.productMode)?.type === "CallExpression");
      if (productChecks.length !== 1) continue;

      const gate = firstAndOperand(branch.test);
      const capability = gate?.type === "Identifier" ? gate.name :
        gate?.type === "LogicalExpression" && gate.operator === "||" &&
        gate.left?.type === "Identifier" ? gate.left.name : null;
      if (capability == null) continue;
      const capabilityDeclarations = fn.body.body
        .filter(node => node.type === "VariableDeclaration")
        .flatMap(node => node.declarations)
        .filter(node => node.id?.type === "Identifier" && node.id.name === capability &&
          node.init?.type === "CallExpression" && memberName(node.init.callee) === "get" &&
          memberRoot(node.init.callee) === store);
      if (capabilityDeclarations.length !== 1) continue;
      let currentHome;
      try {
        currentHome = findCurrentHomeCheck(fn, current, bindings.area, source);
      } catch {
        continue;
      }

      candidates.push({
        accountKey: bindings.accountKey,
        area: bindings.area,
        capability,
        current,
        currentHome,
        gate,
        preparedRestore: findPreparedRestoreCheck(fn, store, capability),
        markerPresent: currentHome.markerPresent,
      });
    }
  }
  if (candidates.length > 1) throw new Error(`公共首页恢复当前位置分支 数量异常（${candidates.length}）`);
  return candidates[0] ?? null;
}

function findPreparedRestoreCheck(fn, store, capability) {
  const candidates = [];
  for (const conditional of nodes(fn,
    item => item.type === "ConditionalExpression", { ownScope: true })) {
    const prepared = conditional.consequent;
    const direct = conditional.alternate;
    const testPatched = isApiKeyRestoreOverride(conditional.test);
    if (!testPatched &&
      (conditional.test?.type !== "Identifier" || conditional.test.name !== capability)) continue;
    if (
      prepared?.type !== "CallExpression" ||
      prepared.arguments[0]?.type !== "Identifier" || prepared.arguments[0].name !== store ||
      prepared.arguments[1]?.type !== "Identifier" ||
      direct?.type !== "SequenceExpression") continue;
    candidates.push({ node: conditional.test });
  }
  if (candidates.length !== 1) {
    throw new Error(`首页完整恢复分支 数量异常（${candidates.length}）`);
  }
  return candidates[0];
}

function isApiKeyOverride(node, authMethod) {
  if (node?.type !== "LogicalExpression" || node.operator !== "||") return false;
  const comparisonNode = node.right;
  return comparisonNode?.type === "BinaryExpression" &&
    ["===", "=="].includes(comparisonNode.operator) &&
    comparisonNode.left?.type === "Identifier" && comparisonNode.left.name === authMethod &&
    literal(comparisonNode.right) === "apikey";
}

function isApiKeyRestoreOverride(node) {
  if (node?.type !== "LogicalExpression" || node.operator !== "||" ||
    node.left?.type !== "Identifier") return false;
  const conditions = logicalOperands(node.right, "&&");
  return conditions.length === 2 &&
    conditions.some(item => item.type === "BinaryExpression" &&
      ["===", "=="].includes(item.operator) &&
      item.left?.type === "Identifier" &&
      literal(item.right) === "auth:apikey") &&
    conditions.some(item => item.type === "BinaryExpression" &&
      ["===", "=="].includes(item.operator) &&
      literal(item.right) === "home");
}

function patchSource(source) {
  const legacyMarker = LEGACY_MARKERS.find(marker => source.includes(marker));
  if (legacyMarker != null) {
    return {
      status: "unexpected-shape",
      source,
      reason: "检测到旧入口级首页补丁；必须从未应用旧补丁的上游 Bundle 重新构建",
    };
  }
  if (!["authMethod", "accountKey", "productMode", "auth:", "chatgpt:"].every(value =>
    source.includes(value))) {
    if (source.includes(MARKER) || source.includes(HOME_CURRENT_MARKER)) {
      return { status: "unexpected-shape", source, reason: "补丁标记存在但首页导航结构未知" };
    }
    return { status: "not-applicable", source };
  }
  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const tracker = findTracker(ast);
    const homeRestore = findHomeRestore(ast, source);
    if (tracker == null || homeRestore == null) {
      if (source.includes(MARKER) || source.includes(HOME_CURRENT_MARKER)) {
        throw new Error("补丁标记存在但首页导航结构未知");
      }
      return { status: "not-applicable", source };
    }

    const trackerPatched = isApiKeyOverride(tracker.gate, tracker.authMethod);
    const gatePatched = isApiKeyHomeGate(homeRestore.gate, homeRestore.capability,
      homeRestore.accountKey, homeRestore.area);
    const currentHomePatched = homeRestore.currentHome.state != null;
    const preparedRestorePatched = isApiKeyRestoreOverride(homeRestore.preparedRestore.node);
    if (trackerPatched && !source.slice(tracker.gate.start, tracker.gate.end).includes(MARKER)) {
      throw new Error("API-key 放行逻辑存在但缺少本项目标记");
    }
    if (gatePatched && !source.slice(homeRestore.gate.start, homeRestore.gate.end)
      .includes(HOME_CURRENT_MARKER)) {
      throw new Error("API-key 首页放行逻辑存在但缺少本项目标记");
    }
    if (currentHomePatched && !homeRestore.currentHome.markerPresent) {
      throw new Error("API-key 首页当前位置逻辑存在但缺少本项目标记");
    }
    if (preparedRestorePatched && !source.slice(homeRestore.preparedRestore.node.start,
      homeRestore.preparedRestore.node.end).includes(HOME_RESTORE_MARKER)) {
      throw new Error("API-key 首页完整恢复逻辑存在但缺少本项目标记");
    }
    if (!currentHomePatched && homeRestore.currentHome.markerPresent) {
      throw new Error("API-key 首页当前状态逻辑不完整");
    }
    if (!trackerPatched && (source.includes(MARKER) ||
      tracker.gate.type !== "LogicalExpression" || tracker.gate.operator !== "&&" ||
      tracker.gate.left?.type !== "Identifier" || tracker.gate.right?.type !== "Identifier")) {
      throw new Error("导航模式与 ChatGPT capability 条件结构未知");
    }
    if (!gatePatched && (source.includes(HOME_CURRENT_MARKER) ||
      homeRestore.gate.type !== "Identifier")) {
      throw new Error("公共首页恢复当前位置逻辑不完整");
    }
    if (!currentHomePatched && source.includes(HOME_STATE_MARKER)) {
      throw new Error("API-key 首页当前状态逻辑不完整");
    }
    if (!preparedRestorePatched && source.includes(HOME_RESTORE_MARKER)) {
      throw new Error("API-key 首页完整恢复逻辑不完整");
    }
    if (trackerPatched && gatePatched && currentHomePatched && preparedRestorePatched) {
      return { status: "already-patched", source };
    }

    const originalTrackerGate = source.slice(tracker.gate.start, tracker.gate.end);
    const home = homeRestore.currentHome;
    const next = applyEdits(source, [
      {
        start: tracker.gate.start,
        end: tracker.gate.end,
        replacement: trackerPatched ? originalTrackerGate :
          `(${originalTrackerGate}||${MARKER}${tracker.authMethod}===\`apikey\`)`,
      },
      {
        start: homeRestore.gate.start,
        end: homeRestore.gate.end,
        replacement: gatePatched ? source.slice(homeRestore.gate.start, homeRestore.gate.end) :
          `(${homeRestore.capability}||${HOME_CURRENT_MARKER}` +
          `${homeRestore.accountKey}===\`auth:apikey\`&&${homeRestore.area}===\`home\`)`,
      },
      {
        start: home.node.start,
        end: home.node.end,
        replacement: currentHomePatched ? source.slice(home.node.start, home.node.end) :
          `(${source.slice(home.home.start, home.home.end)}||` +
          `${HOME_STATE_MARKER}${homeRestore.current}.state?.sidebarThreadLocationId!=null)`,
      },
      {
        start: homeRestore.preparedRestore.node.start,
        end: homeRestore.preparedRestore.node.end,
        replacement: preparedRestorePatched ? source.slice(homeRestore.preparedRestore.node.start,
          homeRestore.preparedRestore.node.end) :
          `(${homeRestore.capability}||${HOME_RESTORE_MARKER}` +
          `${homeRestore.accountKey}===\`auth:apikey\`&&${homeRestore.area}===\`home\`)`,
      },
    ]);
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
        console.log("    [ok] API-key 首页导航记录和公共当前位置保持已启用");
      } else if (check) {
        console.log("    [ok] API-key 首页导航写入与公共恢复分支已核对；dry-run 未写文件");
      } else {
        fs.writeFileSync(target.file.path, target.result.source, "utf8");
        patched++;
        console.log("    [ok] API-key 将保存并恢复首页会话，当前首页会话保持不变");
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
  HOME_CURRENT_MARKER,
  HOME_RESTORE_MARKER,
  HOME_STATE_MARKER,
  LEGACY_MARKERS,
  MARKER,
  patchSource,
};
