#!/usr/bin/env node
/**
 * Post-build patch: Remove plugin auth gate + force browser-use available
 *
 * Rule 1 — Plugin auth gate (gradient-*.js or similar):
 *   AST match: function(X) { return X !== `chatgpt` }
 *   Replace expression with !1 (always allow non-chatgpt auth)
 *
 * Rule 2 — Browser-use availability (use-in-app-browser-use-availability-*.js):
 *   AST match: function containing featureName:`browser_use` that returns
 *   {allowed:X, available:Y, isLoading:Z}
 *   Replace allowed/available values with !0
 *
 * Rule 3 — Statsig gate bypass (any chunk):
 *   AST match: CallExpression `identifier(numericStringLiteral)` where the call
 *   appears inside a function that also references featureName strings like
 *   `browser_use`, `computer_use`, `browser_use_external`
 *   Replace the call with !0
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");
const { frontendFiles, rspackModules } = require("./rspack-util");

const AUTH_MARKER = "/* Codex：插件目录认证门槛已关闭。 */";
const GOAL_MARKER = "/* Codex：Goal 旧门槛已关闭。 */";
const BROWSER_MARKER = "/* Codex：浏览器功能 gate 已关闭：";

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

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0].value.cooked;
  return null;
}

function nodeContainsString(node, source, str) {
  return source.slice(node.start, node.end).includes(str);
}

// ── Rule 1: Plugin auth — queryFn 内的 await auth(...) !== "chatgpt" ──

function isPluginEndpointSource(source) {
  return source.includes("/ps/plugins/")
    || source.includes("/ps/plugin-categories/");
}

function isChatGptComparison(node) {
  return node?.type === "BinaryExpression"
    && node.operator === "!=="
    && (getLiteralValue(node.left) === "chatgpt"
      || getLiteralValue(node.right) === "chatgpt");
}

function findPluginAuthPatches(ast, source) {
  const contextual = [];
  const legacy = [];
  walk(ast, (node) => {
    if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      return;
    }
    const functionSource = source.slice(node.start, node.end);
    if (!isPluginEndpointSource(functionSource)) return;
    walk(node, (inner) => {
      if (!isChatGptComparison(inner)) return;
      const authSide = getLiteralValue(inner.left) === "chatgpt" ? inner.right : inner.left;
      if (authSide.type !== "AwaitExpression") return;
      const expr = source.slice(inner.start, inner.end);
      contextual.push({
        id: "plugin_auth_gate",
        start: inner.start,
        end: inner.end,
        replacement: `${AUTH_MARKER}!1`,
        original: expr,
      });
    });
  });
  if (contextual.length > 0) return contextual;

  // 旧版曾把认证判断单独放进一个只返回条件的函数。当前 queryFn 结构已
  // 由上面的 endpoint 上下文匹配；这里只为旧布局保留原语义。
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression") return;
    const body = node.body;
    if (!body || body.type !== "BlockStatement" || body.body.length !== 1) return;
    const statement = body.body[0];
    if (statement.type !== "ReturnStatement" || !isChatGptComparison(statement.argument)) return;
    const expr = source.slice(statement.argument.start, statement.argument.end);
    legacy.push({
      id: "plugin_auth_gate",
      start: statement.argument.start,
      end: statement.argument.end,
      replacement: `${AUTH_MARKER}!1`,
      original: expr,
    });
  });
  return legacy;
}

// ── Rule 6: Force /goal slash command available ──
// The goal feature is gated by: gate(ID) && config.goals === true && mode !== 'cloud'
// AST match: LogicalExpression chain containing `goals` string AND a gate call,
// replace with just the mode check (X !== `cloud`).

function findGoalGatePatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "LogicalExpression" || node.operator !== "&&") return;
    const slice = source.slice(node.start, node.end);
    // Must contain `goals` config check and `cloud` mode check
    if (!slice.includes("`goals`") && !slice.includes('"goals"')) return;
    if (!slice.includes("`cloud`") && !slice.includes('"cloud"')) return;
    // Must contain a gate call (identifier with numeric string arg)
    let hasGateCall = false;
    walk(node, (inner) => {
      if (inner.type !== "CallExpression") return;
      if (inner.callee?.type !== "Identifier") return;
      if (inner.arguments?.length !== 1) return;
      const val = getLiteralValue(inner.arguments[0]);
      if (val && /^\d{6,}$/.test(val)) hasGateCall = true;
    });
    if (!hasGateCall) return;
    // The rightmost operand is the mode check (X !== `cloud`).
    // In A && B && C, node.right is C.
    const right = node.right;
    const rightSrc = source.slice(right.start, right.end);
    if (!rightSrc.includes("cloud")) return;
    const fullSrc = source.slice(node.start, node.end);
    if (fullSrc === rightSrc) return;
    patches.push({
      id: "goal_gate_bypass",
      start: node.start,
      end: node.end,
      replacement: `${GOAL_MARKER}${rightSrc}`,
      original: fullSrc.slice(0, 50) + "...",
    });
  });
  return patches;
}

function inspectNativeGoalGate(source) {
  if (!source.includes("goalSlashCommand")) return false;
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return false;
  }

  const parents = new Map();
  function index(node, parent = null) {
    if (!node || typeof node !== "object") return;
    if (node.type) parents.set(node, parent);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && child.type) index(child, node);
        }
      } else if (value && typeof value === "object" && value.type) {
        index(value, node);
      }
    }
  }
  index(ast);

  let resolver = null;
  walk(ast, (node) => {
    if (resolver || node.type !== "FunctionDeclaration" || !node.id) return;
    const text = source.slice(node.start, node.end);
    if (/^function [\w$]+\([\w$]+,[\w$]+\)\{return"cloud"!==[\w$]+&&\("local"!==[\w$]+\.kind\|\|"side"!==[\w$]+\.placement\)\}/.test(text)) {
      resolver = node;
    }
  });
  if (!resolver) return false;

  const callVariables = new Set();
  walk(ast, (node) => {
    if (node.type !== "CallExpression"
      || node.callee.type !== "Identifier"
      || node.callee.name !== resolver.id.name
      || node.arguments.length !== 2) return;
    let parent = parents.get(node);
    if (parent?.type === "VariableDeclarator" && parent.init === node
      && parent.id.type === "Identifier") {
      callVariables.add(parent.id.name);
    } else if (parent?.type === "AssignmentExpression" && parent.right === node
      && parent.left.type === "Identifier") {
      callVariables.add(parent.left.name);
    }
  });
  if (callVariables.size === 0) return false;

  const aliases = new Set();
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier"
      && node.init?.type === "Identifier" && callVariables.has(node.init.name)) {
      aliases.add(node.id.name);
    }
  });
  if (aliases.size === 0) return false;

  const enabledVariables = new Set();
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier"
      && node.init?.type === "LogicalExpression" && node.init.operator === "&&"
      && node.init.left.type === "Identifier" && aliases.has(node.init.left.name)) {
      enabledVariables.add(node.id.name);
    }
  });
  if (enabledVariables.size === 0) return false;

  let linked = false;
  walk(ast, (node) => {
    if (linked || node.type !== "Property") return;
    const name = node.key?.name ?? node.key?.value;
    if (name === "enabled" && node.value?.type === "Identifier"
      && enabledVariables.has(node.value.name)) linked = true;
  });
  return linked;
}

// ── Rule 2: Force browser-use availability ──
// Find functions that return {allowed:X, available:Y, isLoading:Z}
// and contain featureName:`browser_use` (not browser_use_external).

function findBrowserAvailPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression")
      return;
    const slice = source.slice(node.start, node.end);
    // Must contain a use-availability featureName
    if (
      !slice.includes("`browser_use`") &&
      !slice.includes("`browser_use_external`") &&
      !slice.includes("`computer_use`")
    ) return;

    // Find return objects containing {available:X, ...} with isLoading
    // Matches both {allowed,available,isLoading} and {available,isFetching,isLoading}
    walk(node, (inner) => {
      if (inner.type !== "ObjectExpression") return;
      const props = inner.properties;
      if (!props || props.length < 3) return;
      const keys = props.map((p) => p.key?.name || p.key?.value);
      if (!keys.includes("available") || !keys.includes("isLoading")) return;

      for (const prop of props) {
        const name = prop.key?.name || prop.key?.value;
        if (name === "allowed" || name === "available") {
          const val = source.slice(prop.value.start, prop.value.end);
          if (val === "!0") continue;
          patches.push({
            id: `browser_use_${name}`,
            start: prop.value.start,
            end: prop.value.end,
            replacement: "!0",
            original: val,
          });
        }
      }
    });
  });

  return patches;
}

// ── Rule 3: Statsig gate bypass ──
// Match: identifier(`numericString`) inside a function that also contains
// a known feature name like browser_use, computer_use, etc.
// This catches gate calls regardless of their numeric ID.

const FEATURE_CONTEXTS = new Set([
  "browser_use",
  "computer_use",
  "browser_use_external",
]);

function findStatsigGatePatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type))
      return;
    const slice = source.slice(node.start, node.end);
    const feature = [...FEATURE_CONTEXTS].find((name) =>
      slice.includes(`featureName:"${name}"`)
      || slice.includes(`featureName:\`${name}\``)
      || slice.includes(`featureName:'${name}'`),
    );
    if (!feature) return;

    walk(node, (inner) => {
      if (inner.type !== "CallExpression") return;
      const callee = inner.callee;
      const directCall = callee?.type === "Identifier";
      const sequenceCall = callee?.type === "SequenceExpression"
        && callee.expressions.length === 2
        && callee.expressions[1]?.type === "MemberExpression";
      if (!directCall && !sequenceCall) return;
      if (inner.arguments?.length !== 1) return;
      const argVal = getLiteralValue(inner.arguments[0]);
      if (!argVal || !/^\d{6,}$/.test(argVal)) return;

      const expr = source.slice(inner.start, inner.end);
      if (expr.includes(BROWSER_MARKER)) return;

      patches.push({
        id: `statsig_gate_${argVal}`,
        start: inner.start,
        end: inner.end,
        replacement: `${BROWSER_MARKER}${feature}:${argVal} */!0`,
        original: expr,
      });
    });
  });

  return patches;
}

// ── Rule 4: Force default desktop feature availability to true ──
// The main process has a default features object with all values false.
// This prevents bundled plugins from being installed during early startup.
// AST match: ObjectExpression with properties like inAppBrowserUse:!1, externalBrowserUseAllowed:!1, etc.

const FEATURE_KEYS = [
  "browserPane", "inAppBrowserUse", "inAppBrowserUseAllowed",
  "externalBrowserUse", "externalBrowserUseAllowed",
  "computerUse", "computerUseNodeRepl", "control", "multiWindow",
];

function findFeatureDefaultPatches(ast, source) {
  const patches = [];

  // Part A: Force default feature values from !1 to !0
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    const props = node.properties;
    if (!props || props.length < 5) return;
    const keys = props.map((p) => p.key?.name || p.key?.value);
    let matchCount = 0;
    for (const k of FEATURE_KEYS) if (keys.includes(k)) matchCount++;
    if (matchCount < 3) return;

    for (const prop of props) {
      const name = prop.key?.name || prop.key?.value;
      if (!FEATURE_KEYS.includes(name)) continue;
      const val = source.slice(prop.value.start, prop.value.end);
      if (val !== "!1") continue;
      patches.push({
        id: `feature_default_${name}`,
        start: prop.value.start,
        end: prop.value.end,
        replacement: "!0",
        original: val,
      });
    }
  });

  // Part A2: Force features.js_repl to true.
  // This is a separate object {"features.js_repl":!1} that controls whether
  // the Node.js REPL (Chrome browser control) is exposed to the model.
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    const props = node.properties;
    if (!props || props.length !== 1) return;
    const prop = props[0];
    const key = prop.key?.value;
    if (key !== "features.js_repl") return;
    const val = source.slice(prop.value.start, prop.value.end);
    if (val !== "!1") return;
    patches.push({
      id: "feature_js_repl",
      start: prop.value.start,
      end: prop.value.end,
      replacement: "!0",
      original: val,
    });
  });

  // Part B: Bypass the isAvailable filter in bundled plugins descriptor.
  // Pattern: X.filter(Y => Y.isAvailable({buildFlavor:..., features:..., platform:...}))
  // The filter callback checks features like externalBrowserUseAllowed which may be
  // false at startup. Replace the callback with ()=>!0 so all plugins are included.
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "MemberExpression") return;
    if (node.callee.property?.name !== "filter") return;
    if (node.arguments?.length !== 1) return;
    const cb = node.arguments[0];
    if (cb.type !== "ArrowFunctionExpression") return;
    const cbSrc = source.slice(cb.start, cb.end);
    if (!cbSrc.includes("isAvailable")) return;
    if (!cbSrc.includes("features")) return;
    if (cbSrc === "()=>!0") return;
    patches.push({
      id: "bundled_plugins_filter_bypass",
      start: cb.start,
      end: cb.end,
      replacement: "()=>!0",
      original: cbSrc.slice(0, 40) + "...",
    });
  });

  // Part C: Bypass browser-use native pipe peer authorization.
  // The BM() function checks code signing identity via a native module.
  // Ad-hoc signed builds fail because teamId !== "2DC432GLL2" (OpenAI).
  // AST match: function containing literal "browser-use-peer-authorization.node",
  // find the IfStatement whose consequent returns ()=>({authorized:!0}) —
  // that's the bypass path — force its condition to !0.
  walk(ast, (node) => {
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression"
    ) return;
    const slice = source.slice(node.start, node.end);
    if (!slice.includes("shouldIncludeBrowserUsePeerAuthorization")) return;

    // Find if(...) return ()=>({authorized:!0}) — the bypass return.
    // There are multiple returns; we want the one right before the native module load.
    // It's the IfStatement whose consequent returns an ArrowFunction with authorized:!0.
    walk(node, (inner) => {
      if (inner.type !== "IfStatement") return;
      const cons = inner.consequent;
      if (!cons) return;
      // consequent is ReturnStatement returning ArrowFunctionExpression
      const ret = cons.type === "ReturnStatement" ? cons : null;
      if (!ret || !ret.argument) return;
      if (ret.argument.type !== "ArrowFunctionExpression") return;
      // The arrow body must be an ObjectExpression with authorized:!0
      const body = ret.argument.body;
      if (!body || body.type !== "ObjectExpression") return;
      // Check for {authorized:!0} with no "reason" property
      const props = body.properties;
      const authProp = props?.find((p) => (p.key?.name || p.key?.value) === "authorized");
      const reasonProp = props?.find((p) => (p.key?.name || p.key?.value) === "reason");
      if (!authProp) return;
      const authVal = source.slice(authProp.value.start, authProp.value.end);
      if (authVal !== "!0") return;
      // Must NOT have a reason property (to distinguish from error returns)
      if (reasonProp) return;

      // Force the if-condition to !0 — but skip platform checks
      const test = inner.test;
      const testSrc = source.slice(test.start, test.end);
      if (testSrc === "!0") return;
      if (testSrc.includes("platform")) return;
      patches.push({
        id: "peer_auth_bypass",
        start: test.start,
        end: test.end,
        replacement: "!0",
        original: testSrc,
      });
    });
  });

  return patches;
}

// ── Target location ──

function hasPluginQueryAuthGate(source) {
  if (source.includes(AUTH_MARKER)) return true;
  if (!isPluginEndpointSource(source)) return false;
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return false;
  }
  let found = false;
  walk(ast, (node) => {
    if (found || !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      return;
    }
    const functionSource = source.slice(node.start, node.end);
    if (!isPluginEndpointSource(functionSource)) return;
    walk(node, (inner) => {
      if (!isChatGptComparison(inner)) return;
      const authSide = getLiteralValue(inner.left) === "chatgpt" ? inner.right : inner.left;
      if (authSide.type === "AwaitExpression") found = true;
    });
  });
  return found;
}

function rulesForSource(source) {
  const rules = [];
  if (hasPluginQueryAuthGate(source)) {
    rules.push("auth");
  }
  if ([...FEATURE_CONTEXTS].some((name) =>
    source.includes(`featureName:"${name}"`)
    || source.includes(`featureName:\`${name}\``)
    || source.includes(`featureName:'${name}'`)
  ) || source.includes(BROWSER_MARKER)) {
    rules.push("browser");
  }
  if (source.includes("goalSlashCommand") || source.includes(GOAL_MARKER)) {
    rules.push("goal");
  }
  return rules;
}

function getPlatforms(platform, sourceDir) {
  if (platform) return [platform];
  return ["mac-arm64", "mac-x64", "win"].filter((name) =>
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

    let hasRspackFrontend = false;
    const legacyCandidates = [];
    for (const file of frontendFiles(assetsDir)) {
      const source = fs.readFileSync(file, "utf-8");
      if (source.includes("export const __webpack_modules__=")
        && !source.slice(0, 220).includes("exports=JSON.parse(")
        && (source.includes("/ps/plugin")
          || source.includes("featureName:")
          || source.includes("goalSlashCommand")
          || source.includes(AUTH_MARKER)
          || source.includes(BROWSER_MARKER)
          || source.includes(GOAL_MARKER))) {
        hasRspackFrontend = true;
        let modules;
        try {
          modules = rspackModules(source);
        } catch (error) {
          targets.push({
            platform: currentPlatform,
            path: file,
            kind: "rspack",
            parseError: error,
            rules: [],
          });
          continue;
        }
        for (const module of modules) {
          const rules = rulesForSource(module.source);
          if (rules.length === 0) continue;
          targets.push({
            platform: currentPlatform,
            path: file,
            source: module.source,
            chunkSource: source,
            kind: "rspack",
            moduleId: module.id,
            start: module.start,
            end: module.end,
            rules,
          });
        }
        continue;
      }

      const basename = path.basename(file);
      const rules = [];
      if (source.length < 10000 && source.includes("chatgpt")
        && source.includes("!==")) {
        rules.push("auth");
      }
      if (basename.startsWith("use-in-app-browser-use-availability-")
        || basename.startsWith("use-browser-agent-availability-")) {
        rules.push("avail", "gate", "browser");
      }
      if (basename.startsWith("composer-") && source.includes("goalSlashCommand")) {
        rules.push("goal");
      }
      if (rules.length > 0) {
        legacyCandidates.push({
          platform: currentPlatform,
          path: file,
          source,
          kind: "legacy",
          start: 0,
          end: source.length,
          rules,
        });
      }
    }
    if (!hasRspackFrontend) targets.push(...legacyCandidates);

    // Rule 4: main process 的原生 feature defaults 仍在旧构建布局中。
    const buildDir = path.join(sourceDir, currentPlatform, "_asar", ".vite", "build");
    if (fs.existsSync(buildDir)) {
      for (const name of fs.readdirSync(buildDir)) {
        if (!name.startsWith("main-") || !name.endsWith(".js")) continue;
        const file = path.join(buildDir, name);
        const source = fs.readFileSync(file, "utf-8");
        if (source.includes("externalBrowserUseAllowed")
          && source.includes("computerUse")) {
          targets.push({
            platform: currentPlatform,
            path: file,
            source,
            kind: "legacy",
            start: 0,
            end: source.length,
            rules: ["features"],
          });
        }
      }
    }
  }
  return targets;
}

function patchTarget(target) {
  let ast;
  try {
    ast = parse(target.source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "parse-error", source: target.source, patches: [], error };
  }

  const patches = [];
  if (target.rules.includes("auth")) {
    patches.push(...findPluginAuthPatches(ast, target.source));
  }
  if (target.rules.includes("avail")) {
    patches.push(...findBrowserAvailPatches(ast, target.source));
  }
  if (target.rules.includes("gate") || target.kind === "rspack") {
    if (target.rules.includes("browser")) {
      patches.push(...findStatsigGatePatches(ast, target.source));
    }
  }
  if (target.rules.includes("features")) {
    patches.push(...findFeatureDefaultPatches(ast, target.source));
  }
  if (target.rules.includes("goal")) {
    patches.push(...findGoalGatePatches(ast, target.source));
  }

  const unique = patches.filter((patch, index) =>
    patches.findIndex((other) => other.start === patch.start && other.end === patch.end) === index,
  ).sort((left, right) => right.start - left.start);
  let next = target.source;
  for (const patch of unique) {
    next = next.slice(0, patch.start) + patch.replacement + next.slice(patch.end);
  }
  try {
    parse(next, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "invalid-output", source: target.source, patches: unique, error };
  }

  const goalNative = target.rules.includes("goal")
    && inspectNativeGoalGate(target.source);
  return {
    status: unique.length > 0 ? "patched" : "already-or-native",
    source: unique.length > 0 ? next : target.source,
    patches: unique,
    goalNative,
  };
}

function writeResults(patched, check) {
  const byFile = new Map();
  for (const entry of patched.filter(({ target }) => target.kind === "rspack")) {
    const group = byFile.get(entry.target.path) || {
      target: entry.target,
      replacements: [],
    };
    group.replacements.push({
      start: entry.target.start,
      end: entry.target.end,
      replacement: entry.result.source,
    });
    byFile.set(entry.target.path, group);
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
    if (!check) fs.writeFileSync(group.target.path, next, "utf-8");
  }
  for (const { target, result } of patched.filter((entry) => entry.target.kind === "legacy")) {
    if (!check) fs.writeFileSync(target.path, result.source, "utf-8");
  }
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));
  let targets;
  try {
    targets = locateTargets(platform);
  } catch (error) {
    console.log(`[x] plugin auth target scan: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (targets.length === 0) {
    console.log("[x] No plugin auth, browser-use, or goal target found");
    process.exitCode = 1;
    return;
  }

  const phases = new Map();
  const completed = [];
  let failed = 0;
  let patchCount = 0;
  for (const target of targets) {
    const label = `${relPath(target.path)}${target.moduleId ? `#${target.moduleId}` : ""}`;
    if (target.parseError) {
      console.log(`[x] ${label}: ${target.parseError.message}`);
      failed++;
      continue;
    }
    const result = patchTarget(target);
    if (result.status === "parse-error" || result.status === "invalid-output") {
      console.log(`[x] ${label}: ${result.status}`);
      failed++;
      continue;
    }

    const current = phases.get(target.platform) || {
      auth: false,
      browser: false,
      goal: false,
    };
    let recognized = true;
    if (target.rules.includes("auth")) {
      if (result.patches.some((patch) => patch.id === "plugin_auth_gate")
        || target.source.includes(AUTH_MARKER)) {
        current.auth = true;
      } else {
        recognized = false;
      }
    }
    if (target.rules.includes("browser")) {
      if (result.patches.some((patch) => patch.id.startsWith("statsig_gate_"))
        || target.source.includes(BROWSER_MARKER)) {
        current.browser = true;
      } else {
        recognized = false;
      }
    }
    if (target.rules.includes("goal")) {
      if (result.goalNative || result.patches.some((patch) => patch.id === "goal_gate_bypass")
        || target.source.includes(GOAL_MARKER)) {
        current.goal = true;
      } else {
        recognized = false;
      }
    }
    phases.set(target.platform, current);

    if (!recognized) {
      console.log(`[x] ${label}: candidate found but gate structure is unrecognized`);
      failed++;
      continue;
    }
    if (result.patches.length === 0) {
      console.log(
        `[ok] ${label}: ${result.goalNative ? "native goal chain verified" : "already patched"}`,
      );
      continue;
    }
    patchCount += result.patches.length;
    completed.push({ target, result });
    for (const patch of result.patches) {
      console.log(
        `[${isCheck ? "?" : "*"}] ${label} ${patch.id}: ${patch.original} -> ${patch.replacement}`,
      );
    }
  }

  try {
    writeResults(completed, isCheck);
  } catch (error) {
    console.log(`[x] plugin auth output: ${error.message}`);
    failed++;
  }

  for (const currentPlatform of getPlatforms(platform, SRC_DIR)) {
    const current = phases.get(currentPlatform) || {};
    if (!current.auth) {
      console.log(`[x] ${currentPlatform}: plugin auth gate was not recognized`);
      failed++;
    }
    if (!current.browser) {
      console.log(`[x] ${currentPlatform}: browser-use gate was not recognized`);
      failed++;
    }
    if (!current.goal) {
      console.log(`[x] ${currentPlatform}: goal native chain or legacy gate was not recognized`);
      failed++;
    }
  }
  console.log(`[done] ${isCheck ? "would patch" : "patched"} ${patchCount} plugin/browser/goal gate(s)`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  AUTH_MARKER,
  BROWSER_MARKER,
  GOAL_MARKER,
  findPluginAuthPatches,
  findStatsigGatePatches,
  inspectNativeGoalGate,
  locateTargets,
  patchTarget,
};
