const test = require("node:test");
const assert = require("node:assert/strict");
const { patchSource } = require("./patch-diff-limits");

test("新版 diff 默认和显式上限均限制为 8 MiB", async () => {
  const source = 'const diffArgs=["diff","--no-ext-diff"];async function run(root,args,host,options={}){let{binary:b=!1,maxOutputBytes:limit,configOverrides:c=[],...rest}=options,cap=limit==null?0x2000000:Math.min(limit,0x2000000);return execute(root,[...diffArgs,...args],host,{...rest,configOverrides:c,maxOutputBytes:cap})}';
  const result = patchSource(source);
  assert.equal(result.status, "patched");
  assert.equal(patchSource(result.source).status, "already-patched");
  const run = new Function("execute", `${result.source};return run`)((root, args, host, options) => options.maxOutputBytes);
  assert.equal(await run("r", [], "h"), 8 * 1024 * 1024);
  assert.equal(await run("r", [], "h", { maxOutputBytes: 1024 }), 1024);
  assert.equal(await run("r", [], "h", { maxOutputBytes: 64 * 1024 * 1024 }), 8 * 1024 * 1024);
  assert.equal(patchSource(source.replace("Math.min(limit,0x2000000)", "Math.min(limit,8*1024*1024)")).status, "unexpected-anchor-count");
  assert.equal(patchSource(source + source.slice(source.indexOf("async function")).replace("function run", "function other")).status, "unexpected-anchor-count");
  assert.equal(patchSource(source.replace("maxOutputBytes:cap", "maxOutputBytes:limit")).status, "unexpected-anchor-count");
});
