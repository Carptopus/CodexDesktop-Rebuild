#!/usr/bin/env node
/** Owl 入口前仅传入环境；官方 userData 设置后、单实例锁前挂载真实隔离检查。 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { SRC_DIR } = require("./patch-util");
const environmentModule = "codex-rebuild-test-environment.cjs";
const isolationModule = "codex-rebuild-test-isolation.cjs";
function walk(node, visit, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, node));
    else if (value?.type) walk(value, visit, node);
  }
}
function literal(node) { return node?.type === "Literal" ? node.value : node?.type === "TemplateLiteral" && !node.expressions.length ? node.quasis[0].value.cooked : undefined; }
function astOf(source, moduleMode) { return parse(source, { ecmaVersion: "latest", sourceType: moduleMode ? "module" : "script", allowHashBang: true }); }
function main() {
  if (!process.argv.includes("win")) { console.log("[skip] Windows test isolation patch not applicable"); return; }
  const directory = path.join(SRC_DIR, "win", "_asar");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  if (typeof manifest.main !== "string") throw new Error("上游缺少真实 main 入口");
  const entry = path.resolve(directory, manifest.main);
  if (!entry.startsWith(directory + path.sep)) throw new Error("上游入口逃出 ASAR 目录");
  const mode = file => file.endsWith(".mjs") || !file.endsWith(".cjs") && manifest.type === "module";
  const entrySource = fs.readFileSync(entry, "utf8"), entryAst = astOf(entrySource, mode(entry));
  const environmentLoader = mode(entry) ? `import "./${environmentModule}";` : `require("./${environmentModule}");`;
  const first = entryAst.body.find(node => !node.directive);
  const edits = new Map();
  const add = (file, edit) => { const list = edits.get(file) || []; list.push(edit); edits.set(file, list); };
  if (entrySource.includes("Desktop network requirements prevented startup") && !entrySource.includes("native-startup-error.json")) {
    const catches = [];
    walk(entryAst, node => {
      if (node.type === "ArrowFunctionExpression" && node.body.type === "BlockStatement" && sourceOf(node).includes("Desktop network requirements prevented startup")) catches.push(node);
    });
    function sourceOf(node) { return entrySource.slice(node.start, node.end); }
    if (catches.length !== 1 || catches[0].params[0]?.type !== "Identifier" || mode(entry)) throw new Error("官方启动失败处理结构未知");
    const error = catches[0].params[0].name;
    add(entry, { at: catches[0].body.start + 1, text: `if(process.env.CODEX_REBUILD_SMOKE_EXIT==="1"&&process.env.CODEX_REBUILD_TEST_ROOT){try{require("node:fs").writeFileSync(require("node:path").join(process.env.CODEX_REBUILD_TEST_ROOT,"native-startup-error.json"),JSON.stringify({message:${error}?.message??String(${error}),stack:${error}?.stack,cause:${error}?.cause?.message}));}catch{}}` });
  }
  if (!entrySource.includes(environmentModule)) {
    if (entrySource.includes(isolationModule)) throw new Error("旧隔离模块仍位于最早入口，请从原始官方资源重新应用");
    const directives = entryAst.body.filter(node => node.directive);
    const offset = Math.max(entrySource.startsWith("#!") ? entrySource.indexOf("\n") + 1 : 0, ...directives.map(node => node.end));
    add(entry, { at: offset, text: `\n${environmentLoader}\n` });
  } else if (!first || entrySource.slice(first.start, first.end) !== environmentLoader) throw new Error("隔离环境入口位置异常");
  const targets = [];
  const build = path.dirname(entry);
  for (const name of fs.readdirSync(build).filter(name => /\.(?:js|cjs|mjs)$/.test(name))) {
    if ([environmentModule, isolationModule].includes(name)) continue;
    const file = path.join(build, name), source = fs.readFileSync(file, "utf8");
    if (!source.includes("CODEX_ELECTRON_USER_DATA_PATH") || !source.includes("requestSingleInstanceLock")) continue;
    const ast = astOf(source, mode(file)), calls = [], locks = [];
    walk(ast, (node, parent) => {
      if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
      if (node.callee.property.name === "setPath" && literal(node.arguments[0]) === "userData" && node.arguments[1]?.type === "CallExpression") calls.push({ node, parent });
      if (node.callee.property.name === "requestSingleInstanceLock") locks.push(node);
    });
    if (calls.length !== 1 || calls[0].parent.type !== "SequenceExpression") throw new Error(`官方 User Data 初始化结构未知：${name}`);
    const call = calls[0].node;
    const startupLocks = locks.filter(lock => lock.start > call.end && ast.body.some(statement => statement.type === "IfStatement" && statement.start <= lock.start && statement.end >= lock.end)
      || lock.start > call.end && ast.body.some(statement => statement.type === "ExpressionStatement" && statement.start <= lock.start && statement.end >= lock.end));
    if (startupLocks.length !== 1) throw new Error("官方启动单实例锁缺失或不唯一");
    const resolver = ast.body.find(node => node.type === "FunctionDeclaration" && node.id.name === call.arguments[1].callee.name);
    if (!resolver || !source.slice(resolver.start, resolver.end).includes("CODEX_ELECTRON_USER_DATA_PATH")) throw new Error("官方 User Data 环境解析结构未知");
    const hook = mode(file) ? `await import("./${isolationModule}")` : `require("./${isolationModule}")`;
    if (!source.includes(isolationModule)) add(file, { at: call.end, text: `,${hook}` });
    else if (!source.slice(call.end).startsWith(`,${hook}`)) throw new Error("隔离模块未紧邻官方 User Data 设置");
    targets.push(file);
  }
  if (targets.length !== 1) throw new Error("官方 bootstrap 隔离挂载点缺失或不唯一");
  const patched = new Map();
  for (const [file, list] of edits) {
    let source = fs.readFileSync(file, "utf8");
    for (const edit of list.sort((a,b) => b.at-a.at)) source = source.slice(0,edit.at)+edit.text+source.slice(edit.at);
    astOf(source, mode(file)); patched.set(file, source);
  }
  if (process.argv.includes("--check")) { console.log(`[ok] Owl 环境入口及官方 bootstrap/单实例锁前挂载点已核对：${path.basename(targets[0])}`); return; }
  for (const [file, source] of patched) fs.writeFileSync(file, source);
  for (const name of [environmentModule, isolationModule]) fs.copyFileSync(path.join(__dirname, "runtime", name.replace("codex-", "")), path.join(build, name));
  console.log("[ok] 入口传入隔离环境；官方 userData 初始化后验证路径、配置 sessionData，先于单实例锁");
}
if (require.main === module) main();
