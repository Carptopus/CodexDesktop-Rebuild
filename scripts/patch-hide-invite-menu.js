#!/usr/bin/env node
/** 只隐藏账户菜单中的邀请入口，保留官方邀请功能的其他路径。 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { applyEdits, key, literal, nodes } = require("./patch-ast-util");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "/* codex-rebuild-hide-invite-menu */";
const LABEL_IDS = [
  "codex.profileDropdown.inviteFriend",
  "codex.profileDropdown.inviteCoworker",
];

function patchSource(source) {
  if (!LABEL_IDS.every(id => source.includes(id))) return { status: "not-applicable", source };
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const components = ast.body.filter(node => node.type === "FunctionDeclaration" &&
    LABEL_IDS.every(id => nodes(node, child => literal(child) === id).length > 0));
  if (components.length !== 1) return { status: "unexpected-component-count", source };
  const calls = nodes(ast, node => {
    if (node.type !== "CallExpression" || node.arguments[0]?.type !== "Identifier" ||
        node.arguments[0].name !== components[0].id.name ||
        node.arguments[1]?.type !== "ObjectExpression") return false;
    const names = node.arguments[1].properties.filter(p => p.type === "Property").map(p => key(p.key));
    return names.length === 2 && names.includes("context") && names.includes("onSelect");
  });
  const markers = source.split(MARKER).length - 1;
  if (markers) {
    return { status: markers === 1 && calls.length === 0 && source.includes(MARKER + "null")
      ? "already-patched" : "unexpected-patched-shape", source };
  }
  if (calls.length !== 1) return { status: "unexpected-menu-call-count", source };
  const call = calls[0];
  return { status: "patched", source: applyEdits(source, [
    { start: call.start, end: call.end, text: MARKER + "null" },
  ]) };
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find(arg => ["mac-arm64", "mac-x64", "win"].includes(arg));
  const check = args.includes("--check");
  const targets = [];
  for (const name of platform ? [platform] : ["mac-arm64", "mac-x64", "win"]) {
    const directory = path.join(SRC_DIR, name, "_asar", "webview", "assets");
    if (!platform && !fs.existsSync(directory)) continue;
    const files = fs.existsSync(directory)
      ? fs.readdirSync(directory).filter(file => /^profile-dropdown-items-.*\.js$/.test(file)) : [];
    if (files.length !== 1) {
      throw new Error(`[${name}] 邀请菜单资源必须唯一`);
    }
    targets.push({ path: path.join(directory, files[0]) });
  }
  if (!targets.length) throw new Error("缺少邀请菜单目标资源，不能跳过补丁");
  for (const target of targets) {
    const result = patchSource(fs.readFileSync(target.path, "utf8"));
    if (!["patched", "already-patched"].includes(result.status)) {
      throw new Error(`${relPath(target.path)}: 邀请菜单结构未知（${result.status}）`);
    }
    if (result.status === "patched" && !check) fs.writeFileSync(target.path, result.source, "utf8");
    console.log(`[ok] ${relPath(target.path)}: ${check ? "邀请菜单隐藏检查通过，未写文件" : "邀请菜单入口已隐藏"}`);
  }
}

if (require.main === module) main();
module.exports = { MARKER, patchSource };
