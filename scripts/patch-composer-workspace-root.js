#!/usr/bin/env node
/**
 * 构建后补丁：让新会话使用真实活动 workspace root。
 *
 * 旧布局缺少 workspaceRoots 时注入 active-workspace-roots fallback。
 * 26.1106 已原生消费 query、resolver 和本地/远程字段；该布局只验证完整
 * 代码链，不重复注入与当前 bundle 不匹配的旧实现。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");
const { frontendFiles, rspackModules } = require("./rspack-util");

const PATCHED_MARKER = "c===`local`?(e.get(Oi)?.data?.roots??[]).filter";

const OLD_SNIPPET =
  "E=async(n,r,i,a)=>{let o=a?.workspaceRoots??n.workspaceRoots??[`~`],s=Ks(o),c=a?.hostId??v,u=C(a),{context:f,goal:h}=await T(n,c),g=MF(f,c),E=!1,D=Dn(f.imageAttachments),O=e.get(Ok),k=er(f);try{let n=await FF({hostId:c,prompt:k,projectlessPrewarmReservation:_,workspaceRoots:o}),a=n.cwd??r,l=await AF({activeCollaborationMode:t,context:f,hostId:c,scope:e,serviceTier:y}),v=await Cg({context:f,prompt:k,workspaceRoots:n.workspaceRoots,cwd:a,hostId:c,agentMode:u.agentMode,permissionProfileId:u.permissionProfileId,serviceTier:l.serviceTier,collaborationMode:l.collaborationMode,memoryPreferences:O??void 0,workspaceKind:s?`projectless`:`project`,projectlessOutputDirectory:n.projectlessOutputDirectory,projectAssignment:n.projectAssignment})";

const NEW_SNIPPET =
  "E=async(n,r,i,a)=>{let c=a?.hostId??v,o=a?.workspaceRoots??n.workspaceRoots??(c===`local`?(e.get(Oi)?.data?.roots??[]).filter(e=>e!=null&&e!==`~`):[]);o.length===0&&(o=[`~`]);let s=Ks(o),u=C(a),{context:f,goal:h}=await T(n,c),g=MF(f,c),E=!1,D=Dn(f.imageAttachments),O=e.get(Ok),k=er(f);try{let n=await FF({hostId:c,prompt:k,projectlessPrewarmReservation:_,workspaceRoots:o}),a=n.cwd??r,l=await AF({activeCollaborationMode:t,context:f,hostId:c,scope:e,serviceTier:y}),v=await Cg({context:f,prompt:k,workspaceRoots:n.workspaceRoots,cwd:a,hostId:c,agentMode:u.agentMode,permissionProfileId:u.permissionProfileId,serviceTier:l.serviceTier,collaborationMode:l.collaborationMode,memoryPreferences:O??void 0,workspaceKind:s?`projectless`:`project`,projectlessOutputDirectory:n.projectlessOutputDirectory,projectAssignment:n.projectAssignment})";

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

function objectPatternNames(pattern) {
  if (pattern?.type !== "ObjectPattern") return null;
  const names = new Map();
  for (const property of pattern.properties) {
    if (property.type !== "Property" || !property.value) continue;
    const key = property.key.type === "Identifier"
      ? property.key.name
      : property.key.value;
    let value = property.value;
    if (value.type === "AssignmentPattern") value = value.left;
    if (value.type !== "Identifier") continue;
    names.set(key, value.name);
  }
  return names;
}

function isFunction(node) {
  return node.type === "FunctionDeclaration"
    || node.type === "FunctionExpression"
    || node.type === "ArrowFunctionExpression";
}

// 旧 ESM 布局的已验证 matcher，保持 26.1027 及现有 mac 输入行为。
function hasNativeWorkspaceRootPropagation(source, relatedSource = source) {
  const cwdResolver =
    /function\s+[\w$]+\(\{[^}]*localConversationCwd:[\w$]+[^}]*workspaceRoots:[\w$]+[^}]*activeWorkspaceRoot:[\w$]+[^}]*canUseProjectlessThreads:[\w$]+[^}]*\}\)\{return/;
  return (
    (source.includes("active-workspace-roots")
      || relatedSource.includes("active-workspace-roots"))
    && cwdResolver.test(source)
  );
}

// 26.1106 Rspack module 使用更严格的 AST 代码链证明。
function hasRspackWorkspaceRootPropagation(source, relatedSource = source) {
  if (!relatedSource.includes("active-workspace-roots")) return false;
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return false;
  }

  const required = [
    "localConversationCwd",
    "selectedRemoteProjectPath",
    "defaultCwd",
    "workspaceRoots",
    "activeWorkspaceRoot",
    "codexHome",
    "canUseProjectlessThreads",
  ];
  let found = false;
  walk(ast, (node) => {
    if (found || !isFunction(node)) return;
    const names = objectPatternNames(node.params[0]);
    if (!names || required.some((key) => !names.has(key))) return;
    const local = names.get("localConversationCwd");
    const remote = names.get("selectedRemoteProjectPath");
    const fallback = names.get("defaultCwd");
    const roots = names.get("workspaceRoots");
    const active = names.get("activeWorkspaceRoot");
    const projectless = names.get("canUseProjectlessThreads");
    const slice = source.slice(node.start, node.end);
    const escape = (value) => value.replace(/[$]/g, "\\$");
    const resolverChecks = [
      new RegExp(`if\\(${escape(local)}\\)return ${escape(local)}`),
      new RegExp(`if\\(${escape(remote)}\\)return ${escape(remote)}`),
      new RegExp(`if\\(${escape(fallback)}\\)return ${escape(fallback)}`),
      new RegExp(`${escape(roots)}\\.find\\(`),
      new RegExp(`"/"!==${escape(active)}\\?${escape(active)}`),
      new RegExp(`\\?[^:]+:${escape(projectless)}\\?[^:]+:"/"`),
    ];
    if (!resolverChecks.every((pattern) => pattern.test(slice))) return;

    const caller = source.slice(node.end, node.end + 1400);
    if (!["localConversationCwd:", "workspaceRoots:", "activeWorkspaceRoot:",
      "canUseProjectlessThreads:"].every((field) => caller.includes(field))) return;
    found = true;
  });
  return found;
}

function getPlatforms(platform, sourceDir) {
  if (platform) return [platform];
  return ["mac-arm64", "mac-x64", "win"].filter((name) =>
    fs.existsSync(path.join(sourceDir, name, "_asar", "webview", "assets")),
  );
}

function findComposerBundles(platform, sourceDir = SRC_DIR) {
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

    const rspackFiles = [];
    const legacyFiles = [];
    const queries = [];
    const legacyQueryFiles = [];
    for (const file of frontendFiles(assetsDir)) {
      const source = fs.readFileSync(file, "utf8");
      if (source.includes("export const __webpack_modules__=")
        && !source.slice(0, 220).includes("exports=JSON.parse(")
        && (source.includes("active-workspace-roots")
          || source.includes("localConversationCwd"))) {
        const modules = rspackModules(source);
        rspackFiles.push({ file, source, modules });
        for (const module of modules) {
          if (module.source.includes("active-workspace-roots")) {
            queries.push({ file, module });
          }
        }
      } else if (!source.includes("export const __webpack_modules__=")) {
        if (source.includes("active-workspace-roots")) legacyQueryFiles.push(file);
        if (/^(?:composer|app-(?:initial|primary))-.*\.js$/.test(path.basename(file))) {
          legacyFiles.push({ file, source });
        }
      }
    }

    const relatedSource = queries.map((entry) => entry.module.source).join("\n");
    for (const chunk of rspackFiles) {
      for (const module of chunk.modules) {
        if (!module.source.includes("localConversationCwd")
          || !module.source.includes("workspaceRoots")
          || !module.source.includes("activeWorkspaceRoot")
          || !module.source.includes("selectedRemoteProjectPath")
          || !module.source.includes("defaultCwd")
          || !module.source.includes("canUseProjectlessThreads")) continue;
        const native = hasRspackWorkspaceRootPropagation(
          module.source,
          relatedSource || chunk.source,
        );
        targets.push({
          platform: currentPlatform,
          path: chunk.file,
          moduleId: module.id,
          native,
          queryFiles: queries.map((entry) => entry.file),
        });
      }
    }

    const legacyRelatedSource = legacyQueryFiles
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    for (const entry of legacyFiles) {
      const native = hasNativeWorkspaceRootPropagation(
        entry.source,
        legacyRelatedSource || entry.source,
      );
      if (native) {
        targets.push({
          platform: currentPlatform,
          path: entry.file,
          native: true,
          kind: "legacy-native",
          queryFiles: legacyQueryFiles,
        });
      } else if (entry.source.includes(OLD_SNIPPET)
        || entry.source.includes(PATCHED_MARKER)) {
        targets.push({
          platform: currentPlatform,
          path: entry.file,
          source: entry.source,
          native: false,
          kind: "legacy",
        });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win"].includes(arg),
  );
  let targets;
  try {
    targets = findComposerBundles(platform);
  } catch (error) {
    console.log(`  [x] workspace roots: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (targets.length === 0) {
    console.log("  [x] No composer workspace-root resolver found");
    process.exitCode = 1;
    return;
  }

  let patched = 0;
  let failed = 0;
  for (const target of targets) {
    const label = `${relPath(target.path)}${target.moduleId ? `#${target.moduleId}` : ""}`;
    if (target.native) {
      const queries = [...new Set(target.queryFiles.map((file) => relPath(file)))];
      console.log(
        `  [ok] ${label}: native resolver consumes localConversationCwd, workspaceRoots and activeWorkspaceRoot`
        + (queries.length > 0 ? ` via ${queries.join(", ")}` : ""),
      );
      continue;
    }
    if (target.kind !== "legacy") {
      console.log(`  [x] ${label}: workspace-root code chain is incomplete`);
      failed++;
      continue;
    }
    if (target.source.includes(PATCHED_MARKER)) {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }

    const count = target.source.split(OLD_SNIPPET).length - 1;
    if (count !== 1) {
      console.log(`  [x] ${label}: expected 1 legacy patch site, found ${count}`);
      failed++;
      continue;
    }
    if (isCheck) {
      console.log(`  [?] ${label}: would patch legacy local workspace fallback`);
      patched++;
      continue;
    }

    const next = target.source.replace(OLD_SNIPPET, NEW_SNIPPET);
    try {
      parse(next, { ecmaVersion: "latest", sourceType: "module" });
    } catch (error) {
      console.log(`  [x] ${label}: invalid output: ${error.message}`);
      failed++;
      continue;
    }
    fs.writeFileSync(target.path, next, "utf-8");
    console.log(`  [ok] ${label}: legacy local workspace fallback patched`);
    patched++;
  }

  if (isCheck) {
    console.log(`  [check] ${patched} legacy composer bundle(s) would be patched`);
  } else {
    console.log(`  [done] ${patched} legacy composer bundle(s) patched`);
  }
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findComposerBundles,
  hasNativeWorkspaceRootPropagation,
  hasRspackWorkspaceRootPropagation,
};
