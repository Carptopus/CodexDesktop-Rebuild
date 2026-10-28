#!/usr/bin/env node
/** 在官方启动配置/可信 IPC 就绪后挂载独立外观 JSON，并扩展原有 preload 桥。 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { SRC_DIR } = require("./patch-util");
const { CHANNELS } = require("./runtime/rebuild-settings.cjs");
const MAIN_MARKER = "/* codex-rebuild-settings:main */";
const PRELOAD_MARKER = "/* codex-rebuild-settings:preload */";
const MODULE = "codex-rebuild-settings.cjs";
function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node, ancestors);
  const parents = node.type ? [...ancestors, node] : ancestors;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, parents));
    else if (value?.type) walk(value, visit, parents);
  }
}
const key = node => node?.name ?? node?.value;
const literal = node => node?.type === "Literal" ? node.value : node?.type === "TemplateLiteral" && !node.expressions.length ? node.quasis[0].value.cooked : undefined;
const ast = source => parse(source, { ecmaVersion: "latest", sourceType: "script" });
function properties(node) {
  return node?.type === "ObjectExpression" ? Object.fromEntries(node.properties.filter(prop => prop.type === "Property").map(prop => [key(prop.key), prop.value])) : {};
}
function patchMain(source) {
  const matches = [];
  walk(ast(source), (node, parents) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.arguments.length !== 1) return;
    const props = properties(node.arguments[0]);
    if (!["buildFlavor", "getContextForWebContents", "isTrustedIpcEvent"].every(name => props[name])) return;
    if (props.isTrustedIpcEvent.type !== "Identifier" || props.getContextForWebContents.type !== "MemberExpression") throw new Error("官方可信 IPC 注册参数结构未知");
    const owner = parents.findLast(parent => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(parent.type));
    if (!owner) throw new Error("官方可信 IPC 注册不在真实启动函数内");
    const homes = [];
    walk(owner.body, child => {
      if (child.type !== "VariableDeclarator" || child.id.type !== "Identifier" || child.init?.type !== "AwaitExpression" || child.init.argument.type !== "CallExpression") return;
      const initProps = properties(child.init.argument.arguments[0]);
      if (initProps.moduleDir?.type === "Identifier" && initProps.moduleDir.name === "__dirname" && child.end < node.start) homes.push(child.id.name);
    });
    if (homes.length !== 1 || !source.slice(owner.start, owner.end).includes(`${homes[0]}.codexHome`)) throw new Error("官方真实启动 codexHome 解析结构未知");
    matches.push({ node, home: homes[0], trusted: props.isTrustedIpcEvent.name });
  });
  if (matches.length !== 1) throw new Error("官方可信 IPC 注册挂载点缺失或不唯一");
  const { node, home, trusted } = matches[0];
  const injection = `,${MAIN_MARKER}require("./${MODULE}").install({codexHome:${home}.codexHome,isTrustedIpcEvent:${trusted}})`;
  if (source.includes(MAIN_MARKER)) {
    if (source.split(MAIN_MARKER).length !== 2 || !source.slice(node.end).startsWith(injection)) throw new Error("本地外观配置 main 标记位置或契约异常");
    return source;
  }
  if (source.includes(MODULE)) throw new Error("本地外观配置 main 存在无标记注入");
  const result = source.slice(0, node.end) + injection + source.slice(node.end);
  ast(result); return result;
}
function patchPreload(source) {
  const tree = ast(source), exposures = [], declarations = [];
  walk(tree, node => {
    if (node.type === "VariableDeclarator") declarations.push(node);
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && key(node.callee.property) === "exposeInMainWorld" && literal(node.arguments[0]) === "electronBridge") exposures.push(node);
  });
  if (exposures.length !== 1) throw new Error("官方 electronBridge 暴露点缺失或不唯一");
  const exposure = exposures[0], bridge = exposure.arguments[1];
  const electron = exposure.callee.object;
  if (bridge?.type !== "Identifier" || electron?.type !== "MemberExpression" || key(electron.property) !== "contextBridge" || electron.object.type !== "Identifier") throw new Error("官方 preload contextBridge 结构未知");
  const symbol = electron.object.name;
  const imports = declarations.filter(node => node.id.name === symbol && node.init?.type === "CallExpression" && node.init.callee.name === "require" && literal(node.init.arguments[0]) === "electron");
  const objects = declarations.filter(node => node.id.name === bridge.name && node.init?.type === "ObjectExpression");
  if (imports.length !== 1 || objects.length !== 1) throw new Error("官方 preload Electron 依赖或桥对象缺失");
  const object = objects[0].init, props = properties(object);
  if (!["sendMessageFromView", "getSystemThemeVariant", "getSharedObjectSnapshotValue"].every(name => props[name])) throw new Error("官方 preload 桥缺少必要通信契约");
  const ipc = `${symbol}.ipcRenderer`;
  const injection = `,${PRELOAD_MARKER}rebuildSettings:{read:()=>${ipc}.sendSync(${JSON.stringify(CHANNELS.read)}),write:patch=>${ipc}.invoke(${JSON.stringify(CHANNELS.write)},patch),onChange:fn=>{if(typeof fn!=="function")throw new TypeError("本地外观配置监听器必须是函数");const listener=(_event,value)=>fn(value);${ipc}.on(${JSON.stringify(CHANNELS.changed)},listener);return()=>${ipc}.removeListener(${JSON.stringify(CHANNELS.changed)},listener)}}`;
  if (source.includes(PRELOAD_MARKER)) {
    if (source.split(PRELOAD_MARKER).length !== 2 || !source.slice(object.start, object.end).endsWith(injection + "}")) throw new Error("本地外观配置 preload 标记位置或契约异常");
    return source;
  }
  if (props.rebuildSettings || source.includes(CHANNELS.read)) throw new Error("本地外观配置 preload 存在无标记注入");
  const at = object.end - 1, result = source.slice(0, at) + injection + source.slice(at);
  ast(result); return result;
}
function main() {
  const platforms = ["mac-arm64", "mac-x64", "win", "unix"], args = process.argv.slice(2);
  const selected = args.filter(arg => platforms.includes(arg));
  if (selected.length > 1 || args.some(arg => !platforms.includes(arg) && arg !== "--check")) throw new Error("本地外观配置补丁参数无效");
  let targets = (selected.length ? selected : platforms.filter(platform => fs.existsSync(path.join(SRC_DIR, platform, "_asar"))))
    .map(platform => ({ platform, root: path.join(SRC_DIR, platform, "_asar") }));
  if (!targets.length && !selected.length && fs.existsSync(path.join(SRC_DIR, "package.json"))) targets = [{ platform: "legacy", root: SRC_DIR }];
  if (!targets.length) throw new Error("本地外观配置补丁缺少平台资源");
  const runtime = path.join(__dirname, "runtime", "rebuild-settings.cjs"), client = path.join(__dirname, "runtime", "rebuild-settings.mjs");
  for (const file of [runtime, client]) if (!fs.statSync(file).isFile()) throw new Error(`本地外观配置依赖缺失：${file}`);
  const prepared = targets.map(({ platform, root }) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (typeof manifest.main !== "string" || !manifest.main) throw new Error(`[${platform}] 官方 package.main 缺失`);
    const entry = path.resolve(root, manifest.main), relative = path.relative(root, entry);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) throw new Error(`[${platform}] 官方 package.main 不存在或逃出 ASAR`);
    const actualRelative = path.relative(fs.realpathSync(root), fs.realpathSync(entry));
    if (actualRelative === ".." || actualRelative.startsWith(".." + path.sep) || path.isAbsolute(actualRelative)) throw new Error(`[${platform}] 官方 package.main 实际目标逃出 ASAR`);
    const build = path.dirname(entry), assets = path.join(root, "webview", "assets");
    if (!fs.statSync(assets).isDirectory()) throw new Error(`[${platform}] 官方 webview 资源缺失`);
    const names = fs.readdirSync(build).filter(name => name.endsWith(".js") && fs.readFileSync(path.join(build, name), "utf8").includes("exports.runMainAppStartup="));
    if (names.length !== 1) throw new Error(`[${platform}] 官方 main 启动资源缺失或不唯一`);
    const mainFile = path.join(build, names[0]), preloadFile = path.join(build, "preload.js");
    return { platform, build, assets, mainFile, preloadFile, mainSource: patchMain(fs.readFileSync(mainFile, "utf8")), preloadSource: patchPreload(fs.readFileSync(preloadFile, "utf8")) };
  });
  for (const target of prepared) {
    if (args.includes("--check")) { console.log(`[ok] [${target.platform}] 本地外观 JSON、官方可信 IPC 与 preload 扩展挂载点已核对`); continue; }
    fs.writeFileSync(target.mainFile, target.mainSource); fs.writeFileSync(target.preloadFile, target.preloadSource);
    fs.copyFileSync(runtime, path.join(target.build, MODULE));
    fs.copyFileSync(client, path.join(target.assets, "rebuild-settings.mjs"));
    console.log(`[ok] [${target.platform}] 已接入 CODEX_HOME 独立外观 JSON 与限定 preload 桥`);
  }
}
if (require.main === module) main();
module.exports = { patchMain, patchPreload, MAIN_MARKER, PRELOAD_MARKER, MODULE };
