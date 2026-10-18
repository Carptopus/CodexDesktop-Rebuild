#!/usr/bin/env node
/**
 * patch-archive-delete.js — 补齐跨 Provider 归档列表与旧版删除能力。
 *
 * Three-layer patch:
 *   0. archived thread queries: use [] to explicitly query all model providers
 *   1. app-main chunk: inject "delete-conversation" route into the message router
 *   2. data-controls chunk: inject a red "Delete" button next to "Unarchive"
 *
 * The delete button calls the app-server "thread/delete" protocol via the
 * message router, which permanently removes the thread (DB + rollout file).
 *
 * 回退注入要求最终打包的 CLI 支持 thread/delete。
 * 26.803 起上游已提供单条、按项目及全部删除；检测到完整原生链路时不再注入。
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const { key, literal, nodes } = require("./patch-ast-util");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

function walkArchive(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walkArchive(item, visitor);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walkArchive(child, visitor);
    }
  }
}

function archiveLiteral(node) {
  if (node?.type === "Literal") return node.value;
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

function archiveObjectProperty(node, name) {
  if (node?.type !== "ObjectExpression") return null;
  return node.properties.find((property) => {
    if (property.type !== "Property" || property.kind !== "init") return false;
    const key = property.computed
      ? archiveLiteral(property.key)
      : property.key.type === "Identifier"
        ? property.key.name
        : archiveLiteral(property.key);
    return key === name;
  }) ?? null;
}

function archiveStaticBoolean(node) {
  if (node?.type === "Literal" && typeof node.value === "boolean") {
    return node.value;
  }
  if (
    node?.type === "UnaryExpression" &&
    node.operator === "!" &&
    node.argument?.type === "Literal" &&
    (node.argument.value === 0 || node.argument.value === 1)
  ) {
    return node.argument.value === 0;
  }
  return null;
}

function analyzeArchivedListProviders(source) {
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const edits = [];
  let alreadyAllProviders = 0;

  walkArchive(ast, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") {
      return;
    }
    const method = node.callee.computed
      ? archiveLiteral(node.callee.property)
      : node.callee.property.name;
    const options = method === "listAllThreads"
      ? node.arguments[0]
      : method === "sendRequest" && archiveLiteral(node.arguments[0]) === "thread/list"
        ? node.arguments[1]
        : null;
    if (archiveStaticBoolean(archiveObjectProperty(options, "archived")?.value) !== true) {
      return;
    }

    const providers = archiveObjectProperty(options, "modelProviders")?.value;
    if (providers?.type === "Literal" && providers.value === null) {
      edits.push(providers);
    } else if (providers?.type === "ArrayExpression" && providers.elements.length === 0) {
      alreadyAllProviders++;
    }
  });

  let code = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    code = code.slice(0, edit.start) + "[]" + code.slice(edit.end);
  }
  return { code, edits: edits.length, alreadyAllProviders };
}

function patchArchivedListProviders(source) {
  return analyzeArchivedListProviders(source).code;
}

function locateArchivedProviderBundles(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((name) =>
        fs.existsSync(path.join(SRC_DIR, name)),
      );
  const roots = platforms.length > 0
    ? platforms.map((name) => ({
        platform: name,
        dir: path.join(SRC_DIR, name, "_asar", "webview", "assets"),
      }))
    : [{ platform: "legacy", dir: path.join(SRC_DIR, "webview", "assets") }];
  const bundles = [];

  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    for (const name of fs.readdirSync(root.dir)) {
      if (!name.endsWith(".js")) continue;
      const filePath = path.join(root.dir, name);
      const source = fs.readFileSync(filePath, "utf-8");
      if (
        source.includes("modelProviders") &&
        (source.includes("listAllThreads") || source.includes("thread/list"))
      ) {
        bundles.push({ platform: root.platform, path: filePath });
      }
    }
  }
  return bundles.sort((left, right) => left.path.localeCompare(right.path));
}

function patchArchivedProviderQueries(bundles, isCheck) {
  let patched = 0;
  let already = 0;
  for (const bundle of bundles) {
    const source = fs.readFileSync(bundle.path, "utf-8");
    const result = analyzeArchivedListProviders(source);
    if (result.edits > 0) {
      console.log(
        `  [${isCheck ? "?" : "ok"}] ${relPath(bundle.path)}: ` +
        `${isCheck ? "would query" : "queries"} all providers for ` +
        `${result.edits} archived list call(s)`,
      );
      if (!isCheck) fs.writeFileSync(bundle.path, result.code, "utf-8");
      patched += result.edits;
    }
    if (result.alreadyAllProviders > 0) {
      console.log(
        `  [ok] ${relPath(bundle.path)}: ${result.alreadyAllProviders} archived list ` +
        "call(s) already query all providers",
      );
      already += result.alreadyAllProviders;
    }
  }
  if (patched === 0 && already === 0) {
    throw new Error("archived list provider query target not found");
  }
  return { patched, already };
}

function memberName(node) {
  if (node?.type === "ChainExpression") node = node.expression;
  if (node?.type !== "MemberExpression") return null;
  return !node.computed && node.property.type === "Identifier"
    ? node.property.name : key(node.property);
}

function bindingNames(root, value) {
  return nodes(root, (node) =>
    (node.type === "VariableDeclarator" && node.init === value && node.id?.type === "Identifier") ||
    (node.type === "AssignmentExpression" && node.right === value && node.left?.type === "Identifier"))
    .map(owner => owner.type === "VariableDeclarator" ? owner.id.name : owner.left.name);
}

function objectProperty(node, name) {
  return node?.type === "ObjectExpression"
    ? node.properties.find(property => property.type === "Property" && key(property.key) === name) ?? null
    : null;
}

function receiverSource(source, call) {
  const callee = call.callee?.type === "ChainExpression" ? call.callee.expression : call.callee;
  return callee?.type === "MemberExpression"
    ? source.slice(callee.object.start, callee.object.end)
    : null;
}

function inspectMutationChain(ast, source) {
  return nodes(ast, node => node.type === "FunctionDeclaration").filter(fn => {
    const deleteCallbacks = nodes(fn, (node, parent) => {
      if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") return false;
      if (!((parent?.type === "AssignmentExpression" && parent.left?.type === "Identifier") ||
          (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier"))) return false;
      const calls = nodes(node, item => item.type === "CallExpression" &&
        ["deleteArchivedConversation", "deleteAllArchivedConversations"].includes(memberName(item.callee)));
      const receivers = new Map();
      for (const call of calls) {
        const receiver = receiverSource(source, call);
        if (receiver == null) continue;
        if (!receivers.has(receiver)) receivers.set(receiver, new Set());
        receivers.get(receiver).add(memberName(call.callee));
      }
      return [...receivers.values()].some(methods => methods.has("deleteArchivedConversation") &&
        methods.has("deleteAllArchivedConversations"));
    });
    if (deleteCallbacks.length !== 1) return false;
    const callbackBindings = new Set(bindingNames(fn, deleteCallbacks[0]));
    if (callbackBindings.size !== 1) return false;

    const mutationConfigs = nodes(fn, node => node.type === "ObjectExpression" &&
      objectProperty(node, "mutationFn")?.value?.type === "Identifier" &&
      callbackBindings.has(objectProperty(node, "mutationFn").value.name));
    const configBindings = new Set(mutationConfigs.flatMap(config => bindingNames(fn, config)));
    if (configBindings.size !== 1) return false;

    const mutationHandles = new Set(nodes(fn, node => node.type === "CallExpression" &&
      node.arguments.some(argument => argument?.type === "Identifier" &&
        configBindings.has(argument.name))).flatMap(call => bindingNames(fn, call)));
    if (mutationHandles.size !== 1) return false;

    const confirmCallbacks = nodes(fn, node =>
      (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") &&
      nodes(node, call => call.type === "CallExpression" && memberName(call.callee) === "mutate" &&
        call.callee.object?.type === "Identifier" && mutationHandles.has(call.callee.object.name)).length > 0);
    const confirmBindings = new Set(confirmCallbacks.flatMap(callback => bindingNames(fn, callback)));
    if (confirmBindings.size < 1) return false;
    return nodes(fn, node => node.type === "Property" && key(node.key) === "onConfirm" &&
      node.value?.type === "Identifier" && confirmBindings.has(node.value.name)).length === 1;
  });
}

function inspectManagerDeleteChain(protocolAst) {
  const helperFunctions = new Map(nodes(protocolAst, node => node.type === "FunctionDeclaration" &&
    node.id?.type === "Identifier").map(fn => [fn.id.name, fn]));
  return nodes(protocolAst, node => node.type === "ClassDeclaration" || node.type === "ClassExpression")
    .filter(classNode => {
      const methods = new Map(classNode.body.body.filter(item => item.type === "MethodDefinition")
        .map(method => [key(method.key), method]));
      const names = ["deleteArchivedConversation", "deleteAllArchivedConversations"];
      if (names.some(name => !methods.has(name))) return false;
      const helperNames = names.map(name => new Set(nodes(methods.get(name).value.body,
        call => call.type === "CallExpression" && call.callee?.type === "Identifier")
        .map(call => call.callee.name)));
      const sharedHelpers = [...helperNames[0]].filter(name => helperNames[1].has(name));
      const helperLinked = sharedHelpers.some(name => {
        const helper = helperFunctions.get(name);
        const context = helper?.params[0]?.type === "Identifier" ? helper.params[0].name : null;
        if (context == null) return false;
        const runtimeCalls = nodes(helper, call => call.type === "CallExpression" &&
          memberName(call.callee) === "deleteArchivedThreads" &&
          call.callee.object?.type === "MemberExpression" &&
          memberName(call.callee.object) === "runtime" &&
          call.callee.object.object?.type === "Identifier" &&
          call.callee.object.object.name === context);
        if (runtimeCalls.length !== 1) return false;
        return names.every(methodName => nodes(methods.get(methodName).value.body, call =>
          call.type === "CallExpression" && call.callee?.type === "Identifier" &&
          call.callee.name === name && call.arguments.some(argument =>
            argument?.type === "ObjectExpression" &&
            objectProperty(argument, "runtime")?.value?.type === "MemberExpression" &&
            objectProperty(argument, "runtime").value.object?.type === "ThisExpression" &&
            memberName(objectProperty(argument, "runtime").value) === "runtime")).length === 1);
      });
      const directLinked = names.every(name => nodes(methods.get(name).value.body,
        call => call.type === "CallExpression" &&
          memberName(call.callee) === "deleteArchivedThreads" &&
          call.callee.object?.type === "MemberExpression" &&
          call.callee.object.object?.type === "ThisExpression" &&
          memberName(call.callee.object) === "runtime").length === 1);
      return helperLinked || directLinked;
    });
}

function functionForBinding(root, name) {
  const functions = nodes(root, (node, parent) =>
    (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") &&
    ((parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier" &&
      parent.id.name === name) ||
     (parent?.type === "AssignmentExpression" && parent.left?.type === "Identifier" &&
      parent.left.name === name)));
  return functions.length === 1 ? functions[0] : null;
}

function componentNameForProps(ast, props) {
  const calls = nodes(ast, call => call.type === "CallExpression" &&
    call.arguments[0]?.type === "Identifier" && call.arguments[1] === props);
  return calls.length === 1 ? calls[0].arguments[0].name : null;
}

function destructuredPropertyBinding(fn, propertyName) {
  const bindings = nodes(fn, node => node.type === "ObjectPattern").flatMap(pattern =>
    pattern.properties.filter(property => property.type === "Property" &&
      key(property.key) === propertyName && property.value?.type === "Identifier")
      .map(property => property.value.name));
  return bindings.length === 1 ? bindings[0] : null;
}

function inspectRowMutationLink(ast, mutationFunction, rowFunctions, deleteProps) {
  const statePairs = nodes(mutationFunction, node => node.type === "VariableDeclarator" &&
    node.id?.type === "ArrayPattern" && node.id.elements.length >= 2 &&
    node.id.elements[0]?.type === "Identifier" && node.id.elements[1]?.type === "Identifier" &&
    node.init?.type === "CallExpression" && literal(node.init.arguments[0]) === null)
    .map(node => ({ value: node.id.elements[0].name, setter: node.id.elements[1].name }));
  const confirmProps = nodes(mutationFunction, node => node.type === "Property" &&
    key(node.key) === "onConfirm" && node.value?.type === "Identifier");
  const linked = [];

  for (const confirmProp of confirmProps) {
    const confirm = functionForBinding(mutationFunction, confirmProp.value.name);
    if (confirm == null) continue;
    for (const state of statePairs) {
      const clearsState = nodes(confirm, call => call.type === "CallExpression" &&
        call.callee?.type === "Identifier" && call.callee.name === state.setter &&
        call.arguments.length === 1 && literal(call.arguments[0]) === null).length > 0;
      const mutatesState = nodes(confirm, call => call.type === "CallExpression" &&
        memberName(call.callee) === "mutate" &&
        nodes({ type: "Arguments", values: call.arguments }, node =>
          node.type === "Identifier" && node.name === state.value).length > 0).length > 0;
      if (!mutatesState || !clearsState) continue;

      const openDeleteProps = nodes(mutationFunction, node => node.type === "ObjectExpression" &&
        objectProperty(node, "onDelete")?.value != null &&
        nodes(objectProperty(node, "onDelete").value, call => call.type === "CallExpression" &&
          call.callee?.type === "Identifier" && call.callee.name === state.setter &&
          nodes(call, item => item.type === "Property" && key(item.key) === "kind" &&
            literal(item.value) === "single").length === 1).length === 1);
      for (const props of openDeleteProps) {
        const groupName = componentNameForProps(ast, props);
        const groupFunction = nodes(ast, node => node.type === "FunctionDeclaration" &&
          node.id?.name === groupName)[0];
        if (groupFunction == null) continue;
        const groupDelete = destructuredPropertyBinding(groupFunction, "onDelete");
        if (groupDelete == null) continue;
        for (const rowProps of deleteProps) {
          const rowName = componentNameForProps(ast, rowProps);
          if (!rowFunctions.some(fn => fn.id?.name === rowName)) continue;
          const rowDelete = objectProperty(rowProps, "onDelete")?.value;
          if (rowDelete != null && nodes(rowDelete, call => call.type === "CallExpression" &&
            call.callee?.type === "Identifier" && call.callee.name === groupDelete).length === 1) {
            linked.push(rowProps);
          }
        }
      }
    }
  }
  return [...new Set(linked)];
}

function rootIdentifier(node) {
  if (node?.type === "ChainExpression") node = node.expression;
  while (node?.type === "MemberExpression") node = node.object;
  return node?.type === "Identifier" ? node.name : null;
}

function hasDeletionHandlerForRoot(root, scope) {
  return nodes(scope, call => call.type === "CallExpression" &&
    memberName(call.callee) === "handleThreadDeletion" &&
    call.arguments.some(argument => nodes(argument, item => item.type === "MemberExpression" &&
      memberName(item) === "threadId" && rootIdentifier(item) === root).length > 0)).length > 0;
}

function deletedComparisonRoot(node) {
  if (node?.type !== "BinaryExpression" || !["===", "=="].includes(node.operator)) return null;
  const method = literal(node.left) === "thread/deleted"
    ? node.right
    : literal(node.right) === "thread/deleted"
      ? node.left
      : null;
  return memberName(method) === "method" ? rootIdentifier(method) : null;
}

function handlesDeletedNotification(fn) {
  const switches = nodes(fn, node => node.type === "SwitchStatement" &&
    memberName(node.discriminant) === "method");
  for (const statement of switches) {
    const root = rootIdentifier(statement.discriminant);
    if (root == null) continue;
    for (const branch of statement.cases) {
      if (literal(branch.test) !== "thread/deleted") continue;
      if (hasDeletionHandlerForRoot(root, { type: "CaseBody", body: branch.consequent })) return true;
    }
  }

  const conditionals = nodes(fn, node =>
    node.type === "IfStatement" || node.type === "ConditionalExpression");
  for (const conditional of conditionals) {
    const root = deletedComparisonRoot(conditional.test);
    if (root != null && hasDeletionHandlerForRoot(root, conditional.consequent)) return true;
  }

  const logicalBranches = nodes(fn, node => node.type === "LogicalExpression" && node.operator === "&&");
  for (const branch of logicalBranches) {
    const root = deletedComparisonRoot(branch.left);
    if (root != null && hasDeletionHandlerForRoot(root, branch.right)) return true;
  }
  return false;
}

function inspectNativeArchiveDelete(code, protocolCode) {
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const protocolAst = acorn.parse(protocolCode, { ecmaVersion: "latest", sourceType: "module" });

  const mutationFunctions = inspectMutationChain(ast, code);
  if (mutationFunctions.length !== 1) return null;

  const deleteProps = nodes(ast, node => node.type === "ObjectExpression").filter(object => {
    const names = new Set(object.properties.filter(property => property.type === "Property")
      .map(property => key(property.key)));
    return names.has("showDeleteButton") && names.has("onDelete");
  });
  if (deleteProps.length < 1) return null;

  const rowFunctions = nodes(ast, node => node.type === "FunctionDeclaration").filter(fn => {
    const patterns = [fn.params, ...nodes(fn.body, node => node.type === "ObjectPattern")].flat();
    const bindings = patterns.filter(pattern => pattern?.type === "ObjectPattern").map(pattern =>
      Object.fromEntries(pattern.properties.filter(property => property.type === "Property" &&
        property.value?.type === "Identifier").map(property => [key(property.key), property.value.name])));
    const props = bindings.find(item => item.showDeleteButton && item.onDelete);
    if (props == null) return false;
    const usesDeleteGuard = nodes(fn.body, node => node.type === "Identifier" &&
      node.name === props.showDeleteButton).length > 1;
    const invokesDelete = nodes(fn.body, node =>
      (node.type === "CallExpression" && node.callee?.type === "Identifier" &&
        node.callee.name === props.onDelete) ||
      (node.type === "Property" && key(node.key) === "onClick" &&
        node.value?.type === "Identifier" && node.value.name === props.onDelete)).length > 0;
    return usesDeleteGuard && invokesDelete;
  });
  if (rowFunctions.length !== 1) return null;
  const linkedDeleteProps = inspectRowMutationLink(
    ast,
    mutationFunctions[0],
    rowFunctions,
    deleteProps,
  );
  if (linkedDeleteProps.length < 1) return null;

  const managerChains = inspectManagerDeleteChain(protocolAst);
  if (managerChains.length !== 1) return null;
  const runtimeDeletes = nodes(protocolAst, node =>
    (node.type === "Property" || node.type === "MethodDefinition") &&
      key(node.key) === "deleteArchivedThreads");
  if (runtimeDeletes.length !== 1) return null;
  const runtimeCalls = nodes(runtimeDeletes[0], node => node.type === "CallExpression" &&
    ["deleteArchivedThread", "deleteAllArchivedThreads"].includes(memberName(node.callee)));
  const runtimeReceivers = new Map();
  for (const call of runtimeCalls) {
    const receiver = receiverSource(protocolCode, call);
    if (receiver == null) continue;
    if (!runtimeReceivers.has(receiver)) runtimeReceivers.set(receiver, new Set());
    runtimeReceivers.get(receiver).add(memberName(call.callee));
  }
  if (![...runtimeReceivers.values()].some(methods => methods.has("deleteArchivedThread") &&
      methods.has("deleteAllArchivedThreads"))) return null;
  const protocolMethods = nodes(protocolAst, node =>
    (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression") &&
    nodes(node, call => call.type === "CallExpression" &&
      ["sendRequest", "sendAppServerRequest", "sendAppServerExtensionRequest"]
        .includes(memberName(call.callee)) && literal(call.arguments[0]) === "thread/delete").length > 0);
  const deleteNotifications = nodes(protocolAst, node =>
    (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression") &&
    handlesDeletedNotification(node));
  if (protocolMethods.length < 1 || deleteNotifications.length < 1) return null;

  return {
    deleteProps: linkedDeleteProps.length,
    mutationFunction: mutationFunctions[0].id?.name ?? null,
    rowFunction: rowFunctions[0].id?.name ?? null,
  };
}

function hasNativeArchiveDelete(code, protocolCode = code) {
  try {
    return inspectNativeArchiveDelete(code, protocolCode) != null;
  } catch {
    return false;
  }
}

// ─── Layer 1: app-main route injection ──────────────────────────

function patchAppMain(bundles, isCheck) {
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes("delete-conversation")) {
      console.log(`  [ok] ${relPath(bundle.path)}: route already patched`);
      continue;
    }

    // Dynamically find the unarchive-conversation route and extract:
    //   1. The quote style (" or `)
    //   2. The wrapper function name (XE, YE, etc.)
    //   3. The inner parameter variable name (t for conversationId)
    // Pattern: <quote>unarchive-conversation<quote>:<WrapperFn>(async(e,{conversationId:<var>})=>{await e.unarchiveConversation(<var>)})
    const routeRe = /(["`])unarchive-conversation\1:(\w+)\(async\((\w+),\{conversationId:(\w+)\}\)=>\{\s*await \3\.unarchiveConversation\(\4\)\s*\}\)/;
    const routeMatch = code.match(routeRe);
    if (!routeMatch) {
      throw new Error(`${relPath(bundle.path)}: unarchive-conversation route not found`);
    }

    const q = routeMatch[1]; // quote style
    const wrapperFn = routeMatch[2]; // e.g. XE
    const mgrVar = routeMatch[3]; // e.g. e (the app server manager)
    const cidVar = routeMatch[4]; // e.g. t (conversationId param)
    const anchorEnd = routeMatch.index + routeMatch[0].length;

    const inject = `,${q}delete-conversation${q}:${wrapperFn}(async(${mgrVar},{conversationId:${cidVar}})=>{await ${mgrVar}.sendRequest(${q}thread/delete${q},{threadId:${cidVar}})})`;
    const newCode = code.slice(0, anchorEnd) + inject + code.slice(anchorEnd);

    if (isCheck) {
      console.log(
        `  [?] ${relPath(bundle.path)}: would inject delete-conversation route (wrapper=${wrapperFn})`,
      );
      patched++;
      continue;
    }

    fs.writeFileSync(bundle.path, newCode);
    console.log(`  [ok] ${relPath(bundle.path)}: injected delete-conversation route (wrapper=${wrapperFn})`);
    patched++;
  }
  return patched;
}

// ─── Layer 2: data-controls delete button injection ─────────────

function patchDataControls(bundles, isCheck) {
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes("delete-conversation")) {
      console.log(`  [ok] ${relPath(bundle.path)}: delete button already patched`);
      continue;
    }

    let ast;
    try {
      ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
    } catch (e) {
      throw new Error(`${relPath(bundle.path)}: parse failed: ${e.message}`);
    }

    // ── Step 1: Extract import variable names via AST ImportDeclarations ──

    let msgFnName = null;
    let btnComponent = null;
    let jsxFactory = null; // import from jsx-runtime (factory function, NOT the runtime)

    for (const node of ast.body) {
      if (node.type !== "ImportDeclaration") continue;
      const src = node.source.value;
      const specs = node.specifiers.filter((s) => s.type === "ImportSpecifier");

      if (src.includes("app-server-manager-signals") && specs.length >= 2) {
        // Second specifier is the messaging function (sendRequest wrapper).
        msgFnName = specs[1].local.name;
      }
      if (src.includes("button-") && specs.length >= 1) {
        btnComponent = specs[0].local.name;
      }
      if (src.includes("jsx-runtime") && specs.length >= 1) {
        jsxFactory = specs[0].local.name;
      }
    }

    const ROW_CLASS =
      "flex w-full items-center justify-between gap-3 px-4 py-3 hover:bg-token-list-hover-background";

    let threadVar = null;
    let hostIdVar = null;
    let queryClientVar = null;
    let contentVar = null;
    let unarchiveBtnVar = null;
    let childrenArrayStart = -1;
    let childrenArrayEnd = -1;

    // Recursive AST walker.
    function walk(node, visitors) {
      if (!node || typeof node !== "object") return;
      if (node.type) {
        for (const v of visitors) v(node);
      }
      for (const key of Object.keys(node)) {
        if (key === "type" || key === "start" || key === "end") continue;
        const val = node[key];
        if (Array.isArray(val)) val.forEach((n) => walk(n, visitors));
        else if (val && typeof val === "object" && val.type) walk(val, visitors);
      }
    }

    // Resolve the actual jsx runtime instance: `var E = r()` where r is jsxFactory.
    // The import is a factory function; calling it returns the runtime with .jsx/.jsxs.
    let jsxRuntime = null;
    if (jsxFactory) {
      walk(ast, [
        (node) => {
          if (
            node.type === "VariableDeclarator" &&
            node.id?.type === "Identifier" &&
            node.init?.type === "CallExpression" &&
            node.init.callee?.type === "Identifier" &&
            node.init.callee.name === jsxFactory &&
            node.init.arguments.length === 0
          ) {
            jsxRuntime = node.id.name;
          }
        },
      ]);
    }

    // Find the FunctionDeclaration containing the ROW_CLASS literal.
    let rowFunc = null;
    walk(ast, [
      (node) => {
        if (node.type !== "FunctionDeclaration") return;
        const slice = code.slice(node.start, node.end);
        if (slice.includes(ROW_CLASS)) rowFunc = node;
      },
    ]);

    if (!rowFunc) {
      throw new Error(`${relPath(bundle.path)}: row function not found`);
    }

    // Inside the row function, find:
    //   a) ObjectPattern destructuring with key "archivedThread" → threadVar, hostIdVar
    //   b) MemberExpression .cancelQueries() → queryClientVar
    //   c) CallExpression jsxs("div", {className: ROW_CLASS, children: [X, Y]}) → contentVar, unarchiveBtnVar
    walk(rowFunc, [
      (node) => {
        // (a) ObjectPattern: {archivedThread:X, conversationId:Y, hostId:Z, ...} = e
        if (node.type === "ObjectPattern") {
          for (const prop of node.properties) {
            if (prop.type !== "Property" || prop.key?.type !== "Identifier") continue;
            if (prop.key.name === "archivedThread" && prop.value?.type === "Identifier") {
              threadVar = prop.value.name;
            }
            if (prop.key.name === "hostId" && prop.value?.type === "Identifier") {
              hostIdVar = prop.value.name;
            }
          }
        }

        // (b) MemberExpression: X.cancelQueries(...)
        if (
          node.type === "CallExpression" &&
          node.callee?.type === "MemberExpression" &&
          node.callee.property?.name === "cancelQueries" &&
          node.callee.object?.type === "Identifier"
        ) {
          queryClientVar = node.callee.object.name;
        }

        // (c) jsxs("div", {className: ROW_CLASS, children: [X, Y]})
        if (
          node.type === "CallExpression" &&
          node.arguments?.length >= 2 &&
          node.arguments[1]?.type === "ObjectExpression"
        ) {
          const props = node.arguments[1].properties;
          const clsProp = props?.find(
            (p) =>
              p.key?.name === "className" &&
              p.value?.type === "TemplateLiteral" &&
              p.value.quasis?.[0]?.value?.raw === ROW_CLASS,
          );
          if (!clsProp) return;
          const childProp = props?.find(
            (p) => p.key?.name === "children" && p.value?.type === "ArrayExpression",
          );
          if (!childProp || childProp.value.elements.length !== 2) return;
          const [el0, el1] = childProp.value.elements;
          if (el0?.type === "Identifier") contentVar = el0.name;
          if (el1?.type === "Identifier") unarchiveBtnVar = el1.name;
          childrenArrayStart = childProp.value.start;
          childrenArrayEnd = childProp.value.end;
        }
      },
    ]);

    // ── Step 3: Validate all variables resolved ──

    if (
      !msgFnName || !btnComponent || !jsxRuntime ||
      !threadVar || !hostIdVar || !queryClientVar ||
      !contentVar || !unarchiveBtnVar || childrenArrayStart < 0
    ) {
      throw new Error(
        `${relPath(bundle.path)}: could not resolve all delete-button variables ` +
        `(msgFn=${msgFnName} btn=${btnComponent} jsx=${jsxRuntime}` +
        ` thread=${threadVar} host=${hostIdVar} qc=${queryClientVar}` +
        ` content=${contentVar} unarchiveBtn=${unarchiveBtnVar})`,
      );
    }

    // ── Step 4: Build delete button and splice into children array ──

    const deleteBtn = [
      `(0,${jsxRuntime}.jsx)(${btnComponent},{`,
        `className:\`shrink-0\`,`,
        `color:\`secondary\`,`,
        `size:\`toolbar\`,`,
        `style:{color:\`#ef4444\`},`,
        `onClick:async()=>{`,
          `if(!confirm(\`Permanently delete this conversation?\`))return;`,
          `try{`,
            `${queryClientVar}.setQueryData([\`archived-threads\`,${hostIdVar}],`,
              `(${queryClientVar}.getQueryData([\`archived-threads\`,${hostIdVar}])??[])`,
              `.filter(e=>e.id!==${threadVar}.id));`,
            `await ${msgFnName}(\`delete-conversation\`,{conversationId:${threadVar}.id})`,
          `}catch(e){`,
            `${queryClientVar}.invalidateQueries({queryKey:[\`archived-threads\`,${hostIdVar}]})`,
          `}`,
        `},`,
        `children:\`Delete\``,
      `})`,
    ].join("");

    // Replace [contentVar, unarchiveBtnVar] with [contentVar, deleteBtn, unarchiveBtnVar]
    const newArray = `[${contentVar},${deleteBtn},${unarchiveBtnVar}]`;
    const newCode = code.slice(0, childrenArrayStart) + newArray + code.slice(childrenArrayEnd);

    if (isCheck) {
      console.log(
        `  [?] ${relPath(bundle.path)}: would inject delete button` +
        ` (thread=${threadVar} host=${hostIdVar} qc=${queryClientVar} btn=${btnComponent})`,
      );
      patched++;
      continue;
    }

    fs.writeFileSync(bundle.path, newCode);
    console.log(
      `  [ok] ${relPath(bundle.path)}: injected delete button` +
      ` (thread=${threadVar} host=${hostIdVar} qc=${queryClientVar} btn=${btnComponent})`,
    );
    patched++;
  }
  return patched;
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  console.log("  [layer 0] archived lists: query all model providers");
  const providerResult = patchArchivedProviderQueries(
    locateArchivedProviderBundles(platform),
    isCheck,
  );

  const dataControlsBundles = locateBundles({
    dir: "assets",
    pattern: /^data-controls-.*\.js$/,
    ...(platform ? { platform } : {}),
  });
  const protocolBundles = locateBundles({
    dir: "assets",
    pattern: /^app-initial-.*\.js$/,
    ...(platform ? { platform } : {}),
  });
  const protocolByPlatform = new Map();
  for (const bundle of protocolBundles) {
    if (protocolByPlatform.has(bundle.platform)) {
      throw new Error(`[${bundle.platform}] app-initial protocol bundle 数量异常`);
    }
    protocolByPlatform.set(bundle.platform, fs.readFileSync(bundle.path, "utf-8"));
  }
  const nativeBundles = dataControlsBundles.filter((bundle) => {
    const protocolCode = protocolByPlatform.get(bundle.platform);
    return protocolCode != null && hasNativeArchiveDelete(
      fs.readFileSync(bundle.path, "utf-8"), protocolCode,
    );
  });
  const nativePlatforms = new Set(nativeBundles.map((bundle) => bundle.platform));

  for (const bundle of nativeBundles) {
    console.log(`  [ok] ${relPath(bundle.path)}: upstream provides archived conversation deletion`);
  }

  console.log("  [layer 1] app-main: delete-conversation route");
  const appMainBundles = locateBundles({
    dir: "assets",
    pattern: /^app-main-.*\.js$/,
    ...(platform ? { platform } : {}),
  });
  const expectedPlatforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter(name =>
      fs.existsSync(path.join(SRC_DIR, name, "_asar")));
  for (const name of expectedPlatforms) {
    if (nativePlatforms.has(name)) continue;
    const appMainCount = appMainBundles.filter(bundle => bundle.platform === name).length;
    const dataControlsCount = dataControlsBundles.filter(bundle => bundle.platform === name).length;
    if (appMainCount !== 1 || dataControlsCount !== 1) {
      throw new Error(
        `[${name}] 归档删除链路不完整：原生实现未通过验证，` +
        `fallback app-main=${appMainCount}, data-controls=${dataControlsCount}`,
      );
    }
  }
  const routePatched = patchAppMain(
    appMainBundles.filter((bundle) => !nativePlatforms.has(bundle.platform)),
    isCheck,
  );

  console.log("  [layer 2] data-controls: delete button");
  const btnPatched = patchDataControls(
    dataControlsBundles.filter((bundle) => !nativePlatforms.has(bundle.platform)),
    isCheck,
  );

  console.log(
    `  [done] providers: ${providerResult.patched} patched/${providerResult.already} already, ` +
    `native: ${nativeBundles.length}, routes: ${routePatched}, buttons: ${btnPatched}`,
  );
}

if (require.main === module) main();

module.exports = {
  analyzeArchivedListProviders,
  hasNativeArchiveDelete,
  inspectNativeArchiveDelete,
  patchAppMain,
  patchArchivedListProviders,
  patchArchivedProviderQueries,
  patchDataControls,
};
