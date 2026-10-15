#!/usr/bin/env node
/**
 * 允许没有 ChatGPT 账户主题状态的 API-key / 自定义 Provider 使用官方强调色预设。
 * 本地只保存预设名，渲染继续复用官方预设生成器；账户主题可用时仍由账户状态优先。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const MODULE = "codex-rebuild-accent-presets.js";
const SETTINGS_MARKER = "/* codex-rebuild-local-accent-presets:settings */";
const THEME_MARKER = "/* codex-rebuild-local-accent-presets:theme */";
const PLATFORMS = ["mac-arm64", "mac-x64", "win", "unix"];

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

function importInsertion(ast) {
  const imports = ast.body.filter(node => node.type === "ImportDeclaration");
  return imports.length ? imports.at(-1).end : 0;
}

function applyEdits(source, edits) {
  let next = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  }
  parse(next, { ecmaVersion: "latest", sourceType: "module" });
  return next;
}

function patchSettingsSource(source) {
  if (!source.includes("chatgptAccentPicker.ChatGptAccentPicker.updateError") || !source.includes("accentSource")) {
    return { status: "not-applicable", source };
  }
  if (source.includes(SETTINGS_MARKER)) {
    parse(source, { ecmaVersion: "latest", sourceType: "module" });
    if (![MODULE, "__codexCurrentAccent=", "__codexAccentSelection(", "__codexSelectAccentPreset(", "__codexUseCustomAccent("].every(value => source.includes(value))) {
      return { status: "unexpected-shape", source, reason: "本地强调色设置标记不完整" };
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

    const accountCall = unique(nodes(component, node => node.type === "CallExpression" && node.callee?.type === "Identifier" &&
      node.callee.name === selectAccount), "账户强调色写入");
    const preset = accountCall.arguments[0];
    if (preset?.type !== "Identifier") throw new Error("强调色预设参数结构未知");

    const customCall = unique(nodes(component, node => node.type === "CallExpression" && node.callee?.type === "Identifier" &&
      node.callee.name === selectCustom), "切换自定义强调色");
    if (customCall.arguments.length !== 1) throw new Error("自定义强调色调用结构未知");
    const onChange = unique(nodes(component, node => node.type === "Property" && key(node.key) === "onChange" &&
      node.value?.type === "Identifier" && node.value.name === selectCustom), "自定义颜色输入");

    const importAt = importInsertion(ast);
    const originalSelection = source.slice(selection.init.start, selection.init.end);
    const originalAccountCall = source.slice(accountCall.start, accountCall.end);
    const customValue = source.slice(customCall.arguments[0].start, customCall.arguments[0].end);
    const moduleImport = `\n${SETTINGS_MARKER}\nimport {accentPresetSelection as __codexAccentSelection,selectAccentPreset as __codexSelectAccentPreset,useCustomAccent as __codexUseCustomAccent} from "./${MODULE}";`;
    const edits = [
      { start: importAt, end: importAt, text: moduleImport },
      { start: component.body.start + 1, end: component.body.start + 1,
        text: `const __codexCurrentAccent=${theme}.accent;` },
      { start: selection.init.start, end: selection.init.end,
        text: `__codexAccentSelection(${accountTheme},${originalSelection})` },
      // undefined 表示账户主题仍在加载；null 才表示没有可用账户主题。
      { start: disabled.value.start, end: disabled.value.end, text: `${accountTheme}===void 0` },
      { start: accountCall.start, end: accountCall.end,
        text: `__codexSelectAccentPreset(${accountTheme},${preset.name},()=>${selectCustom}(__codexCurrentAccent),()=>${originalAccountCall})` },
      { start: customCall.start, end: customCall.end,
        text: `__codexUseCustomAccent(${selectCustom},${customValue})` },
      { start: onChange.value.start, end: onChange.value.end,
        text: `__codexColor=>__codexUseCustomAccent(${selectCustom},__codexColor)` },
    ];
    return { status: "patched", source: applyEdits(source, edits) };
  } catch (error) {
    return { status: "unexpected-shape", source, reason: error.message };
  }
}

function patchThemeSource(source) {
  if (!["--color-background-user-message", "--color-image-generation-accent", "accentSource"].every(value => source.includes(value))) {
    return { status: "not-applicable", source };
  }
  if (source.includes(THEME_MARKER)) {
    parse(source, { ecmaVersion: "latest", sourceType: "module" });
    if (![MODULE, "__codexResolveAccentPreset(", "accentSource:`chatgpt`"].every(value => source.includes(value))) {
      return { status: "unexpected-shape", source, reason: "本地强调色主题标记不完整" };
    }
    return { status: "already-patched", source };
  }

  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const renderer = unique(ast.body.filter(node => node.type === "FunctionDeclaration" &&
      ["--color-background-user-message", "--color-image-generation-accent", "accentSource"]
        .every(value => source.slice(node.start, node.end).includes(value))), "官方强调色主题函数");
    const [theme, variant, accountPreset] = renderer.params;
    if (![theme, variant, accountPreset].every(node => node?.type === "Identifier")) {
      throw new Error("官方强调色主题参数结构未知");
    }
    const importAt = importInsertion(ast);
    const moduleImport = `\n${THEME_MARKER}\nimport {resolveAccentPreset as __codexResolveAccentPreset} from "./${MODULE}";`;
    const injection = `const __codexAccentPreset=__codexResolveAccentPreset(${theme.name}.accentSource,${accountPreset.name});if(__codexAccentPreset!==null){${accountPreset.name}=__codexAccentPreset;${theme.name}={...${theme.name},accentSource:\`chatgpt\`}}`;
    return { status: "patched", source: applyEdits(source, [
      { start: importAt, end: importAt, text: moduleImport },
      { start: renderer.body.start + 1, end: renderer.body.start + 1, text: injection },
    ]) };
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

function findTarget(directory, pattern, content, label) {
  const candidates = fs.readdirSync(directory).filter(name => pattern.test(name))
    .map(name => ({ name, path: path.join(directory, name), source: fs.readFileSync(path.join(directory, name), "utf8") }))
    .filter(file => content.every(value => file.source.includes(value)));
  if (candidates.length !== 1) throw new Error(`${label}资源数量异常（${candidates.length}）`);
  return candidates[0];
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
      const settings = findTarget(directory.path, /^general-settings-.*\.js$/,
        ["chatgptAccentPicker.ChatGptAccentPicker.updateError"], "强调色设置");
      const theme = findTarget(directory.path, /^app-initial-.*\.js$/,
        ["--color-background-user-message", "--color-image-generation-accent", "accentSource"], "强调色主题");
      const settingsResult = patchSettingsSource(settings.source);
      const themeResult = patchThemeSource(theme.source);
      for (const [label, result] of [["强调色设置", settingsResult], ["强调色主题", themeResult]]) {
        if (["unexpected-shape", "not-applicable"].includes(result.status)) {
          throw new Error(`${label}：${result.reason ?? "结构未知"}`);
        }
      }
      console.log(`  [${directory.platform}] ${relPath(settings.path)}`);
      console.log(`  [${directory.platform}] ${relPath(theme.path)}`);
      if (check) {
        console.log("    [ok] 本地预设设置入口与官方主题生成器结构已核对；dry-run 未写文件");
        continue;
      }
      if (settingsResult.status === "patched") fs.writeFileSync(settings.path, settingsResult.source, "utf8");
      if (themeResult.status === "patched") fs.writeFileSync(theme.path, themeResult.source, "utf8");
      fs.copyFileSync(path.join(__dirname, "runtime", "accent-presets.mjs"), path.join(directory.path, MODULE));
      patched += Number(settingsResult.status === "patched" || themeResult.status === "patched");
      console.log("    [ok] 本地预设已接入官方完整主题渲染；账户主题仍优先");
    } catch (error) {
      console.error(`  [x] ${directory.platform}: ${error.message}`);
      failed++;
    }
  }
  if (!directories.length) { console.error("  [x] 缺少目标平台界面资源"); failed++; }
  if (failed) process.exitCode = 1;
  else console.log(`  [ok] ${patched} platform bundle set(s) patched`);
}

if (require.main === module) main();
module.exports = { MODULE, SETTINGS_MARKER, THEME_MARKER, patchSettingsSource, patchThemeSource };
