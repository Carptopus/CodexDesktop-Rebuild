const test = require("node:test");
const assert = require("node:assert/strict");
const { MARKER, patchSource } = require("./patch-hide-pet-menu");

function fixture() {
  return [
    "function Menu(e){",
    "let {isOverlayOpen:a,onTogglePet:b,petShortcut:c}=e;",
    "let item=b==null?null:(0,ui.jsx)(Pet,{isOverlayOpen:a,onTogglePet:b,petShortcut:c});",
    "return (0,ui.jsx)(`div`,{children:[item,settings,help]})}",
    "function Pet(e){",
    "let a={id:`codex.profileFooter.showPet`};",
    "let b={id:`codex.profileFooter.hidePet`};",
    "let c={id:`codex.profileFooter.showMini`};",
    "let d={id:`codex.profileFooter.hideMini`};",
    "return (0,ui.jsx)(Item,{onClick:e.onTogglePet,children:[a,b,c,d]})}",
  ].join("");
}

test("只隐藏账户菜单中的 Pet 入口", () => {
  const result = patchSource(fixture());

  assert.equal(result.status, "patched");
  assert.equal(result.count, 1);
  assert.match(result.source, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.source, /jsx\)\(Pet,\{isOverlayOpen:/);
  assert.match(result.source, /petShortcut:c/);
  assert.match(result.source, /onTogglePet:b/);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("Pet 组件存在但菜单调用结构未知时明确失败", () => {
  const source = fixture().replace(
    "(Pet,{isOverlayOpen:a,onTogglePet:b,petShortcut:c})",
    "(Pet,{isOverlayOpen:a,onTogglePet:b,shortcut:c})",
  );
  const result = patchSource(source);

  assert.equal(result.status, "unexpected-pet-menu-call-count");
  assert.equal(result.count, 0);
});

test("没有 Pet 功能的资源不适用", () => {
  assert.equal(patchSource("function menu(){return null}").status, "not-applicable");
});

test("只包含 Pet 本地化文案的资源不构成菜单目标", () => {
  const source = `const messages=${JSON.stringify(Object.fromEntries([
    "showPet",
    "hidePet",
    "showMini",
    "hideMini",
  ].map(name => [`codex.profileFooter.${name}`, name])))};`;

  assert.equal(patchSource(source).status, "not-applicable");
});
