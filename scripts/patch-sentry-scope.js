#!/usr/bin/env node
/**
 * patch-sentry-scope.js — 限制 Sentry breadcrumbs 体积，防 scope_v3.json 膨胀
 *
 * 背景：实测发现 %APPDATA%/Codex/web/Codex/sentry/scope_v3.json 在长会话中
 * 膨胀到 40MB。原因是 app_state_snapshot 等 breadcrumb 的 data 字段随会话
 * 增长（单条可达数百 KB），而 @sentry/electron 的 SentryMinidump 集成会在
 * 每次 breadcrumb 更新时把整个 scope 同步序列化落盘。40MB JSON 的反复
 * stringify + 写盘发生在主进程，带来明显的内存波动与 CPU 开销，加剧了
 * 主进程的内存压力（WER 已记录到 RADAR_PRE_LEAK_64）。
 *
 * 修复：向两处 Sentry.init(...) 注入：
 *   1. maxBreadcrumbs: 20        —— scope 内最多保留 20 条（默认 100）
 *   2. beforeBreadcrumb: <fn>    —— 单条 data 序列化超过 4KB 时替换为占位符
 *
 * 注入点特征（worker.js 与主进程 Sentry chunk 各一处）：
 *   dsn:XX,environment:...
 * 替换为：
 *   dsn:XX,maxBreadcrumbs:20,beforeBreadcrumb:<fn>,environment:...
 *
 * 写入前用 acorn 对整份文件做语法校验，解析失败则中止不写。
 *
 * Usage:
 *   node scripts/patch-sentry-scope.js [platform]   # mac-arm64 | mac-x64 | win | 省略=全部
 *   node scripts/patch-sentry-scope.js --check      # 试运行，只报告
 */
const fs = require("fs");
const acorn = require("acorn");
const { listBuildBundles, relPath } = require("./patch-util");

const MARKER = "__codex_bc_truncated";
const NATIVE_MARKER = "codex_truncated_breadcrumb_data";

// 内联注入的 beforeBreadcrumb：data 序列化超 4KB 就替换为占位符。
// 任何异常（如循环引用）都吞掉并原样返回，绝不影响上报流程。
const TRIM_FN =
  "e=>{try{if(e&&e.data){var t=JSON.stringify(e.data);" +
  "t.length>4096&&(e.data={" +
  MARKER +
  ":!0,bytes:t.length})}}catch(n){}return e}";

const OPTS = "maxBreadcrumbs:20,beforeBreadcrumb:" + TRIM_FN + ",";

// dsn:<标识符或成员访问>,environment: —— 两处 init 共同的锚点
const INIT_RE = /dsn:([\w$]+(?:\.[\w$]+)*),environment:/g;

const TARGETS = [
  /^worker\.js$/,
  /^(?:workspace-root-drop-handler|window-all-closed)-.*\.js$/,
];

function hasNativeScopeProtection(code) {
  return (
    code.includes(NATIVE_MARKER) &&
    code.includes("beforeBreadcrumb:") &&
    code.includes("scope_v3.json") &&
    code.includes("2097152")
  );
}

// Webpack 将 sanitizer、Sentry.init 分在不同模块中；验证引用关系而非拼接字符串。
function inspectNativeScopeProtection(sources) {
  const modules = new Map();
  function walk(node, visitor) {
    if (!node || typeof node !== "object") return;
    visitor(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => walk(child, visitor));
      else if (value?.type) walk(value, visitor);
    }
  }
  for (const source of sources) {
    if (!source.includes("scope_v3.json") && !source.includes(NATIVE_MARKER)) continue;
    const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
    walk(ast, (node) => {
      if (node.type === "Property" && typeof node.key?.value === "number" && node.value?.type === "FunctionExpression") {
        if (modules.has(node.key.value)) throw new Error(`Sentry: duplicate Webpack module ${node.key.value}`);
        modules.set(node.key.value, { node: node.value, source });
      }
    });
  }
  const proofs = [];
  for (const [id, module] of modules) {
    const text = module.source.slice(module.node.start, module.node.end);
    if (!text.includes("scope_v3.json")) continue;
    // 同一初始化模块必须实际检查 scope 文件尺寸并删除过大文件。
    if (!/statSync\)\([^)]*\)\.size>2097152/.test(text) || !text.includes("unlinkSync")) continue;
    const imports = new Map();
    const requireName = module.node.params[2]?.name;
    walk(module.node, (node) => {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init?.type === "CallExpression" &&
          node.init.callee.name === requireName && typeof node.init.arguments[0]?.value === "number") imports.set(node.id.name, node.init.arguments[0].value);
    });
    walk(module.node, (node) => {
      if (node.type !== "ObjectExpression" || !node.properties.some((p) => p.key?.name === "dsn")) return;
      const before = node.properties.find((p) => p.key?.name === "beforeBreadcrumb")?.value;
      if (before?.type !== "MemberExpression") return;
      const target = modules.get(imports.get(before.object.name));
      if (!target) return;
      let sanitizerName;
      walk(target.node, (property) => {
        if (property.type === "Property" && property.key?.name === before.property.name && property.value?.type === "ArrowFunctionExpression" && property.value.body.type === "Identifier") sanitizerName = property.value.body.name;
      });
      if (!sanitizerName) return;
      let sanitizer;
      walk(target.node, (fn) => { if (fn.type === "FunctionDeclaration" && fn.id.name === sanitizerName) sanitizer = fn; });
      if (!sanitizer) return;
      const body = target.source.slice(sanitizer.start, sanitizer.end);
      const functions = new Map();
      walk(target.node, (fn) => { if (fn.type === "FunctionDeclaration") functions.set(fn.id.name, fn); });
      const reachable = new Set();
      function visit(name) {
        if (reachable.has(name) || !functions.has(name)) return;
        reachable.add(name);
        walk(functions.get(name), (call) => { if (call.type === "CallExpression" && call.callee.type === "Identifier") visit(call.callee.name); });
      }
      visit(sanitizerName);
      const reachableText = [...reachable].map((name) => { const fn = functions.get(name); return target.source.slice(fn.start, fn.end); }).join("\n");
      if (body.includes(NATIVE_MARKER) && /\.data|\{data:/.test(body) && reachableText.includes("JSON.stringify") && reachableText.includes("new TextEncoder().encode") && reachableText.includes("byteLength<=2048")) proofs.push({ moduleId: id, sanitizerModuleId: imports.get(before.object.name), sanitizerName });
    });
  }
  return proofs;
}

function patchOne(bundlePath, isCheck) {
  const code = fs.readFileSync(bundlePath, "utf-8");

  if (code.includes(MARKER)) {
    console.log(`  [ok] ${relPath(bundlePath)}: already patched`);
    return false;
  }

  let count = 0;
  const next = code.replace(INIT_RE, (_m, dsnExpr) => {
    count++;
    return `dsn:${dsnExpr},${OPTS}environment:`;
  });

  if (count !== 1) {
    throw new Error(`${relPath(bundlePath)}: expected exactly one Sentry init anchor, found ${count}`);
  }

  try {
    acorn.parse(next, { ecmaVersion: 2022, sourceType: "module" });
  } catch (e) {
    try {
      acorn.parse(next, { ecmaVersion: 2022, sourceType: "script" });
    } catch (e2) {
      console.log(
        `  [x] ${relPath(bundlePath)}: post-inject parse failed, aborting (${e2.message})`,
      );
      throw new Error(`Sentry post-inject parse failed: ${e2.message}`);
    }
  }

  if (isCheck) {
    console.log(
      `  [?] ${relPath(bundlePath)}: would patch ${count} Sentry init site(s)`,
    );
    return true;
  }

  fs.writeFileSync(bundlePath, next);
  console.log(
    `  [ok] ${relPath(bundlePath)}: patched ${count} Sentry init site(s) (maxBreadcrumbs=20, data>4KB truncated)`,
  );
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const bundles = listBuildBundles(platform);
  if (bundles.length === 0) throw new Error("Sentry: no build bundles found");
  for (const current of new Set(bundles.map((entry) => entry.platform))) {
    const entries = bundles.filter((entry) => entry.platform === current);
    const sources = entries.map((entry) => fs.readFileSync(entry.path, "utf8"));
    const proofs = inspectNativeScopeProtection(sources);
    if (proofs.length === 1) {
      console.log(`  [ok] ${current}: upstream scope protection verified: ${JSON.stringify(proofs[0])}`);
      continue;
    }
    if (proofs.length > 1) throw new Error("Sentry: ambiguous upstream scope protection");
    const native = entries.filter((_entry, index) => hasNativeScopeProtection(sources[index]));
    if (native.length === 1) {
      console.log(`  [ok] ${current}: upstream truncates breadcrumb data and bounds scope_v3.json`);
      continue;
    }
    // 保留旧真实布局的 worker 与主初始化两处契约，不把缺失当跳过。
    for (const pattern of TARGETS) {
      const matches = entries.filter((entry) => pattern.test(require("path").basename(entry.path)));
      if (matches.length !== 1) throw new Error(`Sentry: ${current}: expected one legacy target for ${pattern}, found ${matches.length}`);
      patchOne(matches[0].path, isCheck);
    }
  }
}

if (require.main === module) main();

module.exports = { INIT_RE, MARKER, NATIVE_MARKER, TARGETS, TRIM_FN, hasNativeScopeProtection, inspectNativeScopeProtection, patchOne };
