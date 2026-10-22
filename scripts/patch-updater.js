#!/usr/bin/env node
/**
 * patch-updater.js — Disable Sparkle (macOS) and Windows auto-updater
 *
 * AST match: in the file containing shouldIncludeSparkle / shouldIncludeUpdater,
 * find these method definitions and replace their bodies to return false.
 *
 * Specifically targets:
 *   shouldIncludeSparkle(e,t,n){return ...}  → return !1
 *   shouldIncludeWindowsUpdater(e,t,n){return ...}  → return !1
 *   shouldIncludeUpdater(e,t,n){return ...}  → return !1
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const UPDATER_METHODS = new Set([
  "shouldIncludeSparkle",
  "shouldIncludeWindowsUpdater",
  "shouldIncludeWindowsMsixUpdater",
  "shouldIncludeUpdater",
]);

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child)
        if (item && typeof item === "object" && item.type) walk(item, visitor);
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match: Property with key being an updater method name and value being a FunctionExpression
    if (node.type !== "Property") return;
    const keyName = node.key?.name || node.key?.value;
    if (!UPDATER_METHODS.has(keyName)) return;

    const fn = node.value;
    if (fn?.type !== "FunctionExpression") return;
    const body = fn.body;
    if (!body || body.type !== "BlockStatement") return;
    if (body.body.length !== 1) return;
    const ret = body.body[0];
    if (ret.type !== "ReturnStatement" || !ret.argument) return;

    const retSrc = source.slice(ret.argument.start, ret.argument.end);
    if (retSrc === "!1") return;

    patches.push({
      id: keyName,
      start: ret.argument.start,
      end: ret.argument.end,
      replacement: "!1",
      original: retSrc.length > 50 ? retSrc.slice(0, 47) + "..." : retSrc,
    });
  });

  return patches;
}

// 独立后置检查：没有目标和不认识的函数体不能当成更新已关闭。
function auditUpdaterSource(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const methods = [];
  walk(ast, (node) => {
    if (!["Property", "MethodDefinition", "FunctionDeclaration"].includes(node.type)) return;
    const name = node.key?.name || node.key?.value || node.id?.name;
    if (!UPDATER_METHODS.has(name)) return;
    const body = node.type === "FunctionDeclaration" ? node.body : node.value?.body;
    const statement = body?.type === "BlockStatement" && body.body.length === 1 ? body.body[0] : null;
    const result = statement?.type === "ReturnStatement" ? statement.argument : null;
    const disabled = result?.type === "Literal" && result.value === false
      || result?.type === "UnaryExpression" && result.operator === "!"
        && result.argument?.type === "Literal" && result.argument.value === 1;
    methods.push({ name, disabled: Boolean(disabled) });
  });
  return methods;
}

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")),
      );

  const targets = [];
  for (const plat of platforms) {
    const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (!fs.existsSync(buildDir)) continue;
    for (const f of fs.readdirSync(buildDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(buildDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if ([...UPDATER_METHODS].some((name) => src.includes(name))) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const targets = locateTargets(platform);
  if (targets.length === 0) {
    console.log("  [!] No updater targets found; updater state needs review");
    return;
  }

  for (const bundle of targets) {
    console.log(`  [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      const methods = auditUpdaterSource(source);
      console.log(methods.length === 0
        ? "    [ok] Updater call sites only; this bundle defines no gates"
        : methods.every((method) => method.disabled)
          ? "    [ok] Updater methods are explicitly disabled"
          : "    [!] No supported updater method matched; updater state needs review");
      continue;
    }

    if (isCheck) {
      console.log(`    [?] Would disable ${patches.length} updater methods`);
      continue;
    }

    patches.sort((a, b) => b.start - a.start);
    let code = source;
    for (const p of patches) {
      console.log(`    * [${p.id}] ${p.original} -> !1`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`    [ok] ${patches.length} updater methods disabled`);
  }
}

if (require.main === module) main();

module.exports = { auditUpdaterSource };
