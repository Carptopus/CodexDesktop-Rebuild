#!/usr/bin/env node
/** 隐藏账户菜单中的 Pet/Mini 入口；保留浮动面板及其全局快捷键。 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "/* codex-rebuild-hide-pet-menu */";
const LABEL_IDS = [
  "codex.profileFooter.showPet",
  "codex.profileFooter.hidePet",
  "codex.profileFooter.showMini",
  "codex.profileFooter.hideMini",
];
const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value?.type) walk(value, visit);
  }
}

function literal(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function propertyName(property) {
  if (property?.computed) return null;
  if (property?.key?.type === "Identifier") return property.key.name;
  return literal(property?.key);
}

function patchSource(source) {
  if (!LABEL_IDS.every((id) => source.includes(id))) {
    return { status: "not-applicable", source };
  }
  if (source.includes(MARKER)) {
    const count = source.split(MARKER).length - 1;
    if (count !== 1) return { status: "unexpected-shape", source, count };
    parse(source, { ecmaVersion: "latest", sourceType: "module" });
    return { status: "already-patched", source, count: 0 };
  }

  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const petComponents = ast.body.filter(
    (node) =>
      node.type === "FunctionDeclaration" &&
      node.id?.name &&
      LABEL_IDS.every((id) => source.slice(node.start, node.end).includes(id)),
  );
  if (petComponents.length === 0) {
    return { status: "not-applicable", source };
  }
  if (petComponents.length !== 1) {
    return {
      status: "unexpected-pet-component-count",
      source,
      count: petComponents.length,
    };
  }

  const calls = [];
  walk(ast, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.arguments[0]?.type !== "Identifier" ||
      node.arguments[0].name !== petComponents[0].id.name ||
      node.arguments[1]?.type !== "ObjectExpression"
    ) {
      return;
    }
    const names = new Set(
      node.arguments[1].properties
        .filter((property) => property.type === "Property")
        .map(propertyName),
    );
    if (["isOverlayOpen", "onTogglePet", "petShortcut"].every((name) => names.has(name))) {
      calls.push(node);
    }
  });
  if (calls.length !== 1) {
    return {
      status: "unexpected-pet-menu-call-count",
      source,
      count: calls.length,
    };
  }

  const call = calls[0];
  const patched = source.slice(0, call.start) + MARKER + "null" + source.slice(call.end);
  parse(patched, { ecmaVersion: "latest", sourceType: "module" });
  return { status: "patched", source: patched, count: 1 };
}

function locateTargets(platform) {
  const platforms = platform ? [platform] : PLATFORMS;
  const targets = [];
  for (const name of platforms) {
    const directory = path.join(SRC_DIR, name, "_asar", "webview", "assets");
    if (!fs.existsSync(directory)) continue;
    const candidates = fs.readdirSync(directory)
      .filter((file) => file.endsWith(".js"))
      .map((file) => path.join(directory, file))
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return LABEL_IDS.every((id) => source.includes(id));
      });
    const diagnostics = [];
    const matches = candidates.filter((file) => {
      const result = patchSource(fs.readFileSync(file, "utf8"));
      if (["patched", "already-patched"].includes(result.status)) return true;
      if (result.status !== "not-applicable") {
        diagnostics.push(`${path.basename(file)}: ${result.status}`);
      }
      return false;
    });
    if (matches.length !== 1) {
      const detail = diagnostics.length ? `；${diagnostics.join("；")}` : "";
      throw new Error(`[${name}] Pet 菜单资源数量异常（${matches.length}）${detail}`);
    }
    targets.push({ platform: name, path: matches[0] });
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => PLATFORMS.includes(arg));
  const check = args.includes("--check");
  const targets = locateTargets(platform);
  if (targets.length === 0) {
    if (platform) throw new Error(`[${platform}] 缺少 Pet 菜单目标资源，不能跳过必要补丁`);
    console.log("[skip] Pet 菜单资源不适用于当前平台");
    return;
  }

  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf8");
    const result = patchSource(source);
    const label = `[${target.platform}] ${relPath(target.path)}`;
    if (result.status === "patched") {
      if (check) console.log(`[?] ${label}: Pet 菜单入口可隐藏`);
      else {
        fs.writeFileSync(target.path, result.source, "utf8");
        console.log(`[ok] ${label}: 已隐藏 Pet 菜单入口，快捷键保持不变`);
      }
    } else if (result.status === "already-patched") {
      console.log(`[ok] ${label}: Pet 菜单入口已隐藏`);
    } else {
      throw new Error(`${label}: Pet 菜单结构未知（${result.status}）`);
    }
  }
}

if (require.main === module) main();
module.exports = { LABEL_IDS, MARKER, locateTargets, patchSource };
