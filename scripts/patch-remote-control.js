#!/usr/bin/env node
/**
 * 将 Remote Control 的本地状态同步限制在真实 ChatGPT 认证下。
 *
 * 上游同步组件会在应用启动时无条件读取 local_remote_control_enabled；旧版
 * 本项目曾强开 Remote Control gate，因此可能留下 true。API-key Provider
 * 无法建立该连接，继续同步会反复触发 remoteControl/enable 和认证失败。
 *
 * 本补丁不再强开任何 Remote Control / Connections gate。ChatGPT 认证保持
 * 官方行为；其他认证方式清除遗留启用值，并向当前 app-server 发送一次
 * disable，确保切换认证方式时不会遗留已启动的 Remote Control。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { literal, walk } = require("./patch-ast-util");
const { relPath, SRC_DIR } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];
const STORAGE_KEY = "local_remote_control_enabled";
const MARKER = "/* CodexRebuildRemoteControlAuthIsolation */";

function propertyName(member) {
  if (member?.type !== "MemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  return literal(member.property);
}

function memberCallee(call) {
  let callee = call?.callee;
  if (callee?.type === "SequenceExpression") callee = callee.expressions.at(-1);
  return callee?.type === "MemberExpression" ? callee : null;
}

function functions(ast) {
  return ast.body.filter((node) => node.type === "FunctionDeclaration" && node.id?.name);
}

function descendants(root, predicate, { skipNestedFunctions = false } = {}) {
  const found = [];
  walk(root, (node) => {
    if (node === root) return;
    if (predicate(node)) found.push(node);
  }, { ownScope: skipNestedFunctions });
  return found;
}

function nextInitializer(allFunctions, target, source) {
  const following = allFunctions.filter((node) => node.start > target.end).sort((a, b) => a.start - b.start);
  const initializer = following[0];
  if (initializer == null || initializer.start - target.end > 200) {
    throw new Error(`${target.id.name} 的模块初始化器未找到`);
  }
  const arrows = descendants(initializer, (node) =>
    node.type === "ArrowFunctionExpression" && node.body.type === "BlockStatement");
  if (arrows.length !== 1 || !source.slice(initializer.start, initializer.end).includes("return")) {
    throw new Error(`${target.id.name} 的模块初始化器结构异常`);
  }
  return { function: initializer, body: arrows[0].body };
}

function findRemoteSync(allFunctions, source) {
  const candidates = allFunctions.filter((node) => {
    const text = source.slice(node.start, node.end);
    return text.includes(STORAGE_KEY) && text.includes("Failed to sync local remote control enablement");
  });
  if (candidates.length !== 1) {
    throw new Error(`Remote Control 本地状态同步组件数量异常（${candidates.length}）`);
  }
  const fn = candidates[0];
  const declarations = descendants(fn, (node) => node.type === "VariableDeclarator", {
    skipNestedFunctions: true,
  });
  const storage = declarations.filter((node) =>
    node.id?.type === "ArrayPattern" &&
    node.id.elements[0]?.type === "Identifier" &&
    node.init?.type === "CallExpression" &&
    node.init.callee.type === "Identifier" &&
    node.init.arguments.some((argument) => literal(argument) === STORAGE_KEY));
  if (storage.length !== 1) throw new Error("Remote Control 本地状态 Hook 结构异常");
  const storedValue = storage[0].id.elements[0].name;
  const storageHook = storage[0].init.callee.name;

  const catches = descendants(fn, (node) =>
    node.type === "CallExpression" &&
    propertyName(node.callee) === "catch" &&
    node.callee.object?.type === "CallExpression" &&
    node.callee.object.callee?.type === "Identifier" &&
    node.callee.object.arguments[1]?.type === "Identifier" &&
    node.callee.object.arguments[1].name === storedValue);
  if (catches.length !== 1 || catches[0].arguments.length !== 1) {
    throw new Error("Remote Control 同步及错误处理结构异常");
  }
  const syncCall = catches[0].callee.object;
  const syncFunction = syncCall.callee.name;
  const container = syncCall.arguments[0];
  if (container?.type !== "Identifier") throw new Error("Remote Control 容器参数结构异常");
  const containerDeclaration = declarations.find((node) => node.id?.name === container.name);
  if (containerDeclaration?.init == null) throw new Error("Remote Control 容器初始化结构异常");

  const effects = descendants(fn, (node) =>
    node.type === "CallExpression" && propertyName(memberCallee(node)) === "useEffect");
  const effectCallee = effects.length === 1 ? memberCallee(effects[0]) : null;
  if (effectCallee?.object.type !== "Identifier") {
    throw new Error("Remote Control useEffect 结构异常");
  }

  return {
    fn,
    container: container.name,
    containerExpression: source.slice(containerDeclaration.init.start, containerDeclaration.init.end),
    storedValue,
    storageHook,
    syncFunction,
    catchHandler: source.slice(catches[0].arguments[0].start, catches[0].arguments[0].end),
    react: effectCallee.object.name,
  };
}

function findHostAuth(allFunctions, source) {
  const candidates = [];
  for (const fn of allFunctions) {
    const text = source.slice(fn.start, fn.end);
    if (!["serviceTierAccess", "authMethod", "hostId", "isLoading", "apikey"]
      .every((value) => text.includes(value))) continue;
    const declarations = descendants(fn, (node) => node.type === "VariableDeclarator", {
      skipNestedFunctions: true,
    });
    for (const host of declarations) {
      if (host.id?.type !== "Identifier" || host.init?.type !== "CallExpression" ||
          host.init.callee.type !== "Identifier" || host.init.arguments.length !== 1 ||
          host.init.arguments[0].type !== "Identifier") continue;
      const selected = declarations.find((node) =>
        node.id?.type === "Identifier" && node.init?.type === "LogicalExpression" &&
        node.init.operator === "??" && node.init.right?.type === "Identifier" &&
        node.init.right.name === host.id.name);
      if (selected == null) continue;
      const auth = declarations.find((node) =>
        node.id?.type === "Identifier" && node.init?.type === "CallExpression" &&
        node.init.callee.type === "Identifier" && node.init.arguments.length === 1 &&
        node.init.arguments[0]?.type === "Identifier" &&
        node.init.arguments[0].name === selected.id.name &&
        text.includes(`${node.id.name}?.authMethod`));
      if (auth == null) continue;
      candidates.push({
        fn,
        hostHook: host.init.callee.name,
        defaultHost: host.init.arguments[0].name,
        authHook: auth.init.callee.name,
      });
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`当前 Host 认证 Hook 数量异常（${candidates.length}）`);
  }
  return candidates[0];
}

function count(source, value) {
  return source.split(value).length - 1;
}

function validatePatchedSource(source) {
  if (count(source, MARKER) !== 1) throw new Error(`${MARKER} 数量异常`);
  if (source.includes("codex-remote-gate:")) throw new Error("仍存在强制开启 Remote Control gate 的旧标记");
  if (!source.includes("__codexRemoteAuth?.authMethod!==`chatgpt`") ||
      !source.includes("__codexSetRemoteEnabled(!1)") ||
      !source.includes("__codexRemoteAuth?.isLoading")) {
    throw new Error("Remote Control 认证隔离或遗留状态清理不完整");
  }
  parse(source, { ecmaVersion: "latest", sourceType: "module" });
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
  if (!source.includes(STORAGE_KEY) ||
      !source.includes("Failed to sync local remote control enablement")) {
    return { status: "not-applicable", source };
  }
  if (source.includes("codex-remote-gate:")) {
    return {
      status: "unexpected-shape",
      source,
      reason: "输入 Bundle 已包含旧 Remote Control gate 补丁，必须从官方资源重新生成",
    };
  }

  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const allFunctions = functions(ast);
    const remote = findRemoteSync(allFunctions, source);
    const hostAuth = findHostAuth(allFunctions, source);
    const remoteInitializer = nextInitializer(allFunctions, remote.fn, source);
    const hostInitializer = nextInitializer(allFunctions, hostAuth.fn, source);
    const replacement = `function ${remote.fn.id.name}(){let ${remote.container}=${remote.containerExpression},[${remote.storedValue},__codexSetRemoteEnabled]=${remote.storageHook}(\`${STORAGE_KEY}\`),__codexRemoteHostId=${hostAuth.hostHook}(${hostAuth.defaultHost}),__codexRemoteAuth=${hostAuth.authHook}(__codexRemoteHostId);${remote.react}.useEffect(()=>{if(__codexRemoteAuth?.isLoading)return;if(__codexRemoteAuth?.authMethod!==\`chatgpt\`){${remote.storedValue}===!0&&__codexSetRemoteEnabled(!1),${remote.syncFunction}(${remote.container},!1).catch(${remote.catchHandler});return}${remote.storedValue}!=null&&${remote.syncFunction}(${remote.container},${remote.storedValue}).catch(${remote.catchHandler})},[__codexRemoteAuth?.authMethod,__codexRemoteAuth?.isLoading,${remote.storedValue},__codexSetRemoteEnabled,${remote.container}]);return null}${MARKER}`;
    const edits = [
      { start: remote.fn.start, end: remote.fn.end, replacement },
      {
        start: remoteInitializer.body.start + 1,
        end: remoteInitializer.body.start + 1,
        replacement: `${hostInitializer.function.id.name}(),`,
      },
    ].sort((a, b) => b.start - a.start);
    let next = source;
    for (const edit of edits) {
      next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
    }
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
      if (results.length !== 1) throw new Error(`Remote Control Bundle 数量异常（${results.length}）`);
      const target = results[0];
      if (target.result.status === "unexpected-shape") throw new Error(target.result.reason);
      console.log(`  [${directory.platform}] ${relPath(target.file.path)}`);
      if (target.result.status === "already-patched") {
        console.log("    [ok] Remote Control 已按认证方式隔离");
      } else if (check) {
        console.log("    [ok] Remote Control 认证隔离结构已核对；dry-run 未写文件");
      } else {
        fs.writeFileSync(target.file.path, target.result.source, "utf8");
        patched++;
        console.log("    [ok] API-key 已清理并禁用 Remote Control；ChatGPT 保持官方行为");
      }
    } catch (error) {
      failed++;
      console.error(`  [fail] ${directory.platform}: ${error.message}`);
    }
  }

  if (directories.length === 0) console.log("[skip] No generated platform assets found");
  if (failed > 0) process.exitCode = 1;
  else console.log(check ? "[check] Remote Control patch verified" : `[done] ${patched} file(s) patched`);
}

if (require.main === module) main();

module.exports = { MARKER, patchSource, validatePatchedSource };
