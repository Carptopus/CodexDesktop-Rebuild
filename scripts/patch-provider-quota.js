#!/usr/bin/env node
/**
 * 来源：DevSplash da84a96c，按真实端点隔离额度发送门槛。
 * Scope the desktop composer's OpenAI quota gates to the effective provider.
 * requires_openai_auth selects credentials, not the provider receiving requests.
 * Keep account quota state intact; only explicit custom endpoints ignore it.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "/* Codex custom provider quota patch */";
const CUSTOM = "__codexUsesCustomProvider";
const PROVIDER = "__codexQuotaProvider";
const THREAD_PROVIDER = "__codexQuotaThreadProvider";
const PROVIDER_CONFIG = "__codexQuotaProviderConfig";
const PLATFORMS = ["mac-arm64", "mac-x64", "win", "unix"];

function walk(node, visit, root = node, ownScope = false) {
  if (!node || typeof node !== "object" || !node.type) return;
  if (ownScope && node !== root && /Function/.test(node.type)) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, root, ownScope);
    } else if (value?.type) {
      walk(value, visit, root, ownScope);
    }
  }
}

function nodes(root, predicate, ownScope = false) {
  const found = [];
  walk(root, node => { if (predicate(node)) found.push(node); }, root, ownScope);
  return found;
}

function unwrap(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function value(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function property(node) {
  const member = unwrap(node);
  if (member?.type !== "MemberExpression" && member?.type !== "Property") return null;
  const key = member.property ?? member.key;
  return !member.computed && key.type === "Identifier" ? key.name : value(key);
}

function parseModule(source) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" });
}

function binding(node) {
  if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
    return { name: node.id.name, init: node.init, node };
  }
  if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
    return { name: node.left.name, init: node.right, node };
  }
  return null;
}

function importFor(ast, localName) {
  for (const declaration of ast.body) {
    if (declaration.type !== "ImportDeclaration") continue;
    const specifier = declaration.specifiers.find(s => s.local.name === localName);
    if (specifier?.type === "ImportSpecifier") {
      return { source: declaration.source.value, name: specifier.imported.name };
    }
  }
  return null;
}

function getProviderMetadata(source) {
  const ast = parseModule(source);
  const providerReads = nodes(ast, node => node.type === "LogicalExpression" &&
    node.operator === "??" && node.left.type === "CallExpression" &&
    node.left.arguments.length === 2 && node.left.arguments[0]?.type === "Identifier" &&
    property(node.right) === "model_provider");
  const providerAtoms = [...new Set(providerReads.map(node => node.left.arguments[0].name))];
  if (providerAtoms.length !== 1) {
    throw new Error("Effective thread-provider lookup is ambiguous/missing");
  }
  const threadProviderImport = importFor(ast, providerAtoms[0]);
  if (!threadProviderImport) {
    throw new Error("Effective thread-provider import not found");
  }
  return { threadProviderAtom: providerAtoms[0], threadProviderImport };
}

function unique(items, label) {
  if (items.length !== 1) throw new Error(`${label} is ambiguous/missing (${items.length})`);
  return items[0];
}

// This function is embedded into the frontend and must remain self-contained.
// A custom provider ID does not imply a custom endpoint: without base_url,
// ChatGPT authentication still defaults to chatgpt.com/backend-api/codex.
function hasExternalBaseUrl(provider) {
  if (typeof provider?.base_url !== "string" || !provider.base_url.trim()) return false;
  try {
    const endpoint = new URL(provider.base_url);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return false;
    const host = endpoint.hostname.toLowerCase().replace(/\.$/, "");
    if (!host) return false;
    return !["chatgpt.com", "chat.openai.com"].some(domain =>
      host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function patchSource(source) {
  try {
    const updating = source.includes(MARKER);
    const ast = parseModule(source);
    const { threadProviderAtom } = getProviderMetadata(source);
    if (!updating && [CUSTOM, PROVIDER, THREAD_PROVIDER, PROVIDER_CONFIG]
      .some(name => source.includes(name))) {
      throw new Error("Custom-provider patch binding already exists without its marker");
    }
    const composer = unique(ast.body.filter(node => node.type === "FunctionDeclaration" &&
      nodes(node, child => property(child) === "submitDisabled", true).length > 0 &&
      nodes(node, child => property(child) === "resolvedConfig").length > 0),
    "Provider-aware composer");
    const ownNodes = nodes(composer, () => true, true);
    const memberReads = nodes(composer, node => unwrap(node)?.type === "MemberExpression");
    const declarations = ownNodes.filter(node => node.type === "VariableDeclarator");
    const submit = unique(ownNodes.filter(node => node.type === "Property" &&
      property(node) === "submitDisabled" && node.value.type === "Identifier" &&
      declarations.some(decl => decl.id.name === node.value.name && decl.init)),
    "Submit-disabled property");
    const disabled = unique(declarations.filter(node => node.id.name === submit.value.name && node.init),
      "Submit-disabled expression");
    const referenced = new Set(nodes(disabled.init, node => node.type === "Identifier").map(node => node.name));
    const configNames = new Set(memberReads.filter(node => property(node) === "resolvedConfig")
      .map(node => unwrap(node).object.name));
    const pendingNames = new Set(memberReads.filter(node => property(node) === "isConfigDataPending")
      .map(node => unwrap(node).object.name));
    const config = unique(declarations.filter(node => configNames.has(node.id.name) &&
      pendingNames.has(node.id.name) && node.init?.type === "CallExpression"), "Resolved composer config");
    const contextGates = [];
    for (const gate of declarations.filter(node => referenced.has(node.id.name) &&
      node.init?.type === "CallExpression")) {
      for (const argument of gate.init.arguments.filter(arg => arg.type === "Identifier")) {
        const assignments = ownNodes.map(binding).filter(item => item?.name === argument.name && item.init);
        for (const assignment of assignments) {
          const contexts = nodes(assignment.init, node => node.type === "ObjectExpression" &&
            ["conversationId", "hostId"].every(name =>
              node.properties.some(prop => property(prop) === name)));
          for (const context of contexts) {
            contextGates.push({ gate, context, contextName: argument.name });
          }
        }
      }
    }
    const contextGate = unique(contextGates, "Composer conversation/host quota gate");
    const targetObject = contextGate.context;
    const conversation = targetObject.properties.find(prop => property(prop) === "conversationId")?.value;
    const host = targetObject.properties.find(prop => property(prop) === "hostId")?.value;
    if (conversation?.type !== "Identifier" || host?.type !== "Identifier") {
      throw new Error("Composer config target lacks conversation/host identifiers");
    }
    const baseBlock = contextGate.gate;
    const hardBlock = unique(declarations.filter(node => {
      if (!referenced.has(node.id.name) || node.init == null) return false;
      const terms = nodes(node.init, child => child.type === "BinaryExpression" &&
        ["===", "=="].includes(child.operator) && child.left?.type === "Identifier" &&
        child.left.name === host.name && value(child.right) === "local");
      // 26.1007 使用 read(hardBlockAtom) && host === "local"；后续版本
      // 改成 value(host === "local" && hardBlockAtom)。两者都必须同时包含
      // 唯一的本地主机门槛和真实读取调用，避免按变量名猜测。
      return terms.length === 1 && nodes(node.init,
        child => child.type === "CallExpression").length === 1;
    }), "Host quota gate");
    const scopes = [...new Set(ownNodes.filter(node => property(node) === "kind" &&
      property(unwrap(node).object) === "value")
      .map(node => unwrap(unwrap(node).object).object.name))];
    const scope = unique(scopes, "Composer scope");
    const statement = unique(composer.body.body.filter(node => node.type === "VariableDeclaration" &&
      node.declarations.includes(disabled)), "Submit-disabled declaration");
    if (config.end > statement.start) throw new Error("Composer config is resolved after submission gating");
    const guard = `${MARKER}\nconst ${THREAD_PROVIDER}=${source.slice(baseBlock.init.callee.start, baseBlock.init.callee.end)}(${threadProviderAtom},${conversation.name}),` +
      `${PROVIDER}=${THREAD_PROVIDER}??(${config.id.name}.isConfigDataPending?null:${config.id.name}.resolvedConfig?.model_provider),` +
      `${PROVIDER_CONFIG}=${config.id.name}.isConfigDataPending?null:${config.id.name}.resolvedConfig?.model_providers?.[${PROVIDER}],` +
      `${CUSTOM}=(${scope}.value.kind===\`local\`||${scope}.value.kind===\`new\`&&!${scope}.value.cloudThreadPrototype)` +
      `&&typeof ${PROVIDER}===\`string\`&&${PROVIDER}.trim().length>0&&${PROVIDER}!==\`openai\`` +
      `&&(${hasExternalBaseUrl.toString()})(${PROVIDER_CONFIG});`;
    const edits = [];
    if (updating) {
      // Upgrade the previous provider-ID-only guard as well as fresh sources.
      // Keep the existing hook and quota-gate reads in their original positions.
      const oldGuard = unique(composer.body.body.filter(node => node.type === "VariableDeclaration" &&
        node.declarations.some(decl => decl.id.name === CUSTOM)), "Existing provider guard");
      const oldNames = oldGuard.declarations.map(decl => decl.id.name).join(",");
      if (oldGuard.kind !== "const" || ![
        [THREAD_PROVIDER, PROVIDER, CUSTOM].join(","),
        [THREAD_PROVIDER, PROVIDER, PROVIDER_CONFIG, CUSTOM].join(","),
      ].includes(oldNames) || oldGuard.end > statement.start ||
        source.slice(oldGuard.end, statement.start).trim()) {
        throw new Error("Existing provider guard structure changed");
      }
      const markerStart = source.lastIndexOf(MARKER, oldGuard.start);
      if (markerStart < 0 || source.slice(markerStart + MARKER.length, oldGuard.start).trim()) {
        throw new Error("Existing provider guard marker is misplaced");
      }
      edits.push({ start: markerStart, end: oldGuard.end, text: guard });
    } else {
      edits.push({ start: statement.start, end: statement.start, text: guard });
    }
    for (const gate of [hardBlock, baseBlock]) {
      const read = unique(nodes(disabled.init, node => node.type === "Identifier" &&
        node.name === gate.id.name), `Submit read of ${gate.id.name}`);
      if (updating) {
        unique(nodes(disabled.init, node => node.type === "LogicalExpression" &&
          node.operator === "&&" && node.left.type === "UnaryExpression" &&
          node.left.operator === "!" && node.left.argument.name === CUSTOM &&
          node.right === read), `Existing guard for ${gate.id.name}`);
      } else {
        edits.push({ start: read.start, end: read.end, text: `(!${CUSTOM}&&${gate.id.name})` });
      }
    }
    let code = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
    }
    parseModule(code);
    if (code === source) return { status: "already", code: source };
    return { status: "patched", code, changes: [
      "resolve the effective provider from the saved thread, then the current host/workspace config",
      "ignore OpenAI submission quota gates only for explicit non-ChatGPT custom endpoints",
    ] };
  } catch (error) {
    return { status: "error", code: source, reason: error.message };
  }
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find(arg => PLATFORMS.includes(arg));
  const check = args.includes("--check");
  const directories = (platform ? [platform] : PLATFORMS)
    .map(plat => ({ platform: plat, path: path.join(SRC_DIR, plat, "_asar", "webview", "assets") }))
    .filter(dir => fs.existsSync(dir.path));
  const legacy = path.join(SRC_DIR, "webview", "assets");
  if (!directories.length && fs.existsSync(legacy)) directories.push({ platform: "legacy", path: legacy });
  let patched = 0;
  let failed = 0;
  for (const directory of directories) {
    try {
      const files = fs.readdirSync(directory.path).filter(name => name.endsWith(".js"))
        .map(name => ({ name, source: fs.readFileSync(path.join(directory.path, name), "utf8") }));
      const candidates = [];
      const diagnostics = [];
      for (const file of files.filter(file => file.source.includes("submitDisabled") &&
        file.source.includes("model_provider") && file.source.includes("resolvedConfig") &&
        file.source.includes("isConfigDataPending"))) {
        try {
          const result = patchSource(file.source);
          if (result.status === "error") throw new Error(result.reason);
          candidates.push({ file, result });
        }
        catch (error) { diagnostics.push(`${file.name}: ${error.message}`); }
      }
      if (!candidates.length) throw new Error(`Provider-aware composer not found; ${diagnostics.join("; ")}`);
      const { file: primary, result } = unique(candidates, "Provider-aware composer bundle");
      const filePath = path.join(directory.path, primary.name);
      console.log(`  [${directory.platform}] ${relPath(filePath)}`);
      if (result.status === "already") {
        console.log("    [ok] Custom-provider quota patch already applied");
      } else {
        for (const change of result.changes) console.log(`    * ${change}`);
        if (!check) { fs.writeFileSync(filePath, result.code, "utf8"); patched++; }
        else console.log("    [?] dry-run; no file written");
      }
    } catch (error) {
      console.error(`  [x] ${directory.platform}: ${error.message}`);
      failed++;
    }
  }
  if (!directories.length) { console.error("  [x] 缺少目标平台界面资源"); process.exitCode = 1; }
  else if (failed) console.error(`  [x] ${failed} platform(s) failed`);
  else console.log(`  [ok] ${patched} bundle(s) patched`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { MARKER, getProviderMetadata, patchSource };
