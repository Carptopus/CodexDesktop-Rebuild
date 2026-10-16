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

function hasNativeArchiveDelete(code) {
  const legacyMarkers = [
    "delete-archived-conversation",
    "delete-all-archived-conversations",
    "showDeleteButton",
    "settings.dataControls.archivedChats.deleteConfirm.title",
    "thread/delete",
  ];
  const currentMarkers = [
    "delete-archived-conversation",
    "delete-archived-conversations",
    "deleteArchivedConversation",
    "deleteAllArchivedConversations",
    "showDeleteButton",
    "thread/delete",
  ];
  return [legacyMarkers, currentMarkers].some((markers) =>
    markers.every((marker) => code.includes(marker)),
  );
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
      console.log(`  [!] ${relPath(bundle.path)}: unarchive-conversation route not found`);
      continue;
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
      console.log(`  [!] ${relPath(bundle.path)}: parse failed: ${e.message}`);
      continue;
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
      console.log(`  [!] ${relPath(bundle.path)}: row function not found`);
      continue;
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
      console.log(`  [!] ${relPath(bundle.path)}: could not resolve all variables`);
      console.log(
        `      msgFn=${msgFnName} btn=${btnComponent} jsx=${jsxRuntime}` +
        ` thread=${threadVar} host=${hostIdVar} qc=${queryClientVar}` +
        ` content=${contentVar} unarchiveBtn=${unarchiveBtnVar}`,
      );
      continue;
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
  const nativeBundles = dataControlsBundles.filter((bundle) =>
    hasNativeArchiveDelete(fs.readFileSync(bundle.path, "utf-8")),
  );
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
  patchAppMain,
  patchArchivedListProviders,
  patchArchivedProviderQueries,
  patchDataControls,
};
