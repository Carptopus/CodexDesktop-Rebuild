#!/usr/bin/env node
/** 修复未打开会话时“复制为 Markdown”取不到完整历史的问题。 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");
const {
  findFrontendModules,
  isRspackFrontend,
  replaceFrontendModule,
  rspackModules,
  moduleExports,
} = require("./rspack-util");

const MARKER = "/* CodexRebuild: copy complete conversation Markdown */";
const ERROR_ID = "threadActions.copyConversationMarkdown.copyConversationMarkdownError";
const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function collect(node, predicate) {
  const matches = [];
  walk(node, (candidate) => {
    if (predicate(candidate)) matches.push(candidate);
  });
  return matches;
}

function name(node) { return node?.name ?? node?.value ?? null; }

function operands(node) {
  return node?.type === "LogicalExpression" && node.operator === "&&"
    ? [...operands(node.left), ...operands(node.right)]
    : [node];
}

function findHelpers(ast, source) {
  const found = { complete: [], render: [], visible: [], excluded: [] };
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" || !node.id) return;
    const body = source.slice(node.start, node.end);
    const keys = node.params[0]?.type === "ObjectPattern"
      ? node.params[0].properties.map((property) => name(property.key)) : [];
    if (["visibleTurnEntries", "title", "cwd"].every((key) => keys.includes(key)) &&
        body.includes("renderConversationMarkdown")) found.render.push(node.id.name);
    if (["conversationRequests", "conversationTurns", "hasConversation", "parentConversationTurns", "subagentParentThreadId"]
      .every((key) => keys.includes(key))) found.visible.push(node.id.name);
    if (body.includes("Conversation must be resumed before loading history")) {
      walk(node.body, (child) => {
        if (child.type !== "VariableDeclarator") return;
        const call = child.init;
        if (call?.type === "CallExpression" && call.callee.type === "Identifier" &&
            call.arguments.length === 1 && name(call.arguments[0]?.callee?.property) === "getConversation") {
          found.complete.push(call.callee.name);
        }
      });
    }
    const options = node.params[1];
    const optionKeys = options?.type === "ObjectPattern"
      ? options.properties.map((property) => name(property.key)) : [];
    if (["conversationId", "isBackgroundSubagentsEnabled", "markdownLimit"].every((key) => optionKeys.includes(key)) &&
        body.includes("visibleTurnEntries")) {
      const first = node.body.body[0];
      if (first?.type === "IfStatement" && first.test.type === "CallExpression" &&
          first.test.callee.type === "Identifier" && first.consequent.type === "ReturnStatement" &&
          first.consequent.argument?.type === "Literal" && first.consequent.argument.value === null) {
        found.excluded.push(first.test.callee.name);
      }
    }
  });
  if (Object.values(found).some((matches) => matches.length !== 1)) return null;
  return Object.fromEntries(Object.entries(found).map(([key, matches]) => [key, matches[0]]));
}

function validatePatched(source) {
  if (source.split(MARKER).length !== 2) throw new Error("补丁标记数量异常");
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
  });
  const marked = collect(ast, (node) =>
    ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type) &&
    node.body?.type === "BlockStatement" &&
    source.slice(node.body.start + 1).startsWith(MARKER));
  if (marked.length !== 1) throw new Error("补丁标记未唯一位于复制动作中");
  const body = source.slice(marked[0].start, marked[0].end);
  if (!body.includes("force:!0") ||
      !body.includes("getConversation(") ||
      !body.includes("会话历史不完整") ||
      !body.includes("无法写入剪贴板")) {
    throw new Error("补丁完整历史或失败保护结构异常");
  }
}

function validateRspackPatched(source) {
  if (source.split(MARKER).length !== 2) throw new Error("补丁标记数量异常");
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
  });
  const marked = collect(ast, (node) =>
    ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type) &&
    node.body?.type === "BlockStatement" &&
    source.slice(node.body.start + 1).startsWith(MARKER));
  if (marked.length !== 1) throw new Error("补丁标记未唯一位于复制动作中");
  const [action] = marked;
  const body = source.slice(action.start, action.end);
  const ensureCalls = collect(action, (node) =>
    node.type === "CallExpression" &&
    name(node.callee?.property) === "ensureConversationHistoryLoaded");
  const rendered = collect(action, (node) =>
    node.type === "VariableDeclarator" && node.init?.type === "AwaitExpression" &&
    node.init.argument?.type === "CallExpression" &&
    node.init.argument.callee?.type === "MemberExpression" &&
    node.init.argument.callee.object?.type === "Identifier" &&
    node.init.argument.callee.object.name === "__crMarkdown");
  if (ensureCalls.length !== 1 || ensureCalls[0].start > rendered[0]?.init?.start ||
      rendered.length !== 1 ||
      !source.slice(ensureCalls[0].arguments[2]?.start, ensureCalls[0].arguments[2]?.end)
        .includes("force:!0") ||
      !body.includes("无法写入剪贴板") ||
      !body.includes("会话没有可复制的内容")) {
    throw new Error("Rspack 完整历史复制或失败保护结构异常");
  }
}

function patchSource(source) {
  if (source.includes(MARKER)) {
    try { validatePatched(source); return { status: "already-patched", source }; }
    catch (error) { return { status: "unexpected-shape", source, reason: error.message }; }
  }
  if (!source.includes(ERROR_ID)) return { status: "signature-missing", source };
  let ast;
  try { ast = parse(source, { ecmaVersion: "latest", sourceType: "module" }); }
  catch (error) { return { status: "parse-error", source, reason: error.message }; }

  const candidates = [];
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" || node.params.length !== 1 || node.params[0].type !== "ObjectPattern") return;
    const bindings = new Map(node.params[0].properties.map((property) => [name(property.key), name(property.value)]));
    if (["scope", "conversationId", "parentConversationId", "getMarkdown", "intl"]
      .every((key) => bindings.has(key)) && source.slice(node.start, node.end).includes(ERROR_ID)) {
      candidates.push({ node, bindings });
    }
  });
  if (candidates.length !== 1) return { status: "ambiguous-copy-action", source, count: candidates.length };

  const { node, bindings } = candidates[0];
  const statements = node.body.body;
  const chain = statements[0]?.expression;
  const iife = chain?.callee?.object?.callee;
  const body = iife?.body?.body;
  const ensure = body?.[0]?.expression?.argument;
  const markdown = body?.[1]?.declarations?.[0];
  const parts = operands(body?.[2]?.expression);
  const copy = parts[2];
  const success = parts[3];
  const text = (item) => item ? source.slice(item.start, item.end) : "";
  if (statements.length !== 1 || statements[0].type !== "ExpressionStatement" ||
      name(chain?.callee?.property) !== "catch" || chain.arguments.length !== 1 ||
      iife?.type !== "ArrowFunctionExpression" || !iife.async || body?.length !== 3 ||
      body[0].expression?.type !== "AwaitExpression" || ensure?.type !== "CallExpression" ||
      name(ensure.callee?.property) !== "ensureConversationHistoryLoaded" || ensure.arguments.length !== 2 ||
      name(ensure.arguments[0]) !== bindings.get("conversationId") || body[1].declarations?.length !== 1 ||
      markdown?.id?.type !== "Identifier" || markdown.init?.type !== "AwaitExpression" ||
      name(markdown.init.argument?.callee) !== bindings.get("getMarkdown") ||
      body[2].type !== "ExpressionStatement" || parts.length !== 4 ||
      copy?.type !== "AwaitExpression" || copy.argument?.type !== "CallExpression" ||
      copy.argument.arguments.length !== 1 || name(copy.argument.arguments[0]) !== markdown.id.name ||
      success?.type !== "CallExpression" || name(success.callee?.property) !== "success" ||
      !text(success).includes("copyConversationMarkdownSuccess")) {
    return { status: "unsupported-copy-structure", source };
  }
  const helpers = findHelpers(ast, source);
  if (!helpers) return { status: "unsupported-history-renderer", source };
  const nonempty = `${text(parts[0])}&&${text(parts[1])}`;
  const id = bindings.get("conversationId");
  const parent = bindings.get("parentConversationId");
  const value = markdown.id.name;
  const fallback = `if(!(${nonempty})){` +
    `const __crClient=${text(ensure.callee.object)};` +
    `const __crConversation=await __crClient.getConversation(${id});` +
    `const __crParent=${parent}==null?null:await __crClient.getConversation(${parent});` +
    `if(__crConversation==null||(${parent}!=null&&__crParent==null)||${helpers.excluded}(__crConversation.threadSource))throw new Error("会话不可导出");` +
    `const __crTurns=${helpers.complete}(__crConversation);` +
    `const __crParentTurns=${parent}==null?[]:${helpers.complete}(__crParent);` +
    `if(__crTurns==null||__crParentTurns==null)throw new Error("会话历史不完整");` +
    `const {visibleTurnEntries:__crEntries}=${helpers.visible}({conversationRequests:__crConversation.requests,conversationTurns:__crTurns,hasConversation:!0,isBackgroundSubagentsEnabled:!0,parentConversationTurns:__crParentTurns,subagentParentThreadId:${parent}});` +
    `${value}=await ${helpers.render}({cwd:__crConversation.cwd,title:__crConversation.title,projectlessOutputDirectory:__crConversation.projectlessOutputDirectory,isBackgroundSubagentsEnabled:!0,visibleTurnEntries:__crEntries});}`;
  const guards = `if(!(${nonempty}))throw new Error("会话没有可复制的内容");` +
    `if(!(${text(copy)}))throw new Error("无法写入剪贴板");${text(success)};`;
  const edits = [
    { start: ensure.end - 1, replacement: ",{force:!0}" },
    { start: body[2].start, end: body[2].end, replacement: fallback + guards },
    { start: node.body.start + 1, replacement: `${MARKER}return ` },
  ].sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end ?? edit.start);
  try { validatePatched(result); }
  catch (error) { return { status: "invalid-patch-result", source, reason: error.message }; }
  return { status: "patched", source: result };
}

function patchRspackModuleSource(module) {
  const source = module.source;
  if (source.includes(MARKER)) {
    try {
      validateRspackPatched(source);
      return { status: "already-patched", source };
    } catch (error) {
      return { status: "unexpected-shape", source, reason: error.message };
    }
  }
  if (!source.includes(ERROR_ID)) return { status: "signature-missing", source };

  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    return { status: "parse-error", source, reason: error.message };
  }

  const candidates = collect(ast, (node) =>
    ["FunctionExpression", "ArrowFunctionExpression"].includes(node.type) &&
    node.params[0]?.type === "ObjectPattern" &&
    source.slice(node.start, node.end).includes(ERROR_ID));
  if (candidates.length !== 1) {
    return { status: "ambiguous-copy-action", source, count: candidates.length };
  }

  const action = candidates[0];
  const bindings = new Map(action.params[0].properties
    .filter((property) => property.type === "Property")
    .map((property) => [name(property.key), name(property.value)]));
  const requiredBindings = ["scope", "conversationId", "parentConversationId", "getMarkdown", "intl"];
  if (!requiredBindings.every((key) => bindings.has(key))) {
    return { status: "unsupported-copy-structure", source };
  }

  const ensureCalls = collect(action, (node) => node.type === "CallExpression" &&
    name(node.callee?.property) === "ensureConversationHistoryLoaded");
  const markdownDeclarations = collect(action, (node) => node.type === "VariableDeclarator" &&
    node.id?.type === "Identifier" && node.init?.type === "AwaitExpression" &&
    name(node.init.argument?.callee) === bindings.get("getMarkdown"));
  const statements = collect(action, (node) => node.type === "ExpressionStatement" &&
    node.expression?.type === "LogicalExpression" &&
    source.slice(node.start, node.end).includes("copyConversationMarkdownSuccess"));
  if (ensureCalls.length !== 1 || markdownDeclarations.length !== 1 || statements.length !== 1 ||
      ensureCalls[0].arguments.length !== 2 ||
      name(ensureCalls[0].arguments[0]) !== bindings.get("conversationId")) {
    return { status: "unsupported-copy-structure", source };
  }

  const statement = statements[0];
  const copies = collect(statement, (node) => node.type === "AwaitExpression" &&
    node.argument?.type === "CallExpression" && node.argument.arguments.length === 1 &&
    name(node.argument.arguments[0]) === markdownDeclarations[0].id.name);
  const successes = collect(statement, (node) => node.type === "CallExpression" &&
    name(node.callee?.property) === "success" &&
    source.slice(node.start, node.end).includes("copyConversationMarkdownSuccess"));
  if (copies.length !== 1 || successes.length !== 1) {
    return { status: "unsupported-copy-structure", source };
  }
  const copy = copies[0];
  const success = successes[0];

  const renderExports = rspackModules(module.chunkSource).flatMap((dependency) => {
    if (!dependency.source.includes("renderConversationMarkdown")) return [];
    return moduleExports(dependency)
      .filter(({ value }) => value.includes("conversationId") &&
        value.includes("visibleTurnEntries") && value.includes(".get("))
      .map((entry) => ({ ...entry, dependency }));
  });
  if (renderExports.length !== 1) {
    return { status: "unsupported-history-renderer", source };
  }
  const [{ dependency: renderModule, exported: renderExport }] = renderExports;

  const ensure = ensureCalls[0];
  const markdown = markdownDeclarations[0];
  const value = markdown.id.name;
  const scope = bindings.get("scope");
  const conversationId = bindings.get("conversationId");
  const renderedMarkdown =
    `await __crMarkdown.${renderExport}(${scope},` +
    `{conversationId:${conversationId},isBackgroundSubagentsEnabled:!0})`;
  const guards =
    `if(${value}==null||0===${value}.trim().length)throw new Error("会话没有可复制的内容");` +
    `if(!(${source.slice(copy.start, copy.end)}))throw new Error("无法写入剪贴板");` +
    `${source.slice(success.start, success.end)};`;
  const edits = [
    { start: markdown.init.start, end: markdown.init.end, replacement: renderedMarkdown },
    { start: ensure.end - 1, replacement: ",{force:!0}" },
    { start: statement.start, end: statement.end, replacement: guards },
    {
      start: action.body.start + 1,
      replacement: `${MARKER}var __crMarkdown=${module.requireName}(${JSON.stringify(renderModule.id)});`,
    },
  ].sort((left, right) => right.start - left.start);
  let result = source;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end ?? edit.start);
  }
  try {
    validateRspackPatched(result);
  } catch (error) {
    return { status: "invalid-patch-result", source, reason: error.message };
  }
  return { status: "patched", source: result };
}

function findTargets(platform) {
  const requested = platform ? [platform] : PLATFORMS;
  const targets = [];
  const errors = [];
  for (const current of requested) {
    const assets = path.join(SRC_DIR, current, "_asar", "webview", "assets");
    if (!fs.existsSync(assets)) continue;
    if (isRspackFrontend(assets)) {
      const candidates = findFrontendModules(assets, {
        any: [ERROR_ID, MARKER],
        test: (source) => source.includes(ERROR_ID) || source.includes(MARKER),
      });
      if (candidates.length !== 1) {
        errors.push(`${current}: Rspack 复制动作模块数量异常（${candidates.length}）`);
        continue;
      }
      targets.push({ platform: current, rspack: true, ...candidates[0] });
      continue;
    }
    const files = fs.readdirSync(assets).filter((file) => /^app-(?:initial|primary)-.*\.js$/.test(file));
    const candidates = files.map((name) => {
      const file = path.join(assets, name);
      return { path: file, source: fs.readFileSync(file, "utf8") };
    }).filter(({ source }) => source.includes(ERROR_ID) || source.includes(MARKER));
    if (candidates.length !== 1) {
      errors.push(`${current}: 复制动作源码签名 ${ERROR_ID} 数量异常（${candidates.length}）`);
      continue;
    }
    targets.push({ platform: current, ...candidates[0] });
  }
  return { targets, errors };
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--check" && !PLATFORMS.includes(arg));
  if (unknown.length) throw new Error(`未知参数：${unknown.join(", ")}`);
  const platforms = args.filter((arg) => PLATFORMS.includes(arg));
  if (platforms.length > 1) throw new Error("只能指定一个平台");
  const check = args.includes("--check");
  const { targets, errors } = findTargets(platforms[0]);
  for (const error of errors) { console.error(`  [x] ${error}`); process.exitCode = 1; }
  if (!targets.length && !errors.length) { console.error("  [x] 缺少目标平台界面资源"); process.exitCode = 1; }
  for (const target of targets) {
    const label = relPath(target.rspack ? target.file : target.path);
    const result = target.rspack ? patchRspackModuleSource(target) : patchSource(target.source);
    if (result.status === "already-patched") console.log(`  [ok] ${label}: already patched`);
    else if (result.status === "patched") {
      if (!check) {
        fs.writeFileSync(target.rspack ? target.file : target.path,
          target.rspack ? replaceFrontendModule(target, result.source) : result.source,
          "utf8");
      }
      console.log(`  [ok] ${label}: ${check ? "check only; no write" : "patched"}`);
    } else {
      console.error(`  [x] ${target.platform}: ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`  [x] ${error.message}`); process.exitCode = 1; }
}

module.exports = {
  ERROR_ID,
  MARKER,
  patchSource,
  patchRspackModuleSource,
  findTargets,
  validatePatched,
  validateRspackPatched,
};
