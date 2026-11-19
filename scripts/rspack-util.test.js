const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { rspackModules, moduleImports, moduleExports, findModuleCopies, replaceFrontendModule } = require("./rspack-util");

test("Rspack 注册表保留独立作用域、两类导出及各分块副本", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rspack-contract-"));
  try {
    fs.mkdirSync(path.join(directory, "async"));
    const source = 'export const __rspack_esm_ids=[1];export const __webpack_modules__={abcd(e,t,n){var x=n("deps");let a=1;n.d(t,{getter:()=>x.value},{direct:a})}};';
    const file = path.join(directory, "1.js"); fs.writeFileSync(file, source);
    fs.writeFileSync(path.join(directory, "async", "2.js"), source.replace("let a=1", "let a=2"));
    const modules = findModuleCopies(directory, "abcd");
    assert.equal(modules.length, 2);
    const target = modules.find(module => module.file === file);
    assert.deepEqual(moduleImports(target), [{ local: "x", id: "deps" }]);
    assert.deepEqual(moduleExports(target), [{ exported: "getter", value: "x.value" }, { exported: "direct", value: "a" }]);
    const output = replaceFrontendModule(target, target.source.replace("let a=1", "let a=3"), ['import "./runtime.js";']);
    assert.match(output, /^import "\.\/runtime.js";/);
    assert.equal(rspackModules(output)[0].source.includes("let a=3"), true);
    fs.writeFileSync(file, output);
    assert.throws(() => replaceFrontendModule(target, target.source), /定位后发生变化/);
    assert.throws(() => findModuleCopies(directory, "absent"), /依赖模块缺失/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
