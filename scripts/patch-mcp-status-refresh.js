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
const { frontendFiles, isRspackFrontend, findFrontendModules, replaceFrontendModule } = require("./rspack-util");
const { literal: staticValue, walk } = require("./patch-ast-util");
const { relPath, SRC_DIR } = require("./patch-util");

const MARKER = "/* CodexRebuildMcpStatusRefresh */";
const REFRESH_DELAY_MS = 250;
const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

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

function analyzeOriginal(source, branch, ast) {
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

  let scheduled = readyRefresh.consequent;
  let pending = "";
  let callbackPrefix = "";
  let inventoryRefresh = "";
  let inventoryOwner;
  if (scheduled.type === "SequenceExpression" && scheduled.expressions.length === 2) {
    const accumulation = scheduled.expressions[0];
    if (accumulation.type !== "AssignmentExpression" || accumulation.operator !== "||=" ||
        accumulation.left.type !== "Identifier" || accumulation.right.type !== "CallExpression" ||
        source.slice(accumulation.right.arguments[0]?.start, accumulation.right.arguments[0]?.end) !== `${notification}.params.name`) {
      throw new Error("MCP inventory 累积结构异常");
    }
    pending = source.slice(accumulation.start, accumulation.end);
    scheduled = scheduled.expressions[1];
  }
  if (scheduled.type !== "AssignmentExpression" || scheduled.operator !== "??=" ||
      scheduled.left.type !== "Identifier" || scheduled.right.type !== "CallExpression" ||
      scheduled.right.callee.type !== "Identifier" || scheduled.right.callee.name !== "setTimeout" ||
      scheduled.right.arguments.length !== 2 || staticValue(scheduled.right.arguments[1]) !== 0) {
    throw new Error("MCP 轻量刷新定时器结构异常");
  }
  const timer = scheduled.left.name;
  const callback = scheduled.right.arguments[0];
  let bodyExpression = callback?.type === "ArrowFunctionExpression" &&
    callback.body.type === "BlockStatement" && callback.body.body.length === 1 &&
    callback.body.body[0].type === "ExpressionStatement"
    ? callback.body.body[0].expression
    : null;
  if (pending && callback?.body?.body.length === 3) {
    const [resetTimer, capture, work] = callback.body.body;
    const captured = capture.type === "VariableDeclaration" && capture.declarations.length === 1
      ? capture.declarations[0] : null;
    const sequence = work.type === "ExpressionStatement" ? work.expression : null;
    const clear = sequence?.type === "SequenceExpression" && sequence.expressions.length === 2
      ? sequence.expressions[0] : null;
    if (resetTimer.type !== "ExpressionStatement" || captured?.id.type !== "Identifier" ||
        captured.init?.type !== "Identifier" || !pending.startsWith(`${captured.init.name}||=`) ||
        clear?.type !== "AssignmentExpression" || clear.left.name !== captured.init.name ||
        source.slice(clear.right.start, clear.right.end) !== "!1") {
      throw new Error("MCP inventory 回调捕获结构异常");
    }
    callbackPrefix = `${source.slice(capture.start, capture.end)}${source.slice(clear.start, clear.end)},`;
    bodyExpression = { type: "SequenceExpression", expressions: [resetTimer.expression, sequence.expressions[1]] };
    const calls = sequence.expressions[1]?.right?.expressions;
    const inventory = calls?.length === 3 ? calls[1] : null;
    if (inventory?.type !== "CallExpression" || inventory.arguments.length !== 1 ||
        inventory.arguments[0].name !== captured.id.name) {
      throw new Error("MCP inventory 回调调用结构异常");
    }
    inventoryRefresh = source.slice(inventory.start, inventory.end);
  }
  if (bodyExpression?.type !== "SequenceExpression" || bodyExpression.expressions.length !== 2) {
    throw new Error("MCP 轻量刷新回调结构异常");
  }
  const reset = bodyExpression.expressions[0];
  const guarded = bodyExpression.expressions[1];
  if (reset.type !== "AssignmentExpression" || reset.left?.name !== timer ||
      guarded.type !== "LogicalExpression" || guarded.operator !== "&&" ||
      guarded.left?.type !== "LogicalExpression" || guarded.left.operator !== "&&" ||
      guarded.left.left?.type !== "Identifier" || guarded.right?.type !== "SequenceExpression" ||
      guarded.right.expressions.length !== (pending ? 3 : 2)) {
    throw new Error("MCP 轻量刷新守卫结构异常");
  }
  const active = guarded.left.left.name;
  const guard = source.slice(guarded.left.right.start, guarded.left.right.end);
  const toolsCall = guarded.right.expressions[0];
  const mentionCall = guarded.right.expressions.at(-1);
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
  if (!pending && (!installedText.includes("installed-inventory") || !installedText.includes("installed"))) {
    throw new Error("MCP installed inventory 刷新结构异常");
  }
  if (pending) {
    const original = readyRefresh.alternate;
    const installedCall = original.type === "LogicalExpression" ? original.right : null;
    const pendingCall = readyRefresh.consequent.expressions[0].right;
    if (installedCall?.type !== "CallExpression" || installedCall.callee.name !==
        guarded.right.expressions[1].callee.name || installedCall.arguments.length !== 1 ||
        source.slice(installedCall.arguments[0].start, installedCall.arguments[0].end) !==
        source.slice(pendingCall.start, pendingCall.end)) {
      throw new Error("MCP installed inventory helper 调用结构异常");
    }
    const enclosing = [];
    walk(ast, node => {
      if (node.type === "FunctionDeclaration" && node.start < branch.start && node.end > branch.end) enclosing.push(node);
    });
    const owner = enclosing.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    inventoryOwner = owner;
    const helpers = [];
    if (owner) walk(owner, node => {
      if (node.type === "VariableDeclarator" && node.id.name === installedCall.callee.name &&
          node.init?.type === "ArrowFunctionExpression") helpers.push(node);
    }, { ownScope: true });
    const helperText = helpers.length === 1 ? source.slice(helpers[0].start, helpers[0].end) : "";
    if (!["installed-inventory", "installed", `${queryClient}`].every(term => helperText.includes(term)) ||
        !helperText.includes(`[2]===${host}`)) {
      throw new Error("MCP installed inventory helper 定义结构异常");
    }
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
    pending,
    callbackPrefix,
    inventoryRefresh,
    inventoryOwner,
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
    const shape = analyzeOriginal(source, branch, ast);
    if (shape.pending && source.includes("__codexMcpThreadReadyPending")) {
      throw new Error("MCP thread-ready pending binding 已存在但缺少补丁标记");
    }
    const fullStale = `${shape.queryClient}.invalidateQueries({queryKey:[...${shape.queryBase},${shape.host}],predicate:({queryKey:e})=>e.length===${shape.queryBase}.length+2&&e[${shape.queryBase}.length+1]===\`full\`,refetchType:\`none\`})${MARKER}`;
    const inventoryCapture = shape.pending ? "let __codexMcpRefreshInventory=__codexMcpThreadReadyPending;__codexMcpThreadReadyPending=!1;" : "";
    const schedule = `${shape.pending ? `${shape.readyText}&&(__codexMcpThreadReadyPending=!0,${shape.pending}),` : ""}${shape.timer}??=setTimeout(()=>{${shape.timer}=void 0;${inventoryCapture}${shape.callbackPrefix}${shape.active}&&(${shape.guard})&&(${shape.toolsText},${shape.inventoryRefresh ? `__codexMcpRefreshInventory&&${shape.inventoryRefresh},` : ""}${shape.mentionText},${fullStale})},${REFRESH_DELAY_MS})`;
    const globalOnly = `${shape.notification}.params.threadId==null&&(${shape.installedText})`;
    const replacement = `(${shape.readyText}||${shape.globalText})&&(${schedule}),${globalOnly},${shape.threadRefresh}`;
    let next = source.slice(0, shape.expression.start) + replacement + source.slice(shape.expression.end);
    if (shape.inventoryOwner) {
      const start = shape.inventoryOwner.body.start + 1;
      next = next.slice(0, start) + "let __codexMcpThreadReadyPending=!1;" + next.slice(start);
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

function patchRspackSource(source) {
  if (source.includes(MARKER)) { validatePatchedSource(source); return { status: "already-patched", source }; }
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const branch = targetCase(ast);
  const sequence = branch.consequent[0].expression;
  if (sequence.type !== "SequenceExpression" || sequence.expressions.length !== 2) throw new Error("Rspack MCP 通知表达式漂移");
  const [ready, scoped] = sequence.expressions;
  const text = node => source.slice(node.start, node.end);
  const notification = text(ready.test).match(/([\w$]+)\.params\.status/)?.[1];
  const scheduled = ready.consequent?.expressions?.[1];
  const timerGuard = scheduled?.type === "LogicalExpression" && scheduled.operator === "&&" ? scheduled.left : null;
  const assignment = scheduled?.right;
  const timeout = assignment?.right;
  if (!notification || timerGuard?.type !== "BinaryExpression" || timeout?.callee?.name !== "setTimeout"
    || staticValue(timeout.arguments[1]) !== 0 || assignment.left.type !== "Identifier") throw new Error("Rspack MCP 刷新计时器漂移");
  const callback = timeout.arguments[0];
  const work = callback.body.body.at(-1)?.expression;
  const guarded = work?.expressions?.at(-1);
  const calls = guarded?.right?.expressions;
  if (calls?.length !== 2 || !text(calls[1]).includes("mention-discovery")) throw new Error("Rspack MCP 刷新回调漂移");
  const inventory = calls[0], mention = calls[1];
  const queryKey = objectProperty(mention.arguments[1], "queryKey")?.value;
  if (inventory.type !== "CallExpression" || inventory.callee.type !== "Identifier" || queryKey?.elements.length !== 3
    || queryKey.elements[0]?.type !== "SpreadElement" || queryKey.elements[1]?.type !== "Identifier") throw new Error("Rspack MCP 目录调用漂移");
  const helpers = [];
  walk(ast, node => { if (node.type === "VariableDeclarator" && node.id.name === inventory.callee.name) helpers.push(node); });
  if (helpers.length !== 1 || !["installed-inventory", "installed"].every(term => text(helpers[0]).includes(term))) throw new Error("Rspack MCP inventory helper 缺失");
  const queryClient = text(mention.arguments[0]), base = text(queryKey.elements[0].argument), host = text(queryKey.elements[1]);
  const refresh = `(${text(mention.callee)})`;
  const light = `${refresh}(${queryClient},{queryKey:[...${base},${host},\`toolsAndAuthOnly\`],exact:!0},{cancelRefetch:!1})`;
  const full = `${queryClient}.invalidateQueries({queryKey:[...${base},${host}],predicate:({queryKey:e})=>e.length===${base}.length+2&&e[${base}.length+1]===\`full\`,refetchType:\`none\`})${MARKER}`;
  const owner = [];
  walk(ast, node => { if (node.type === "FunctionDeclaration" && node.start < branch.start && node.end > branch.end) owner.push(node); });
  const fn = owner.sort((a,b) => a.end-a.start-(b.end-b.start))[0];
  if (!fn || scoped.type !== "ConditionalExpression" || !text(scoped.consequent).includes(`queryKey:[...${base},${host}]`)) throw new Error("Rspack MCP 全局刷新漂移");
  const readyCapture = ready.consequent.expressions[0];
  const replacement = `(${text(ready.test)}||${text(scoped.test)})&&(${text(ready.test)}&&(__codexMcpThreadReadyPending=!0,${text(readyCapture)}),${text(assignment.left)}??=setTimeout(()=>{${text(assignment.left)}=void 0;let __codexReady=__codexMcpThreadReadyPending;__codexMcpThreadReadyPending=!1;${text(callback.body.body[1])}${text(work.expressions[0])};${text(guarded.left)}&&(${light},__codexReady&&${text(inventory)},${text(mention)},${full})},${REFRESH_DELAY_MS})),${notification}.params.threadId==null&&(${text(ready.alternate)}),${text(scoped.alternate)}`;
  let next = source.slice(0, sequence.start) + replacement + source.slice(sequence.end);
  next = next.slice(0, fn.body.start+1) + "let __codexMcpThreadReadyPending=!1;" + next.slice(fn.body.start+1);
  validatePatchedSource(next);
  return { status: "patched", source: next };
}

function patchRspack(directory, check) {
  const targets = findFrontendModules(directory, { all: ["mcpServer/startupStatus/updated", "mention-discovery", "toolsAndAuthOnly"],
    test: source => { try { targetCase(parse(source, { ecmaVersion: "latest", sourceType: "module" })); return true; } catch { return false; } } });
  if (!targets.length || new Set(targets.map(target => target.id)).size !== 1) throw new Error("Rspack MCP 状态模块不唯一");
  const plans = targets.map(target => ({ target, result: patchRspackSource(target.source) }));
  for (const { target, result } of plans) if (!check && result.status === "patched") fs.writeFileSync(target.file, replaceFrontendModule(target, result.source), "utf8");
  console.log(`  [ok] Rspack MCP 250ms 轻量刷新与 Full stale 已核对${check ? "；dry-run" : ""}`);
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
      if (isRspackFrontend(directory.path)) { patchRspack(directory.path, check); continue; }
      const results = frontendFiles(directory.path)
        .map(file => ({ name: path.basename(file), path: file }))
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
module.exports = { MARKER, REFRESH_DELAY_MS, patchSource, patchRspackSource };
