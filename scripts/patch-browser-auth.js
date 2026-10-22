#!/usr/bin/env node
/**
 * 兼容 API-key 登录下的 Browser / Chrome 本地通道。
 *
 * 新版 browser-service 会在扩展命令前读取
 * `codex_browser_use_agent_request_header`。读取过程依赖 ChatGPT 身份接口，
 * 而 node_repl 对 `apikey` 认证会直接抛出：
 * `unsupported Codex auth method: apikey`。
 *
 * 这里保留 ChatGPT 登录下的原有身份与 Statsig 流程；仅当该流程失败时，
 * 将 request-header 能力降级为关闭，恢复旧版可继续建立本地浏览器通道的行为。
 * 26.1007 将读取改为调用通用 feature-gate 函数；仅包装 request-header
 * 回调，不改变其他 feature gate 的身份要求或超时逻辑。
 * 26.1013 改为从本地 requirements 读取托管请求头，不再经过 ChatGPT
 * 身份 gate；检测到这条原生链路时只验证并保持上游实现。
 * 不会把 API key 当作 ChatGPT token 发送到 chatgpt.com。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { key, nodes, walk } = require("./patch-ast-util");
const { SRC_DIR, relPath } = require("./patch-util");

const IDENTITY_ERROR =
  "Browser request-header policy requires caller identity.";
const FEATURE_GATE_IDENTITY_ERROR = "Browser feature gates require caller identity.";
const REQUEST_HEADER_GATE = "codex_browser_use_agent_request_header";
const MANAGED_REQUEST_HEADER_MARKERS = [
  "getExtensionRequestHeaders",
  "readRequirements",
  "requestHeadersVersion",
  "request_headers",
];

function memberName(node) {
  if (node?.type === "ChainExpression") node = node.expression;
  if (node?.type !== "MemberExpression") return null;
  return !node.computed && node.property.type === "Identifier"
    ? node.property.name : key(node.property);
}

function classBinding(node, parent) {
  if (node.type === "ClassDeclaration") return node.id?.name ?? null;
  return parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier"
    ? parent.id.name : null;
}

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function constructedClass(node) {
  node = unwrapChain(node);
  return node?.type === "NewExpression" && node.callee?.type === "Identifier"
    ? node.callee.name : null;
}

function thisProperty(node) {
  node = unwrapChain(node);
  if (node?.type !== "MemberExpression" || unwrapChain(node.object)?.type !== "ThisExpression") {
    return null;
  }
  return memberName(node);
}

function constructorPropertySources(classNode, property) {
  const constructors = classNode.body.body.filter(method =>
    method.type === "MethodDefinition" && method.kind === "constructor");
  if (constructors.length !== 1) return [];
  const constructor = constructors[0];
  return nodes(constructor.value.body, item => item.type === "AssignmentExpression" &&
    thisProperty(item.left) === property).map(assignment => {
    const directClass = constructedClass(assignment.right);
    if (directClass != null) return { directClass };
    if (assignment.right?.type !== "Identifier") return null;
    const parameterIndex = constructor.value.params.findIndex(parameter =>
      parameter.type === "Identifier" && parameter.name === assignment.right.name);
    return parameterIndex < 0 ? null : { parameterIndex };
  }).filter(Boolean);
}

function hasConstructedReceiver(ast, ownerClass, ownerNode, receiver, targetClass) {
  receiver = unwrapChain(receiver);
  if (receiver?.type === "Identifier") {
    return nodes(ast, node => node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" && node.id.name === receiver.name &&
      constructedClass(node.init) === targetClass).length === 1;
  }

  const property = thisProperty(receiver);
  if (property == null) return false;
  const sources = constructorPropertySources(ownerNode, property);
  if (sources.some(source => source.directClass === targetClass)) return true;
  return sources.some(source => source.parameterIndex != null &&
    nodes(ast, node => node.type === "NewExpression" &&
      node.callee?.type === "Identifier" && node.callee.name === ownerClass &&
      constructedClass(node.arguments[source.parameterIndex]) === targetClass).length >= 1);
}

function inspectNativeManagedRequestHeaders(source) {
  if (source.includes(REQUEST_HEADER_GATE)) return null;
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const definitions = [];
  walk(ast, (node, parent) => {
    if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") return;
    const owner = classBinding(node, parent);
    if (owner == null) return;
    const methods = node.body.body.filter(method => method.type === "MethodDefinition" &&
      key(method.key) === "getExtensionRequestHeaders").filter(method => {
    const body = method.value?.body;
    if (body == null) return false;
    const requirementCalls = nodes(body, node => node.type === "CallExpression" &&
      memberName(node.callee) === "readRequirements");
    const requestHeaders = nodes(body, node => node.type === "MemberExpression" &&
      memberName(node) === "requestHeaders");
    return requirementCalls.length === 1 && requestHeaders.length === 1 &&
      source.slice(method.start, method.end).includes("requirements") &&
      source.slice(method.start, method.end).includes("browserUse") &&
      source.slice(method.start, method.end).includes("extension");
    });
    for (const method of methods) definitions.push({ method, owner });
  });
  if (definitions.length !== 1) return null;

  const transports = [];
  walk(ast, (node, parent) => {
    if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") return;
    const binding = classBinding(node, parent);
    if (binding == null) return;
    const methods = node.body.body.filter(item => item.type === "MethodDefinition");
    const send = methods.filter(method => key(method.key) === "sendSessionRequest");
    const constructor = methods.filter(method => method.kind === "constructor");
    if (send.length !== 1 || constructor.length !== 1) return;
    const assignments = nodes(send[0].value.body, item => item.type === "AssignmentExpression" &&
      memberName(item.left) === "request_headers");
    // 新版同时把请求头写入本次请求和 lastSessionParams；两处写入都属于
    // 同一条传输链，不能再假设 request_headers 只赋值一次。
    if (assignments.length < 1) return;
    const callbackCalls = nodes(send[0].value.body, item => item.type === "CallExpression" &&
      item.callee?.type === "MemberExpression" && item.callee.object?.type === "ThisExpression");
    for (const call of callbackCalls) {
      const callback = memberName(call.callee);
      const headerBindings = new Set(nodes(send[0].value.body, item =>
        item.type === "VariableDeclarator" && item.id?.type === "Identifier" &&
        item.init != null && nodes(item.init, nested => nested === call).length === 1)
        .map(item => item.id.name));
      const flowsToRequestHeaders = assignments.some(assignment =>
        nodes(assignment.right, item => item.type === "Identifier" &&
          headerBindings.has(item.name)).length > 0);
      if (!flowsToRequestHeaders) continue;
      const wiring = nodes(constructor[0].value.body, item => item.type === "AssignmentExpression" &&
        item.left?.type === "MemberExpression" && item.left.object?.type === "ThisExpression" &&
        memberName(item.left) === callback && item.right?.type === "Identifier");
      if (wiring.length !== 1) continue;
      const parameterIndex = constructor[0].value.params.findIndex(parameter =>
        parameter.type === "Identifier" && parameter.name === wiring[0].right.name);
      if (parameterIndex < 0) continue;
      transports.push({ binding, callback, parameterIndex });
    }
  });
  if (transports.length !== 1) return null;

  const transport = transports[0];
  const consumers = [];
  walk(ast, (node, parent) => {
    if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") return;
    const owner = classBinding(node, parent);
    if (owner == null) return;
    const transportCalls = nodes(node, item => item.type === "NewExpression" &&
      item.callee?.type === "Identifier" && item.callee.name === transport.binding &&
      item.arguments[transport.parameterIndex] != null);
    for (const transportCall of transportCalls) {
      const callbacks = nodes(transportCall.arguments[transport.parameterIndex], item =>
        item.type === "CallExpression" &&
        memberName(item.callee) === "getExtensionRequestHeaders");
      if (callbacks.length !== 1) continue;
      const callee = unwrapChain(callbacks[0].callee);
      if (hasConstructedReceiver(ast, owner, node, callee.object, definitions[0].owner)) {
        consumers.push(transportCall);
      }
    }
  });

  // 兼容未包在宿主类中的简单初始化，但同样要求调用接收者确实由目标类创建。
  for (const transportCall of nodes(ast, (node, parent) => node.type === "NewExpression" &&
    node.callee?.type === "Identifier" && node.callee.name === transport.binding &&
    parent?.type !== "MethodDefinition" && node.arguments[transport.parameterIndex] != null)) {
    const callbacks = nodes(transportCall.arguments[transport.parameterIndex], item =>
      item.type === "CallExpression" && memberName(item.callee) === "getExtensionRequestHeaders");
    if (callbacks.length !== 1) continue;
    const callee = unwrapChain(callbacks[0].callee);
    if (hasConstructedReceiver(ast, null, { body: { body: [] } }, callee.object, definitions[0].owner)) {
      consumers.push(transportCall);
    }
  }
  if (consumers.length < 1) return null;
  return { consumers: consumers.length, transport: transport.binding };
}

function hasNativeManagedRequestHeaders(source) {
  try {
    return inspectNativeManagedRequestHeaders(source) != null;
  } catch {
    return false;
  }
}

function isFunction(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function returnsFalse(node) {
  return (
    node?.type === "ReturnStatement" &&
    node.argument?.type === "UnaryExpression" &&
    node.argument.operator === "!" &&
    node.argument.argument?.type === "Literal" &&
    node.argument.argument.value === 1
  );
}

function hasFallbackCatch(fn) {
  let found = false;
  walk(fn.body, (node) => {
    if (node.type !== "CatchClause") return;
    if (node.body?.body?.some(returnsFalse)) found = true;
  });
  return found;
}

function findRequestHeaderAuthPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (!isFunction(node) || !node.async) return;
    if (node.body?.type !== "BlockStatement") return;

    const fnSource = source.slice(node.start, node.end);
    if (!fnSource.includes(IDENTITY_ERROR)) return;
    if (!fnSource.includes(REQUEST_HEADER_GATE)) return;

    const gateReturn = node.body.body.find(
      (statement) =>
        statement.type === "ReturnStatement" &&
        statement.argument &&
        source
          .slice(statement.argument.start, statement.argument.end)
          .includes(REQUEST_HEADER_GATE),
    );
    if (!gateReturn) return;

    const gateExpression = source.slice(
      gateReturn.argument.start,
      gateReturn.argument.end,
    );
    patches.push({
      id: "browser_request_header_auth_fallback",
      start: node.body.start,
      end: node.body.end,
      replacement: `{try{return ${gateExpression}}catch{return!1}}`,
      original: fnSource,
    });
  });

  return patches;
}

function findInlineRequestHeaderAuthPatches(ast, source) {
  const gateReaders = new Set();
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" || !node.async || !node.id) return;
    if (source.slice(node.start, node.end).includes(FEATURE_GATE_IDENTITY_ERROR)) {
      gateReaders.add(node.id.name);
    }
  });

  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "ArrowFunctionExpression" || node.params.length !== 0) return;
    const call = node.body;
    if (call.type !== "CallExpression" || call.callee.type !== "Identifier") return;
    if (!gateReaders.has(call.callee.name)) return;
    if (call.arguments[0]?.type !== "Literal") return;
    if (call.arguments[0].value !== REQUEST_HEADER_GATE) return;

    const expression = source.slice(call.start, call.end);
    const arrow = source.slice(node.start, call.start);
    patches.push({
      id: "browser_request_header_auth_fallback",
      start: node.start,
      end: node.end,
      replacement: `${node.async ? "" : "async "}${arrow}{try{return await ${expression}}catch{return!1}}`,
      original: source.slice(node.start, node.end),
    });
  });
  return patches;
}

function hasPatchedFallback(ast, source) {
  let found = false;
  walk(ast, (node) => {
    if (found || !isFunction(node) || !node.async) return;
    const fnSource = source.slice(node.start, node.end);
    if (!fnSource.includes(REQUEST_HEADER_GATE)) return;
    if (hasFallbackCatch(node)) found = true;
  });
  return found;
}

function applyPatches(source, patches) {
  let next = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    next =
      next.slice(0, patch.start) +
      patch.replacement +
      next.slice(patch.end);
  }
  return next;
}

function patchSource(source) {
  if (!source.includes(REQUEST_HEADER_GATE)) {
    return { status: "not-applicable", source, count: 0 };
  }

  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const patches = [
    ...findRequestHeaderAuthPatches(ast, source),
    ...findInlineRequestHeaderAuthPatches(ast, source),
  ];
  if (patches.length === 0) {
    return {
      status: hasPatchedFallback(ast, source)
        ? "already-patched"
        : "unexpected-shape",
      source,
      count: 0,
    };
  }
  if (patches.length !== 1) {
    return { status: "unexpected-count", source, count: patches.length };
  }

  const next = applyPatches(source, patches);
  parse(next, { ecmaVersion: "latest", sourceType: "module" });
  return { status: "patched", source: next, count: patches.length };
}

function findBrowserServices(root) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name === "browser-service.mjs") {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((name) =>
        fs.existsSync(path.join(SRC_DIR, name)),
      );
  const targets = [];

  for (const name of platforms) {
    const roots = [
      path.join(SRC_DIR, name, "plugins"),
      path.join(SRC_DIR, name, "cua_node"),
    ];
    for (const root of roots) {
      for (const filePath of findBrowserServices(root)) {
        targets.push({ platform: name, path: filePath });
      }
    }
  }

  return targets.sort((left, right) => left.path.localeCompare(right.path));
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win"].includes(arg),
  );
  const targets = locateTargets(platform);

  if (targets.length === 0) {
    throw new Error("browser-service.mjs not found in external plugin resources");
  }

  let patched = 0;
  let alreadyPatched = 0;
  let native = 0;
  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf8");
    const label = `[${target.platform}] ${relPath(target.path)}`;
    if (hasNativeManagedRequestHeaders(source)) {
      console.log(
        `[ok] ${label}: upstream reads managed request headers without ChatGPT identity`,
      );
      native++;
      continue;
    }

    const result = patchSource(source);

    if (result.status === "patched") {
      if (check) {
        console.log(`[?] ${label}: API-key auth fallback patch required`);
      } else {
        fs.writeFileSync(target.path, result.source, "utf8");
        console.log(`[*] ${label}: API-key auth fallback patched`);
      }
      patched++;
      continue;
    }
    if (result.status === "already-patched") {
      console.log(`[ok] ${label}: already patched`);
      alreadyPatched++;
      continue;
    }

    throw new Error(`${label}: unsupported browser auth shape (${result.status})`);
  }

  console.log(
    `[ok] Browser auth targets: ${targets.length}, native: ${native}, ` +
    `patched: ${patched}, already: ${alreadyPatched}`,
  );
}

if (require.main === module) main();

module.exports = {
  IDENTITY_ERROR,
  MANAGED_REQUEST_HEADER_MARKERS,
  REQUEST_HEADER_GATE,
  findRequestHeaderAuthPatches,
  hasNativeManagedRequestHeaders,
  inspectNativeManagedRequestHeaders,
  locateTargets,
  patchSource,
};
