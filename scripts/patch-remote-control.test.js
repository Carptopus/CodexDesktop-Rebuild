const assert = require("node:assert/strict");
const test = require("node:test");

const { findPatches, marker } = require("./patch-remote-control");

function applyPatches(source, patches) {
  let result = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, patch.start) + patch.replacement + result.slice(patch.end);
  }
  return result;
}

test("only opens Connections visibility and keeps Remote Control on its upstream gate", () => {
  const source = [
    "function connections(){return checkGate(`4114442250`)}",
    "function remoteControl(){return checkGate(`1042620455`)}",
  ].join("\n");

  const patches = findPatches(source);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].gateId, "4114442250");

  const result = applyPatches(source, patches);
  assert.match(result, new RegExp(marker("4114442250").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result, /remoteControl\(\)\{return checkGate\(`1042620455`\)\}/);
  assert.doesNotMatch(result, /codex-remote-gate:1042620455/);
  assert.equal(findPatches(result).length, 0);
});

test("does not patch a bundle that only contains the Remote Control data gate", () => {
  assert.deepEqual(findPatches("const enabled=checkGate(`1042620455`);"), []);
});
