#!/usr/bin/env node
/**
 * 构建后补丁：强制启用界面语言开关。
 *
 * 26.1106 的 Rspack 前端把 provider 拆进异步 chunk。只扫描 assets 根目录
 * 会得到空目标，因此这里同时兼容旧根目录 bundle 和真实 module factory。
 * 已完成项保留 enable_i18n 标记，便于 --check 在 application 后继续识别。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");
const { frontendFiles, rspackModules } = require("./rspack-util");

const FIELD_NAME = "enable_i18n";
const MARKER = "/* Codex：启用界面语言 enable_i18n */";
const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function collectPatches(ast, source) {
  const patches = [];
  const seen = new Set();
  walk(ast, (node) => {
    let callNode;
    let replaceNode;
    if (node.type === "ChainExpression" && node.expression?.type === "CallExpression") {
      callNode = node.expression;
      replaceNode = node;
    } else if (node.type === "CallExpression") {
      callNode = node;
      replaceNode = node;
    } else {
      return;
    }

    const callee = callNode.callee;
    if (callee?.type !== "MemberExpression") return;
    const property = callee.property;
    const propertyName = property?.type === "Identifier"
      ? property.name
      : property?.type === "Literal" ? property.value : null;
    if (propertyName !== "get" || callNode.arguments.length < 2) return;

    const field = callNode.arguments[0];
    const fieldName = field.type === "Literal"
      ? field.value
      : field.type === "TemplateLiteral"
        && field.expressions.length === 0
        && field.quasis.length === 1
        ? field.quasis[0].value.cooked
        : null;
    if (fieldName !== FIELD_NAME || seen.has(replaceNode.start)) return;
    seen.add(replaceNode.start);
    patches.push({
      id: "i18n_enable_gate",
      start: replaceNode.start,
      end: replaceNode.end,
      original: source.slice(replaceNode.start, replaceNode.end),
      replacement: `${MARKER}!0`,
    });
  });
  return patches;
}

function patchSource(source) {
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "parse-error", source, patches: [], error };
  }
  const patches = collectPatches(ast, source);
  if (patches.length === 0) {
    return {
      status: source.includes(MARKER) ? "already-patched" : "unrecognized-gate",
      source,
      patches: [],
    };
  }

  let next = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    next = next.slice(0, patch.start) + patch.replacement + next.slice(patch.end);
  }
  try {
    parse(next, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "invalid-output", source, patches, error };
  }
  return { status: "patched", source: next, patches };
}

function getPlatforms(platform, sourceDir) {
  if (platform) return [platform];
  return PLATFORMS.filter((name) =>
    fs.existsSync(path.join(sourceDir, name, "_asar", "webview", "assets")),
  );
}

function locateTargets(platform, sourceDir = SRC_DIR) {
  const targets = [];
  for (const currentPlatform of getPlatforms(platform, sourceDir)) {
    const assetsDir = path.join(
      sourceDir,
      currentPlatform,
      "_asar",
      "webview",
      "assets",
    );
    if (!fs.existsSync(assetsDir)) continue;

    for (const file of frontendFiles(assetsDir)) {
      const source = fs.readFileSync(file, "utf8");
      if (source.includes("export const __webpack_modules__=")
        && !source.slice(0, 220).includes("exports=JSON.parse(")
        && source.includes(FIELD_NAME)) {
        let modules;
        try {
          modules = rspackModules(source);
        } catch (error) {
          targets.push({
            platform: currentPlatform,
            path: file,
            source,
            kind: "rspack",
            parseError: error,
          });
          continue;
        }
        for (const module of modules) {
          if (!module.source.includes(FIELD_NAME)) continue;
          targets.push({
            platform: currentPlatform,
            path: file,
            source: module.source,
            chunkSource: source,
            kind: "rspack",
            moduleId: module.id,
            start: module.start,
            end: module.end,
          });
        }
      } else if (source.includes(`get("${FIELD_NAME}"`)
        || source.includes(`get('${FIELD_NAME}'`)
        || source.includes(`get(\`${FIELD_NAME}\``)) {
        targets.push({
          platform: currentPlatform,
          path: file,
          source,
          kind: "legacy",
          start: 0,
          end: source.length,
        });
      }
    }
  }
  return targets;
}

function writeRspackResults(results, check) {
  const byFile = new Map();
  for (const result of results) {
    if (result.target.kind !== "rspack") continue;
    const group = byFile.get(result.target.path) || {
      target: result.target,
      replacements: [],
    };
    group.replacements.push({
      start: result.target.start,
      end: result.target.end,
      replacement: result.result.source,
    });
    byFile.set(result.target.path, group);
  }

  for (const group of byFile.values()) {
    let next = group.target.chunkSource;
    for (const replacement of group.replacements
      .sort((left, right) => right.start - left.start)) {
      next = next.slice(0, replacement.start)
        + replacement.replacement
        + next.slice(replacement.end);
    }
    parse(next, { ecmaVersion: "latest", sourceType: "module" });
    if (!check) fs.writeFileSync(group.target.path, next, "utf8");
  }
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => PLATFORMS.includes(arg));
  let targets;
  try {
    targets = locateTargets(platform);
  } catch (error) {
    console.log(`  [x] i18n: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (targets.length === 0) {
    console.log("  [x] No enable_i18n provider gate found in legacy or Rspack frontend");
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  let patchable = 0;
  const completed = [];
  for (const target of targets) {
    const label = `${relPath(target.path)}${target.moduleId ? `#${target.moduleId}` : ""}`;
    if (target.parseError) {
      console.log(`  [x] ${label}: ${target.parseError.message}`);
      failed++;
      continue;
    }
    const result = patchSource(target.source);
    if (result.status === "parse-error" || result.status === "invalid-output"
      || result.status === "unrecognized-gate") {
      console.log(`  [x] ${label}: ${result.status}`);
      failed++;
      continue;
    }
    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: enable_i18n already forced`);
      continue;
    }
    patchable += result.patches.length;
    console.log(
      `  [${isCheck ? "?" : "*"}] ${label}: ${result.patches.length} provider gate(s)`,
    );
    for (const patch of result.patches) {
      console.log(`      ${patch.original.slice(0, 100)} -> ${MARKER}!0`);
    }
    completed.push({ target, result });
  }

  try {
    writeRspackResults(completed, isCheck);
    for (const { target, result } of completed) {
      if (target.kind === "legacy" && !isCheck) {
        fs.writeFileSync(target.path, result.source, "utf8");
      }
    }
  } catch (error) {
    console.log(`  [x] i18n output: ${error.message}`);
    failed++;
  }

  if (patchable > 0) {
    console.log(
      `  [done] ${isCheck ? "would patch" : "patched"} ${patchable} i18n provider gate(s)`,
    );
  }
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { FIELD_NAME, MARKER, collectPatches, patchSource, locateTargets };
