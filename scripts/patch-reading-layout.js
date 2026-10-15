#!/usr/bin/env node
/** 保留原生外观设置页，追加正文宽度偏好与限定作用域的排版样式。 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { SRC_DIR } = require("./patch-util");
const MODULE = "codex-rebuild-reading-width.js";
const MARKER = "__CodexRebuildReadingWidth";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}
function key(node) { return node?.name ?? node?.value; }
function literal(node) { return node?.type === "Literal" ? node.value : node?.type === "TemplateLiteral" && !node.expressions.length ? node.quasis[0].value.cooked : null; }

function patchDialogs(source) {
  if (source.includes("codex-rebuild-dialog-default")) return source;
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const functions = ast.body.filter(node => node.type === "FunctionDeclaration" && node.params.length === 1 && node.body.body.length === 1
    && node.body.body[0].type === "ReturnStatement" && ["narrow", "compact", "wide", "xwide", "xxwide", "editor"].every(value => source.slice(node.start, node.end).includes(`\`${value}\``))
    && source.slice(node.start, node.end).includes("w-[380px]"));
  if (functions.length !== 1) throw new Error("原生对话框尺寸映射结构未知");
  const edits = [], seen = new Set();
  let branch = functions[0].body.body[0].argument;
  while (branch.type === "ConditionalExpression") {
    const name = literal(branch.test.right);
    if (["narrow", "feature", "compact", "wide", "xwide", "xxwide", "editor"].includes(name)) {
      const classes = literal(branch.consequent);
      if (typeof classes !== "string" || !/(?:^|\s)w-(?:\[[^\]]+\]|[\w.]+)/.test(classes)) throw new Error(`对话框 ${name} 宽度结构未知`);
      const replaced = classes.replace(/(?:^|\s)w-(?:\[[^\]]+\]|[\w.]+)/, ` codex-rebuild-dialog-${name}`).trim();
      edits.push({ start: branch.consequent.start, end: branch.consequent.end, text: JSON.stringify(replaced) }); seen.add(name);
    }
    branch = branch.alternate;
  }
  if (seen.size !== 7 || literal(branch) !== "w-130") throw new Error("原生默认对话框宽度结构未知");
  edits.push({ start: branch.start, end: branch.end, text: '"codex-rebuild-dialog-default"' });
  let patched = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  parse(patched, { ecmaVersion: "latest", sourceType: "module" });
  return patched;
}

function patchSettings(source) {
  if (source.includes(MARKER)) {
    if (!source.includes(MODULE) || !source.includes(`jsx)(${MARKER}`)) throw new Error("阅读布局标记不完整");
    return source;
  }
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const sections = ast.body.filter(node => node.type === "FunctionDeclaration" && source.slice(node.start, node.end).includes("settings.appearance.visualStyle"));
  if (sections.length !== 1) throw new Error("原生外观设置分区结构未知");
  const section = sections[0], arrays = [], states = [], intlCalls = [];
  walk(section, node => {
    if (node.type === "ArrayExpression" && node.elements.some(element => element?.type === "CallExpression" && element.arguments[1]?.type === "ObjectExpression"
      && element.arguments[1].properties.some(prop => key(prop.key) === "section" && literal(prop.value) === "visual"))) arrays.push(node);
    if (node.type === "CallExpression" && node.callee.type === "SequenceExpression") {
      const callee = node.callee.expressions.at(-1);
      if (callee.type === "MemberExpression" && key(callee.property) === "useState") states.push(callee.object.name);
    }
  });
  if (arrays.length !== 1 || !states.length || new Set(states).size !== 1) throw new Error("外观设置 React/行结构未知");
  const child = arrays[0].elements.find(element => element?.type === "CallExpression" && element.arguments[1]?.properties?.some(prop => key(prop.key) === "section" && literal(prop.value) === "visual"));
  const jsx = child.callee.expressions.at(-1).object.name;
  const fonts = ast.body.filter(node => node.type === "FunctionDeclaration" && source.slice(node.start, node.end).includes("settings.appearance.uiFontSize.description"));
  if (fonts.length !== 1) throw new Error("原生设置行结构未知");
  let row;
  walk(fonts[0], node => {
    if (node.type !== "CallExpression" || node.arguments[0]?.type !== "Identifier" || node.arguments[1]?.type !== "ObjectExpression") return;
    const names = node.arguments[1].properties.map(prop => key(prop.key));
    if (["label", "description", "control"].every(name => names.includes(name))) row = node.arguments[0].name;
  });
  // 从原生设置组件的 formatMessage 接收者，反向识别 useIntl 调用。
  const fontDeclarations = [];
  walk(fonts[0], node => { if (node.type === "VariableDeclarator") fontDeclarations.push(node); });
  walk(fonts[0], node => {
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && key(node.callee.property) === "formatMessage") {
      const declaration = fontDeclarations.find(item => item.id.name === node.callee.object.name && item.init?.type === "CallExpression" && item.init.callee.type === "Identifier");
      if (declaration) intlCalls.push(declaration.init.callee.name);
    }
  });
  if (!row || !intlCalls.length || new Set(intlCalls).size !== 1) throw new Error("原生设置行/语言上下文未知");
  const at = arrays[0].end - 1;
  const result = `import {renderReadingWidth as __renderCodexReadingWidth} from "./${MODULE}";\n`
    + source.slice(0, at) + `,(0,${jsx}.jsx)(${MARKER},{})` + source.slice(at)
    + `\nfunction ${MARKER}(){return __renderCodexReadingWidth(${states[0]},${jsx},${row},${intlCalls[0]}());}\n`;
  parse(result, { ecmaVersion: "latest", sourceType: "module" });
  return result;
}

function main() {
  if (!process.argv.includes("win")) { console.log("[skip] Windows reading layout patch not applicable"); return; }
  const directory = path.join(SRC_DIR, "win", "_asar", "webview", "assets");
  const files = fs.readdirSync(directory).filter(name => name.endsWith(".js"));
  const settings = files.filter(name => /^general-settings-/.test(name)
    && fs.readFileSync(path.join(directory, name), "utf8").includes("settings.appearance.visualStyle"));
  if (settings.length !== 1) throw new Error("原生设置资源缺失或不唯一");
  const entry = files.filter(name => /^app-initial-/.test(name) && fs.readFileSync(path.join(directory, name), "utf8").includes("thread-content-responsive-max-width"));
  if (entry.length !== 1) throw new Error("正文响应式宽度结构未知");
  const settingsPath = path.join(directory, settings[0]);
  const settingsSource = fs.readFileSync(settingsPath, "utf8"), patched = patchSettings(settingsSource);
  const entryPath = path.join(directory, entry[0]), source = fs.readFileSync(entryPath, "utf8");
  const loader = `import "./${MODULE}";\n`;
  const entryPatched = source.includes(MODULE) ? source : loader + source;
  parse(entryPatched, { ecmaVersion: "latest", sourceType: "module" });
  const dialogTargets = files.filter(name => /^app-shared-/.test(name) && fs.readFileSync(path.join(directory, name), "utf8").includes("codex-dialog"));
  if (dialogTargets.length !== 1) throw new Error("原生对话框资源缺失或不唯一");
  const dialogPath = path.join(directory, dialogTargets[0]);
  const dialogPatched = patchDialogs(fs.readFileSync(dialogPath, "utf8"));
  if (process.argv.includes("--check")) { console.log("[ok] 原生外观设置/响应式正文结构已核对，8 档宽度及排版样式可注入"); return; }
  fs.writeFileSync(settingsPath, patched);
  fs.writeFileSync(entryPath, entryPatched);
  fs.writeFileSync(dialogPath, dialogPatched);
  fs.copyFileSync(path.join(__dirname, "runtime", "reading-width.mjs"), path.join(directory, MODULE));
  console.log("[ok] 已加入原生正文宽度设置、代码/表格宽度同步、对话框扩宽及粗体着色");
}
if (require.main === module) main();
module.exports = { patchSettings };
