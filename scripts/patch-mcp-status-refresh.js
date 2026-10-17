#!/usr/bin/env node
/**
 * 合并 MCP 启动状态通知带来的目录刷新，并避免后台通知立即重拉 Full 目录。
 *
 * 上游已经提供 toolsAndAuthOnly 查询和请求级 coalescing；本补丁不改变 Full
 * 查询的内容，只把短时间内的启动通知合并为一次轻量刷新，并把 Full 查询
 * 标记为 stale、但不在后台立即 refetch。目标结构漂移时必须失败。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");

const MARKER = "/* CodexRebuildMcpStatusRefresh */";
const REFRESH_DELAY_MS = 250;
const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["type", "start", "end"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function staticValue(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

function propertyName(member) {
  if (member?.type !== "MemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  return staticValue(member.property);
}

function objectProperty(object, name) {
  return object?.type === "ObjectExpression"
    ? object.properties.find((item) => item.type === "Property" && propertyName({
      type: "MemberExpression",
      computed: item.computed,
      property: item.key,
    }) === name)
    : undefined;
}

function targetCase(ast) {
  const matches = [];
  walk(ast, (node) => {
    if (node.type === "SwitchCase" && staticValue(node.test) === "mcpServer/startupStatus/updated" &&
        node.consequent[0]?.type === "ExpressionStatement") {
      matches.push(node);
    }
  });
  if (matches.length !== 1) {
    throw new Error(`MCP 启动状态刷新分支数量异常（${matches.length}）`);
  }
  const branch = matches[0];
  if (branch.consequent.length !== 2 || branch.consequent[1].type !== "BreakStatement") {
    throw new Error("MCP 启动状态刷新分支结构异常");
  }
  return branch;
}

function analyzeOriginal(source, branch) {
  const expression = branch.consequent[0].expression;
  if (expression.type !== "SequenceExpression" || expression.expressions.length !== 2) {
    throw new Error("MCP 启动状态刷新表达式结构异常");
  }
  const [readyRefresh, scopedRefresh] = expression.expressions;
  if (readyRefresh.type !== "ConditionalExpression" || scopedRefresh.type !== "ConditionalExpression") {
    throw new Error("MCP 启动状态刷新条件结构异常");
  }

  const readyText = source.slice(readyRefresh.test.start, readyRefresh.test.end);
  const readyMatch = readyText.match(/^([A-Za-z_$][\w$]*)\.params\.status===`ready`&&\1\.params\.threadId!=null$/);
  if (!readyMatch) throw new Error("MCP thread ready 条件结构异常");
  const notification = readyMatch[1];
  const globalText = source.slice(scopedRefresh.test.start, scopedRefresh.test.end);
  if (globalText !== `${notification}.params.threadId==null&&${notification}.params.status!==\`starting\``) {
    throw new Error("MCP global 状态条件结构异常");
  }

  const scheduled = readyRefresh.consequent;
  if (scheduled.type !== "AssignmentExpression" || scheduled.operator !== "??=" ||
      scheduled.left.type !== "Identifier" || scheduled.right.type !== "CallExpression" ||
      scheduled.right.callee.type !== "Identifier" || scheduled.right.callee.name !== "setTimeout" ||
      scheduled.right.arguments.length !== 2 || staticValue(scheduled.right.arguments[1]) !== 0) {
    throw new Error("MCP 轻量刷新定时器结构异常");
  }
  const timer = scheduled.left.name;
  const callback = scheduled.right.arguments[0];
  const bodyExpression = callback?.type === "ArrowFunctionExpression" &&
    callback.body.type === "BlockStatement" && callback.body.body.length === 1 &&
    callback.body.body[0].type === "ExpressionStatement"
    ? callback.body.body[0].expression
    : null;
  if (bodyExpression?.type !== "SequenceExpression" || bodyExpression.expressions.length !== 2) {
    throw new Error("MCP 轻量刷新回调结构异常");
  }
  const reset = bodyExpression.expressions[0];
  const guarded = bodyExpression.expressions[1];
  if (reset.type !== "AssignmentExpression" || reset.left?.name !== timer ||
      guarded.type !== "LogicalExpression" || guarded.operator !== "&&" ||
      guarded.left?.type !== "LogicalExpression" || guarded.left.operator !== "&&" ||
      guarded.left.left?.type !== "Identifier" || guarded.right?.type !== "SequenceExpression" ||
      guarded.right.expressions.length !== 2) {
    throw new Error("MCP 轻量刷新守卫结构异常");
  }
  const active = guarded.left.left.name;
  const guard = source.slice(guarded.left.right.start, guarded.left.right.end);
  const [toolsCall, mentionCall] = guarded.right.expressions;
  const toolsText = source.slice(toolsCall.start, toolsCall.end);
  const mentionText = source.slice(mentionCall.start, mentionCall.end);
  if (!toolsText.includes("toolsAndAuthOnly") || !mentionText.includes("mention-discovery")) {
    throw new Error("MCP 轻量目录刷新调用结构异常");
  }

  const queryClient = source.slice(toolsCall.arguments[0].start, toolsCall.arguments[0].end);
  if (!queryClient.endsWith(".queryClient")) throw new Error("MCP queryClient 结构异常");
  const queryKey = objectProperty(toolsCall.arguments[1], "queryKey")?.value;
  if (queryKey?.type !== "ArrayExpression" || queryKey.elements.length !== 3 ||
      queryKey.elements[0]?.type !== "SpreadElement" ||
      queryKey.elements[0].argument.type !== "Identifier" ||
      queryKey.elements[1]?.type !== "Identifier" || staticValue(queryKey.elements[2]) !== "toolsAndAuthOnly") {
    throw new Error("MCP toolsAndAuthOnly query key 结构异常");
  }
  const queryBase = queryKey.elements[0].argument.name;
  const host = queryKey.elements[1].name;

  const installedText = source.slice(readyRefresh.alternate.start, readyRefresh.alternate.end);
  if (!installedText.includes("installed-inventory") || !installedText.includes("installed")) {
    throw new Error("MCP installed inventory 刷新结构异常");
  }
  const blanket = source.slice(scopedRefresh.consequent.start, scopedRefresh.consequent.end);
  if (!blanket.includes(`queryKey:[...${queryBase},${host}]`) || blanket.includes("refetchType")) {
    throw new Error("MCP Full blanket 刷新结构异常");
  }
  const threadRefresh = source.slice(scopedRefresh.alternate.start, scopedRefresh.alternate.end);
  if (!threadRefresh.includes(`${notification}.params.threadId`) || !threadRefresh.includes("`thread`")) {
    throw new Error("MCP thread 范围刷新结构异常");
  }

  return {
    expression,
    notification,
    timer,
    active,
    guard,
    toolsText,
    mentionText,
    queryClient,
    queryBase,
    host,
    readyText,
    globalText,
    installedText,
    threadRefresh,
  };
}

function count(source, value) {
  return source.split(value).length - 1;
}

function validatePatchedSource(source) {
  if (count(source, MARKER) !== 1) throw new Error(`${MARKER} 数量异常`);
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const branch = targetCase(ast);
  const branchText = source.slice(branch.start, branch.end);
  if (!branchText.includes(MARKER) || !branchText.includes(`},${REFRESH_DELAY_MS})`)) {
    throw new Error("MCP 刷新合并标记或时间窗口缺失");
  }
  if (!branchText.includes("toolsAndAuthOnly") || !branchText.includes("mention-discovery") ||
      !branchText.includes("refetchType:`none`") || !branchText.includes("===`full`")) {
    throw new Error("MCP 轻量刷新或 Full stale 规则缺失");
  }
  const calls = [];
  walk(branch, (node) => {
    if (node.type === "CallExpression" && propertyName(node.callee) === "invalidateQueries") calls.push(node);
  });
  const staleOnly = calls.filter((call) => {
    const options = call.arguments[0];
    return staticValue(objectProperty(options, "refetchType")?.value) === "none";
  });
  if (staleOnly.length !== 1) throw new Error("MCP Full stale-only 调用数量异常");
}

function patchSource(source) {
  if (source.includes(MARKER)) {
    try {
      validatePatchedSource(source);
      return { status: "already-patched", source };
    } catch (error) {
      return { status: "unexpected-shape", source, reason: error.message };
    }
  }
  if (!source.includes("mcpServer/startupStatus/updated") ||
      !source.includes("toolsAndAuthOnly") || !source.includes("mention-discovery")) {
    return { status: "not-applicable", source };
  }
  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const branch = targetCase(ast);
    const shape = analyzeOriginal(source, branch);
    const fullStale = `${shape.queryClient}.invalidateQueries({queryKey:[...${shape.queryBase},${shape.host}],predicate:({queryKey:e})=>e.length===${shape.queryBase}.length+2&&e[${shape.queryBase}.length+1]===\`full\`,refetchType:\`none\`})${MARKER}`;
    const schedule = `${shape.timer}??=setTimeout(()=>{${shape.timer}=void 0,${shape.active}&&(${shape.guard})&&(${shape.toolsText},${shape.mentionText},${fullStale})},${REFRESH_DELAY_MS})`;
    const globalOnly = `${shape.notification}.params.threadId==null&&(${shape.installedText})`;
    const replacement = `(${shape.readyText}||${shape.globalText})&&(${schedule}),${globalOnly},${shape.threadRefresh}`;
    const next = source.slice(0, shape.expression.start) + replacement + source.slice(shape.expression.end);
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
        .filter((name) => /^app-initial-.*\.js$/.test(name))
        .map((name) => ({ name, path: path.join(directory.path, name) }))
        .map((file) => ({ ...file, source: fs.readFileSync(file.path, "utf8") }))
        .map((file) => ({ file, result: patchSource(file.source) }))
        .filter((item) => item.result.status !== "not-applicable");
      if (results.length !== 1) throw new Error(`MCP 状态 Bundle 数量异常（${results.length}）`);
      const target = results[0];
      if (target.result.status === "unexpected-shape") throw new Error(target.result.reason);
      console.log(`  [${directory.platform}] ${relPath(target.file.path)}`);
      if (target.result.status === "already-patched") {
        console.log("    [ok] MCP 启动状态刷新已治理");
      } else if (check) {
        console.log("    [ok] MCP 启动状态刷新结构已核对；dry-run 未写文件");
      } else {
        fs.writeFileSync(target.file.path, target.result.source, "utf8");
        patched++;
        console.log("    [ok] 已合并轻量刷新并阻止后台 Full 目录立即重拉");
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
module.exports = { MARKER, REFRESH_DELAY_MS, patchSource };
