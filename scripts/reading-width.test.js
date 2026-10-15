const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function readingModule() {
  return import(pathToFileURL(path.join(__dirname, "runtime", "reading-width.mjs")).href);
}

test.afterEach(() => {
  delete globalThis.localStorage;
});

test("正文宽度提供 50% 到 100% 的 5% 步进", async () => {
  const reading = await readingModule();
  assert.equal(reading.MIN_WIDTH_PERCENT, 50);
  assert.equal(reading.MAX_WIDTH_PERCENT, 100);
  assert.equal(reading.WIDTH_STEP, 5);
  assert.deepEqual(reading.WIDTHS, ["50", "55", "60", "65", "70", "75", "80", "85", "90", "95", "100"]);
});

test("所有百分比都保留官方宽度下限且不接受旧 default", async () => {
  const { WIDTHS, readingCss } = await readingModule();
  for (const width of WIDTHS) {
    const css = readingCss(width);
    assert.match(css, new RegExp(`max\\(48rem,${width}%\\)`));
    assert.match(css, new RegExp(`max\\(40rem,${width}%\\)`));
  }
  assert.throws(() => readingCss("default"), /未知的正文宽度档位/);
});

test("外观设置使用范围滑杆并将无效旧值回落到 50%", async () => {
  const reading = await readingModule();
  const values = new Map([[reading.STORAGE_KEY, "default"]]);
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const react = {
    Fragment: Symbol("Fragment"),
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
  };
  const ui = {
    jsx: (type, props, key) => ({ type, props, key }),
    jsxs: (type, props, key) => ({ type, props, key }),
  };
  const Row = () => null;
  const tree = reading.renderReadingWidth(react, ui, Row, { locale: "zh-CN" });
  const widthRow = tree.props.children[0];
  const [slider, output] = widthRow.props.control.props.children;
  assert.equal(slider.type, "input");
  assert.equal(slider.props.type, "range");
  assert.equal(slider.props.min, 50);
  assert.equal(slider.props.max, 100);
  assert.equal(slider.props.step, 5);
  assert.equal(slider.props.value, "50");
  assert.equal(output.props.children, "50%");
});
