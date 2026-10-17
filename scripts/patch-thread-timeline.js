#!/usr/bin/env node
/**
 * 在本地 App Server 版本支持时启用官方 thread/timeline/list 路径。
 *
 * 上游同时使用本地版本兼容判断和远端 readThreadTimelineEnabled 灰度开关。
 * API-key / 自定义 Provider 没有该远端开关，因而继续走逐 turn 的
 * thread/items/list 旧路径。这里只移除远端灰度条件，保留 host 与 App
 * Server 版本判断；未知结构必须失败，不能把不兼容 CLI 强行切到 timeline。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");

const MARKER = "/* CodexRebuildThreadTimeline */";
const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

function propertyName(member) {
  if (member?.type !== "MemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  return member.property?.type === "Literal" ? member.property.value : null;
}

function isThisMember(node, name) {
  return node?.type === "MemberExpression" && node.object?.type === "ThisExpression" &&
    propertyName(node) === name;
}

function isCompatibilityCall(node) {
  if (node?.type !== "CallExpression" || node.arguments.length !== 2) return false;
  if (!isThisMember(node.arguments[0], "hostId")) return false;
  const version = node.arguments[1];
  return version?.type === "CallExpression" && version.arguments.length === 0 &&
    propertyName(version.callee) === "getAppServerVersion" &&
    isThisMember(version.callee.object, "requestClient");
}

function isTimelineGate(node) {
  if (node?.type !== "CallExpression" || node.arguments.length !== 0 ||
      propertyName(node.callee) !== "readThreadTimelineEnabled") return false;
  const history = node.callee.object;
  return propertyName(history) === "history" && isThisMember(history.object, "settings");
}

function methodName(node) {
  if (node?.type !== "MethodDefinition" || node.computed) return null;
  return node.key?.type === "Identifier" ? node.key.name : node.key?.value;
}

function findMethod(ast) {
  const methods = [];
  for (const statement of ast.body) walk(statement, (node) => {
    if (methodName(node) === "supportsThreadTimeline" && node.kind === "method" && !node.static) {
      methods.push(node);
    }
  });
  if (methods.length !== 1) {
    throw new Error(`supportsThreadTimeline 方法数量异常（${methods.length}）`);
  }
  return methods[0];
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["type", "start", "end"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else {
      walk(value, visit);
    }
  }
}

function methodReturn(method) {
  const body = method.value?.body?.body;
  if (!Array.isArray(body) || body.length !== 1 || body[0].type !== "ReturnStatement" ||
      body[0].argument == null) {
    throw new Error("supportsThreadTimeline 返回结构异常");
  }
  return body[0];
}

function count(source, value) {
  return source.split(value).length - 1;
}

function validatePatchedSource(source) {
  if (count(source, MARKER) !== 1) throw new Error(`${MARKER} 数量异常`);
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const method = findMethod(ast);
  const returned = methodReturn(method);
  if (!isCompatibilityCall(returned.argument)) {
    throw new Error("补丁后未保留 App Server 版本兼容判断");
  }
  if (!source.slice(method.start, method.end).includes(MARKER)) {
    throw new Error("timeline 标记不在 supportsThreadTimeline 方法内");
  }
}

function patchSource(source) {
  if (source.includes(MARKER)) {
    try {
      validatePatchedSource(source);
      return { status: "already-patched", source };
    } catch (error) {
      return { status: "unexpected-shape", source, reason: error.message };
    }
  }
  if (!source.includes("supportsThreadTimeline") ||
      !source.includes("readThreadTimelineEnabled") ||
      !source.includes("getAppServerVersion")) {
    return { status: "not-applicable", source };
  }

  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const method = findMethod(ast);
    const returned = methodReturn(method);
    const gate = returned.argument;
    if (gate.type !== "LogicalExpression" || gate.operator !== "&&" ||
        !isCompatibilityCall(gate.left) || !isTimelineGate(gate.right)) {
      throw new Error("supportsThreadTimeline 灰度门槛结构异常");
    }
    const compatibility = source.slice(gate.left.start, gate.left.end);
    const next = source.slice(0, gate.start) + compatibility + MARKER + source.slice(gate.end);
    validatePatchedSource(next);
    return { status: "patched", source: next };
  } catch (error) {
    return { status: "unexpected-shape", source, reason: error.message };
  }
}

function targetDirectories(platform) {
  const requested = platform ? [platform] : PLATFORMS;
  return requested.map((item) => ({
    platform: item,
    path: path.join(SRC_DIR, item, "_asar", "webview", "assets"),
  })).filter((item) => fs.existsSync(item.path));
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => PLATFORMS.includes(arg));
  const check = args.includes("--check");
  const directories = targetDirectories(platform);
  let failed = 0;
  let patched = 0;

  for (const directory of directories) {
    try {
      const results = fs.readdirSync(directory.path)
        .filter((name) => /^app-initial-.*\.js$/.test(name))
        .map((name) => ({ name, path: path.join(directory.path, name) }))
        .map((file) => ({ ...file, source: fs.readFileSync(file.path, "utf8") }))
        .map((file) => ({ file, result: patchSource(file.source) }))
        .filter((item) => item.result.status !== "not-applicable");
      if (results.length !== 1) throw new Error(`timeline Bundle 数量异常（${results.length}）`);
      const target = results[0];
      if (target.result.status === "unexpected-shape") throw new Error(target.result.reason);
      console.log(`  [${directory.platform}] ${relPath(target.file.path)}`);
      if (target.result.status === "already-patched") {
        console.log("    [ok] 官方 thread timeline 已按版本能力启用");
      } else if (check) {
        console.log("    [ok] timeline 版本门槛与远端灰度结构已核对；dry-run 未写文件");
      } else {
        fs.writeFileSync(target.file.path, target.result.source, "utf8");
        patched++;
        console.log("    [ok] 已移除远端灰度门槛并保留 App Server 版本兼容判断");
      }
    } catch (error) {
      console.error(`  [x] ${directory.platform}: ${error.message}`);
      failed++;
    }
  }
  if (!directories.length) {
    console.error("  [x] 缺少目标平台界面资源");
    failed++;
  }
  if (failed) process.exitCode = 1;
  else console.log(`  [ok] ${patched} platform bundle(s) patched`);
}

if (require.main === module) main();
module.exports = { MARKER, patchSource };
