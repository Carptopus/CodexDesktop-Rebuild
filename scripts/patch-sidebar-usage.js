#!/usr/bin/env node
/** 复用官方额度查询，用剩余额度圆环替换侧栏头像。 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { applyEdits, key, literal, nodes, unique } = require("./patch-ast-util");
const { SRC_DIR, relPath } = require("./patch-util");
const MODULE = "codex-rebuild-sidebar-usage.js";
const MARKER = "/* CodexRebuildSidebarUsage */";
const COMPONENT = "__CodexSidebarUsage";
const ACCOUNT_COMPONENT = "__CodexAccountSidebarUsage";
const RENDER = "__codexRenderSidebarUsage";
const contains = (source, node, value) => source.slice(node.start, node.end).includes(value);
const props = node => Object.fromEntries((node?.properties ?? [])
  .filter(property => property.type === "Property" && !property.computed)
  .map(property => [key(property.key), property.value]));

function analyze(source, ast) {
  const footer = unique(ast.body.filter(node => node.type === "FunctionDeclaration" &&
    contains(source, node, "codex.profileFooter.settingsFallback") &&
    contains(source, node, "codex.profileFooter.loadingProfile")), "原生头像侧栏组件");
  const declarations = nodes(footer, node => node.type === "VariableDeclarator", { ownScope: true });
  const hookFor = name => {
    const declaration = unique(declarations.filter(node => node.id?.name === name), `侧栏变量 ${name}`);
    if (declaration.init?.type !== "CallExpression" || declaration.init.callee.type !== "Identifier" ||
        declaration.init.arguments.length !== 0) throw new Error(`侧栏 Hook ${name} 结构未知`);
    return declaration.init.callee.name;
  };
  const authBinding = unique(declarations.filter(node => node.id.type === "ObjectPattern" &&
    ["accountId", "authMethod", "userId"].every(name => props(node.id)[name])), "账户身份解构");
  if (authBinding.init?.type !== "Identifier") throw new Error("账户身份来源未知");
  const authHook = hookFor(authBinding.init.name);
  const profileCall = unique(nodes(footer, node => node.type === "CallExpression" &&
    node.arguments[1]?.type === "ObjectExpression" &&
    ["sidebarFooter", "hideUsage", "triggerButton"].every(name => props(node.arguments[1])[name])), "头像菜单调用");
  const profileProps = props(profileCall.arguments[1]);
  const width = props(profileProps.sidebarFooter).width;
  if (width?.type !== "ConditionalExpression" || width.test.type !== "Identifier" ||
      width.alternate.type !== "Identifier" || profileProps.hideUsage.type !== "Identifier") {
    throw new Error("侧栏宽度和额度可见性结构未知");
  }
  const widthRead = unique(declarations.filter(node => node.id?.name === width.alternate.name), "侧栏宽度读取");
  if (widthRead.init?.type !== "CallExpression" || widthRead.init.callee.type !== "Identifier") {
    throw new Error("原生状态订阅读取结构未知");
  }
  const readHook = widthRead.init.callee.name;
  const intlCall = unique(nodes(footer, node => node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" && key(node.callee.property) === "formatMessage" &&
    node.arguments[0]?.type === "ObjectExpression" &&
    literal(props(node.arguments[0]).id) === "codex.profileFooter.settingsFallback"), "侧栏国际化");
  const intlHook = hookFor(intlCall.callee.object.name);
  const jsx = profileCall.callee.type === "SequenceExpression" ? profileCall.callee.expressions.at(-1) : profileCall.callee;
  if (jsx?.type !== "MemberExpression" || jsx.object.type !== "Identifier" || key(jsx.property) !== "jsx") {
    throw new Error("原生侧栏 JSX 结构未知");
  }
  const usageFetch = unique(ast.body.filter(node => node.type === "FunctionDeclaration" &&
    nodes(node, child => literal(child) === "/wham/usage").length > 0), "官方额度请求");
  const usageAtom = unique(nodes(ast, node => node.type === "AssignmentExpression" &&
    node.operator === "=" && node.left.type === "Identifier" && node.right.type === "CallExpression" &&
    node.right.arguments.some(argument => {
      if (argument.type !== "ArrowFunctionExpression") return false;
      const returned = argument.body.type === "BlockStatement" ? argument.body.body.at(-1) : null;
      const options = props(returned?.type === "ReturnStatement" ? returned.argument : argument.body);
      return options.refetchInterval && options.queryFn && nodes(options.queryFn, call =>
        call.type === "CallExpression" && call.callee.type === "Identifier" &&
        call.callee.name === usageFetch.id.name).length > 0;
    })), "共享额度查询");
  const initialize = unique(ast.body.filter(node => node.type === "FunctionDeclaration" &&
    node.start < usageAtom.start && node.end > usageAtom.end), "额度查询初始化器");
  const avatar = unique(nodes(footer, node => node.type === "CallExpression" &&
    node.arguments[1]?.type === "ObjectExpression" &&
    ["colorKey", "name", "size", "src", "fallback", "loadingFallback"].every(name => props(node.arguments[1])[name])), "原生头像");
  const avatarAssignment = unique(nodes(footer, node => node.type === "AssignmentExpression" &&
    node.left.type === "Identifier" && node.right.type === "ConditionalExpression" &&
    node.right.start < avatar.start && node.right.end > avatar.end), "头像渲染分支");
  const avatarSlot = unique(declarations.filter(node => node.init?.type === "Identifier" &&
    node.init.name === avatarAssignment.left.name), "账户按钮头像插槽");
  if (!nodes(footer, node => node.type === "Property" && key(node.key) === "icon" &&
    node.value?.type === "Identifier" && node.value.name === avatarSlot.id.name).length) {
    throw new Error("原生账户按钮头像引用未知");
  }
  return { footer, avatarSlot, authHook, readHook,
    intlHook, jsx: jsx.object.name, compact: width.test.name, hidden: profileProps.hideUsage.name,
    usageAtom: usageAtom.left.name, initialize: initialize.id.name };
}

function patchSource(source) {
  if (!source.includes("codex.profileFooter.settingsFallback")) return { status: "not-applicable", source };
  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    if (source.includes(MARKER)) {
      if (source.split(MARKER).length !== 2 || !source.includes(MODULE) ||
          !source.includes(`jsx)(${COMPONENT},{fallback:`) ||
          !ast.body.some(node => node.type === "FunctionDeclaration" && node.id?.name === ACCOUNT_COMPONENT)) {
        throw new Error("侧栏额度补丁标记不完整");
      }
      return { status: "already-patched", source };
    }
    if ([COMPONENT, ACCOUNT_COMPONENT, RENDER, MODULE].some(value => source.includes(value))) {
      throw new Error("侧栏额度注入名称已占用");
    }
    const shape = analyze(source, ast);
    const call = `(0,${shape.jsx}.jsx)(${COMPONENT},{fallback:${shape.avatarSlot.init.name},compact:${shape.compact},hidden:${shape.hidden}})`;
    const bridges = `\n${MARKER}\nfunction ${COMPONENT}(props){const auth=${shape.authHook}();return props.hidden||auth.authMethod!==\`chatgpt\`?props.fallback:(0,${shape.jsx}.jsx)(${ACCOUNT_COMPONENT},props);}\n`
      + `function ${ACCOUNT_COMPONENT}(props){${shape.initialize}();const auth=${shape.authHook}(),usage=${shape.readHook}(${shape.usageAtom}),intl=${shape.intlHook}();return ${RENDER}({...props,auth,usage:usage.data,intl,jsx:${shape.jsx}});}\n`;
    const patched = applyEdits(source, [{ start: shape.avatarSlot.init.start, end: shape.avatarSlot.init.end, text: call }]);
    const result = `import {renderSidebarUsage as ${RENDER}} from "./${MODULE}";\n` + patched + bridges;
    parse(result, { ecmaVersion: "latest", sourceType: "module" });
    return { status: "patched", source: result };
  } catch (error) {
    return { status: "unexpected-shape", source, reason: error.message };
  }
}

function main() {
  const args = process.argv.slice(2), platform = args.find(arg => ["win", "mac-arm64", "mac-x64"].includes(arg));
  const check = args.includes("--check");
  let count = 0;
  for (const name of platform ? [platform] : ["win", "mac-arm64", "mac-x64"]) {
    const directory = path.join(SRC_DIR, name, "_asar", "webview", "assets");
    if (!platform && !fs.existsSync(directory)) continue;
    const file = unique(fs.readdirSync(directory).filter(file => /^app-initial-.*\.js$/.test(file)), "侧栏资源");
    const target = path.join(directory, file), result = patchSource(fs.readFileSync(target, "utf8"));
    if (!["patched", "already-patched"].includes(result.status)) throw new Error(result.reason ?? result.status);
    if (!check) {
      if (result.status === "patched") fs.writeFileSync(target, result.source, "utf8");
      fs.copyFileSync(path.join(__dirname, "runtime", "sidebar-usage.mjs"), path.join(directory, MODULE));
    }
    console.log(`[ok] ${relPath(target)}: 侧栏额度圆环${check ? "结构检查通过，未写文件" : "已加入"}`);
    count++;
  }
  if (!count) throw new Error("缺少侧栏额度目标资源");
}
if (require.main === module) main();
module.exports = { MODULE, MARKER, COMPONENT, ACCOUNT_COMPONENT, RENDER, patchSource };
