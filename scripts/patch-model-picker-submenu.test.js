const test = require("node:test");
const assert = require("node:assert/strict");

const { inspectNativeModelList, patchSource } = require("./patch-model-picker-submenu");

function createBundle(extraProps = "", trailingProps = "") {
  return [
    "function renderPicker(input){",
    `const {ariaLabel:aria,label:label,value:value,children:children,disabled:disabled,${extraProps}contentClassName:contentClassName,flyoutHeader:flyoutHeader${trailingProps}}=input;`,
    "let inline=submenu;if(nativeInline())return inline;let flyout;",
    "return flyout;",
    "}",
  ].join("");
}

for (const [name, source] of [
  ["旧版参数结构", createBundle()],
  ["含 labelOnly 的新版参数结构", createBundle("labelOnly:labelOnly,")],
  [
    "含 onOpenChange 的新版参数结构",
    createBundle("labelOnly:labelOnly,", ",onOpenChange:onOpenChange"),
  ],
]) {
  test(`模型选择器子菜单补丁兼容${name}`, () => {
    const result = patchSource(source);

    assert.equal(result.status, "patched");
    assert.match(
      result.source,
      /if\(label\?\.props\?\.\[`data-model-picker-model-row`\]===!0\|\|typeof nativeInline===`function`&&nativeInline\(\)\)/,
    );
    assert.equal(patchSource(result.source).status, "already-patched");
  });
}

test("模型选择器子菜单补丁拒绝缺失标签锚点的结构", () => {
  const source = createBundle().replace("label:label,", "");
  const result = patchSource(source);

  assert.equal(result.status, "unexpected-row-props-count");
  assert.equal(result.count, 0);
});

test("新版模型选择器以 for-of 直接生成可点击的单选行时安全跳过", () => {
  const source = [
    "function Picker({modelListConfig:config,menuView:view,onToggleMenuView:toggle}){",
    "let rows=[];for(const model of config.options){",
    "rows.push(jsx(UI.Item,{\"data-model-selected\":model.selected,",
    "role:\"menuitemradio\",onSelect:event=>{",
    "event.preventDefault();model.onSelect();toggle(\"simple\")},children:model.label},model.id))}",
    "return jsx(\"div\",{\"data-model-picker-view\":view,children:rows})}",
  ].join("");
  assert.deepEqual(inspectNativeModelList(source), {
    functionName: "Picker",
    directRows: 1,
  });
  assert.equal(inspectNativeModelList(source.replace("event.preventDefault();", "")), null);
  assert.equal(
    inspectNativeModelList(source.replace(
      "let rows=[];",
      "let rows=[jsx(UI.ms.FlyoutSubmenuItem,{})];",
    )),
    null,
  );
});
