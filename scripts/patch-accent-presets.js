#!/usr/bin/env node
/**
 * 允许没有 ChatGPT 账户主题状态的 API-key / 自定义 Provider 使用官方强调色预设。
 * 账户主题加载中仍保持禁用；账户可用时完整保留官方同步流程。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "/* codex-rebuild-local-accent-presets */";
const STORAGE_KEY = "codex-rebuild:accent-preset:v1";
const PLATFORMS = ["mac-arm64", "mac-x64", "win", "unix"];
const HELPER = `${MARKER}
const __codexAccentPresetKey=${JSON.stringify(STORAGE_KEY)},__codexAccentPresets=new Set(["default","blue","green","yellow","pink","orange","purple","black"]);
function __codexStoredAccentPreset(){try{let e=globalThis.localStorage?.getItem(__codexAccentPresetKey);return __codexAccentPresets.has(e)?e:null}catch{return null}}
function __codexAccentSelection(e,t,n){return e===null?__codexStoredAccentPreset()??n:n}
function __codexResolveAccent(e,t,n){let r=e(t,n),i=/^var\\((--[^,\\s)]+)/.exec(r);if(i){let e=globalThis.getComputedStyle?.(globalThis.document?.documentElement)?.getPropertyValue(i[1]).trim();if(e)r=e}if(!/^#[0-9a-f]{6}$/i.test(r))throw Error("无法解析本地强调色预设");return r.toLowerCase()}
function __codexSelectAccent(e,t,n,r,i,a){return Promise.resolve().then(()=>{if(e!==null){globalThis.localStorage?.removeItem(__codexAccentPresetKey);return a()}globalThis.localStorage?.setItem(__codexAccentPresetKey,t);return i(__codexResolveAccent(r,t,n))})}
function __codexUseCustomAccent(e,t){globalThis.localStorage?.removeItem(__codexAccentPresetKey);return e(t)}
`;

function walk(node, visit, parent = null) {
  if (!node || typeof node !== "object" || !node.type) return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (["type", "start", "end"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) walk(child, visit, node);
    } else if (value?.type) walk(value, visit, node);
  }
}

function nodes(root, predicate) {
  const found = [];
  walk(root, (node, parent) => { if (predicate(node, parent)) found.push(node); });
  return found;
}

function literal(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

function key(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  return literal(node);
}

function unique(items, label) {
  if (items.length !== 1) throw new Error(`${label} 数量异常（${items.length}）`);
  return items[0];
}

function objectBindings(pattern) {
  return Object.fromEntries(pattern.properties.filter(property => property.type === "Property" && property.value?.type === "Identifier")
    .map(property => [key(property.key), property.value.name]));
}

function patchSource(source) {
  if (!source.includes("chatgptAccentPicker.ChatGptAccentPicker.updateError") || !source.includes("accentSource")) {
    return { status: "not-applicable", source };
  }
  if (source.includes(MARKER)) {
    parse(source, { ecmaVersion: "latest", sourceType: "module" });
    if (!["__codexAccentSelection(", "__codexSelectAccent(", "__codexUseCustomAccent("].every(value => source.includes(value))) {
      return { status: "unexpected-shape", source, reason: "本地强调色标记不完整" };
    }
    return { status: "already-patched", source };
  }

  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const component = unique(ast.body.filter(node => node.type === "FunctionDeclaration" &&
      source.slice(node.start, node.end).includes("chatgptAccentPicker.ChatGptAccentPicker.updateError") &&
      source.slice(node.start, node.end).includes("accentSource")), "强调色组件");
    const props = unique(nodes(component, node => node.type === "VariableDeclarator" && node.id?.type === "ObjectPattern")
      .map(node => objectBindings(node.id))
      .filter(bindings => ["theme", "variant", "onSelect", "onCustomColorChange"].every(name => bindings[name])), "强调色属性");
    const theme = props.theme;
    const variant = props.variant;
    const selectAccount = props.onSelect;
    const selectCustom = props.onCustomColorChange;

    const disabled = unique(nodes(component, node => node.type === "Property" && key(node.key) === "disabled" &&
      node.value?.type === "BinaryExpression" && ["==", "==="].includes(node.value.operator) &&
      node.value.left?.type === "Identifier" && literal(node.value.right) === null), "预设禁用条件");
    const accountTheme = disabled.value.left.name;
    const selection = unique(nodes(component, node => node.type === "VariableDeclarator" && node.init?.type === "ConditionalExpression" &&
      source.slice(node.init.start, node.init.end).includes(`${theme}.accentSource`) &&
      source.slice(node.init.start, node.init.end).includes("`chatgpt`") &&
      source.slice(node.init.start, node.init.end).includes("`custom`")), "当前强调色来源");

    const colorCalls = nodes(component, node => node.type === "CallExpression" && node.callee?.type === "Identifier" &&
      node.arguments.length === 2 && node.arguments[1]?.type === "Identifier" && node.arguments[1].name === variant &&
      source.slice(node.arguments[0].start, node.arguments[0].end).includes("effectiveTheme"));
    const colorFunction = unique(colorCalls, "官方强调色函数").callee.name;
    const accountCalls = nodes(component, node => node.type === "CallExpression" && node.callee?.type === "Identifier" &&
      node.callee.name === selectAccount);
    const accountCall = unique(accountCalls, "账户强调色写入");
    const preset = accountCall.arguments[0];
    if (preset?.type !== "Identifier") throw new Error("强调色预设参数结构未知");

    const customCalls = nodes(component, node => node.type === "CallExpression" && node.callee?.type === "Identifier" &&
      node.callee.name === selectCustom);
    const customCall = unique(customCalls, "切换自定义强调色");
    if (customCall.arguments.length !== 1) throw new Error("自定义强调色调用结构未知");
    const onChange = unique(nodes(component, node => node.type === "Property" && key(node.key) === "onChange" &&
      node.value?.type === "Identifier" && node.value.name === selectCustom), "自定义颜色输入");

    const imports = ast.body.filter(node => node.type === "ImportDeclaration");
    const insertAt = imports.length ? imports.at(-1).end : 0;
    const edits = [
      { start: insertAt, end: insertAt, text: `\n${HELPER}` },
      { start: selection.init.start, end: selection.init.end,
        text: `__codexAccentSelection(${accountTheme},${theme}.accentSource,${source.slice(selection.init.start, selection.init.end)})` },
      // undefined 表示账户主题仍在加载；null 才表示没有可用账户主题。
      { start: disabled.value.start, end: disabled.value.end, text: `${accountTheme}===void 0` },
      { start: accountCall.start, end: accountCall.end,
        text: `__codexSelectAccent(${accountTheme},${preset.name},${variant},${colorFunction},${selectCustom},()=>${source.slice(accountCall.start, accountCall.end)})` },
      { start: customCall.start, end: customCall.end,
        text: `__codexUseCustomAccent(${selectCustom},${source.slice(customCall.arguments[0].start, customCall.arguments[0].end)})` },
      { start: onChange.value.start, end: onChange.value.end,
        text: `__codexColor=>__codexUseCustomAccent(${selectCustom},__codexColor)` },
    ];
    let next = source;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    }
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
    const candidates = fs.readdirSync(directory.path).filter(name => /^general-settings-.*\.js$/.test(name))
      .map(name => ({ name, path: path.join(directory.path, name), source: fs.readFileSync(path.join(directory.path, name), "utf8") }))
      .filter(file => file.source.includes("chatgptAccentPicker.ChatGptAccentPicker.updateError"));
    if (candidates.length !== 1) {
      console.error(`  [x] ${directory.platform}: 强调色设置资源数量异常（${candidates.length}）`);
      failed++;
      continue;
    }
    const target = candidates[0];
    const result = patchSource(target.source);
    if (result.status === "unexpected-shape" || result.status === "not-applicable") {
      console.error(`  [x] ${directory.platform}: ${result.reason ?? "强调色设置结构未知"}`);
      failed++;
      continue;
    }
    console.log(`  [${directory.platform}] ${relPath(target.path)}`);
    if (result.status === "already-patched") console.log("    [ok] 本地强调色预设已启用");
    else if (check) console.log("    [?] 可启用本地强调色预设；dry-run 未写文件");
    else {
      fs.writeFileSync(target.path, result.source, "utf8");
      patched++;
      console.log("    * 无账户主题时本地应用预设；账户可用时保留官方同步");
    }
  }
  if (!directories.length) { console.error("  [x] 缺少目标平台界面资源"); failed++; }
  if (failed) process.exitCode = 1;
  else console.log(`  [ok] ${patched} bundle(s) patched`);
}

if (require.main === module) main();
module.exports = { HELPER, MARKER, STORAGE_KEY, patchSource };
