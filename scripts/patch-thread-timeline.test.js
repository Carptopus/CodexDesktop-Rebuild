const test = require("node:test");
const assert = require("node:assert/strict");

const { MARKER, patchSource } = require("./patch-thread-timeline");

function fixture() {
  return [
    "function compatible(host,version){return host===`local`&&version>=150}",
    "class Store{constructor(host,version,gate){this.hostId=host;this.requestClient={getAppServerVersion:()=>version};",
    "this.settings={history:{readThreadTimelineEnabled:gate}}}",
    "get supportsThreadTimelineProxy(){return()=>this.supportsThreadTimeline()}",
    "supportsThreadTimeline(){return compatible(this.hostId,this.requestClient.getAppServerVersion())&&this.settings.history.readThreadTimelineEnabled()}}",
  ].join("");
}

function load(source) {
  return Function(`${source};return Store`)();
}

test("支持 timeline 的本地 CLI 不再依赖远端灰度开关", () => {
  const result = patchSource(fixture());
  assert.equal(result.status, "patched");
  assert.equal(result.source.split(MARKER).length - 1, 1);
  assert.equal(patchSource(result.source).status, "already-patched");

  let gateReads = 0;
  const Store = load(result.source);
  const supported = new Store("local", 163, () => { gateReads++; return false; });
  const unsupported = new Store("local", 149, () => { gateReads++; return true; });
  assert.equal(supported.supportsThreadTimeline(), true);
  assert.equal(unsupported.supportsThreadTimeline(), false);
  assert.equal(gateReads, 0, "补丁后不应读取远端灰度开关");
});

test("兼容判断变化时明确失败，不强行启用 timeline", () => {
  const source = fixture().replace(
    "compatible(this.hostId,this.requestClient.getAppServerVersion())",
    "compatible(this.requestClient.getAppServerVersion())",
  );
  const result = patchSource(source);
  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /灰度门槛结构异常/);
});

test("灰度条件变化时明确失败", () => {
  const source = fixture().replace("&&this.settings.history.readThreadTimelineEnabled()", "||this.settings.history.readThreadTimelineEnabled()");
  const result = patchSource(source);
  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /灰度门槛结构异常/);
});

test("残缺标记明确失败", () => {
  const result = patchSource(fixture() + MARKER);
  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /版本兼容判断|方法内/);
});

test("无关 Bundle 不适用", () => {
  const source = "class Other{supportsSomethingElse(){return true}}";
  const result = patchSource(source);
  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});
