#!/usr/bin/env node
/**
 * patch-diff-limits.js — 收紧 git diff 单命令输出上限 32MB -> 8MB（治本缓解）
 *
 * 背景：2026-07-04 22:22 崩溃取证实锤 worker.js 在执行 diff 类任务时
 * V8 堆暴涨到 2.8GB（large_object_space 破 1GB）。代码审查发现：
 *   - git 执行器 $ 支持 maxOutputBytes，超限即 kill 并报 outputLimitExceeded，
 *     上游统一映射为 diff-too-large 错误（业务已有该错误的处理与 UI 文案）；
 *   - diff 封装 b2 的兜底上限 A1=32MB，且最多 8 路并发（F1=8）拉不同文件
 *     的 diff，每路结果同时持有 Uint8Array buffer + 解码后 string 双副本，
 *     再叠加 queryClient 的短期缓存 —— 32MB 上限下瞬时驻留可达数百 MB，
 *     GC 追不上时滚雪球，最终 native OOM 整崩。
 *
 * 修复：A1 32MB -> 8MB。正常代码 review 不会看 8MB 以上的单文件 diff，
 * 超限文件会走 diff-too-large 分支被跳过/提示，不再全量入内存。
 * 不改 I1 的 64MB 总量上限（j1）、cat-file 的 5MB（k1）、turn-diff 的 1MB。
 *
 * 锚点：同一变量声明中连续出现 5MB、32MB、64MB 三个限制值，不依赖压缩变量名。
 * 幂等：中间值已是 8MB 则跳过。写入前 acorn 校验。
 *
 * Usage:
 *   node scripts/patch-diff-limits.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-diff-limits.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const FIVE_MB = 5 * 1024 * 1024;
const OLD_DIFF_LIMIT = 32 * 1024 * 1024;
const NEW_DIFF_LIMIT = 8 * 1024 * 1024;
const TOTAL_DIFF_LIMIT = 64 * 1024 * 1024;
const NEW_DIFF_LIMIT_SOURCE = "8*1024*1024";

function parseCode(code) {
  try {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  }
}

function staticNumber(node) {
  if (node?.type === "Literal" && typeof node.value === "number") return node.value;
  if (node?.type !== "BinaryExpression") return null;
  const left = staticNumber(node.left);
  const right = staticNumber(node.right);
  if (left == null || right == null) return null;
  if (node.operator === "*") return left * right;
  if (node.operator === "+") return left + right;
  return null;
}

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) value.forEach((item) => walk(item, visitor));
    else if (value?.type) walk(value, visitor);
  }
}

function findLimitSequences(ast) {
  const matches = [];
  walk(ast, (node) => {
    if (node.type !== "VariableDeclaration") return;
    for (let index = 0; index <= node.declarations.length - 3; index++) {
      const group = node.declarations.slice(index, index + 3);
      const values = group.map((declaration) => staticNumber(declaration.init));
      if (
        values[0] === FIVE_MB &&
        [OLD_DIFF_LIMIT, NEW_DIFF_LIMIT].includes(values[1]) &&
        values[2] === TOTAL_DIFF_LIMIT
      ) {
        matches.push({ declaration: group[1], value: values[1] });
      }
    }
  });
  return matches;
}

// Newer bundles inline the same limit in the default and Math.min branches.
function findInlineLimits(ast) {
  const matches = [];
  const diffArrays = new Set();
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" &&
        node.init?.type === "ArrayExpression" &&
        node.init.elements.some(item => item?.type === "Literal" && item.value === "diff") &&
        node.init.elements.some(item => item?.type === "Literal" && item.value === "--no-ext-diff")) {
      diffArrays.add(node.id.name);
    }
  });
  walk(ast, (fn) => {
    if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(fn.type)) return;
    const declarations = [];
    function walkLocal(node, visitor) {
      if (!node || typeof node !== "object") return;
      if (node !== fn.body && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) return;
      visitor(node);
      for (const [key, value] of Object.entries(node)) {
        if (["type", "start", "end"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(item => walkLocal(item, visitor));
        else if (value?.type) walkLocal(value, visitor);
      }
    }
    walkLocal(fn.body, (node) => { if (node.type === "VariableDeclarator") declarations.push(node); });
    for (const declaration of declarations) {
      const expr = declaration.init;
      if (declaration.id.type !== "Identifier" || expr?.type !== "ConditionalExpression") continue;
      const test = expr.test;
      if (test?.type !== "BinaryExpression" || !["==", "==="].includes(test.operator)) continue;
      const input = test.left.type === "Identifier" && test.right.type === "Literal" && test.right.value === null
        ? test.left.name : test.right.type === "Identifier" && test.left.type === "Literal" && test.left.value === null
          ? test.right.name : null;
      const min = expr.alternate;
      if (input == null || min?.type !== "CallExpression" || min.callee?.type !== "MemberExpression" ||
          min.callee.object?.name !== "Math" || min.callee.property?.name !== "min" || min.arguments.length !== 2 ||
          min.arguments[0]?.name !== input) continue;
      const values = [staticNumber(expr.consequent), staticNumber(min.arguments[1])];
      if (!values.every(value => [OLD_DIFF_LIMIT, NEW_DIFF_LIMIT].includes(value))) continue;
      const inputBound = declarations.some(item => item.id?.type === "ObjectPattern" &&
        item.id.properties.some(property => property.type === "Property" &&
          (property.key.name ?? property.key.value) === "maxOutputBytes" && property.value?.name === input));
      if (!inputBound) continue;
      let forwardsLimit = false;
      walkLocal(fn.body, (node) => {
        if (node.type !== "CallExpression") return;
        const hasDiffArgs = node.arguments.some(argument => argument.type === "ArrayExpression" &&
          argument.elements.some(item => item?.type === "SpreadElement" &&
            item.argument?.type === "Identifier" && diffArrays.has(item.argument.name)));
        const hasLimit = node.arguments.some(argument => argument.type === "ObjectExpression" &&
          argument.properties.some(property => property.type === "Property" &&
            (property.key.name ?? property.key.value) === "maxOutputBytes" &&
            property.value?.type === "Identifier" && property.value.name === declaration.id.name));
        if (hasDiffArgs && hasLimit) forwardsLimit = true;
      });
      if (forwardsLimit) matches.push({ nodes: [expr.consequent, min.arguments[1]], values });
    }
  });
  return matches;
}

function patchSource(source) {
  let ast;
  try {
    ast = parseCode(source);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }

  const sequences = findLimitSequences(ast);
  const inline = findInlineLimits(ast);
  const count = sequences.length + inline.length;
  if (count !== 1) {
    return { status: "unexpected-anchor-count", count, source };
  }
  const targets = sequences.length
    ? [sequences[0].declaration.init]
    : inline[0].nodes;
  const values = sequences.length ? [sequences[0].value] : inline[0].values;
  if (values.every(value => value === NEW_DIFF_LIMIT)) {
    return { status: "already-patched", source };
  }
  if (!values.every(value => value === OLD_DIFF_LIMIT)) {
    return { status: "unexpected-anchor-count", count: 0, source };
  }
  let next = source;
  for (const target of targets.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, target.start) + NEW_DIFF_LIMIT_SOURCE + next.slice(target.end);
  }
  try {
    parseCode(next);
  } catch (error) {
    return { status: "parse-failed", error, source };
  }
  return { status: "patched", source: next };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const bundles = locateBundles({
    dir: "build",
    pattern: /^worker\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.log("  [skip] worker.js not found");
    return;
  }

  let patched = 0;
  let failed = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    const result = patchSource(code);
    const label = relPath(bundle.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }
    if (result.status === "unexpected-anchor-count") {
      console.log(`  [x] ${label}: expected exactly 1 diff limit sequence, found ${result.count}`);
      failed++;
      continue;
    }
    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: parse validation failed (${result.error.message})`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(`  [?] ${label}: would tighten diff output limit 32MB -> 8MB`);
    } else {
      fs.writeFileSync(bundle.path, result.source);
      console.log(`  [ok] ${label}: diff output limit tightened 32MB -> 8MB`);
    }
    patched++;
  }

  console.log(`  [done] ${isCheck ? "would patch" : "patched"} ${patched} file(s)`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { NEW_DIFF_LIMIT_SOURCE, findLimitSequences, patchSource };
