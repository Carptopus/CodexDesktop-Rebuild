const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { randomUUID } = require("crypto");

const { findUpdates, resolveVersionFile, main } = require("./check-update");

const CURRENT_PLATFORMS = [
  { platform: "macOS-arm64", version: "26.721.41059", build: "5848" },
  { platform: "macOS-x64", version: "26.721.41059", build: "5848" },
  { platform: "Windows", version: "26.721.4979.0", build: "" },
];

const SAVED_VERSIONS = {
  "macOS-arm64": { version: "26.721.41059", build: "5848" },
  "macOS-x64": { version: "26.721.41059", build: "5848" },
  Windows: { version: "26.721.4979.0" },
};

test("各平台版本与各自记录一致时不触发更新", () => {
  assert.deepEqual(findUpdates(CURRENT_PLATFORMS, SAVED_VERSIONS), []);
});

test("Windows 单独更新时仍触发构建", () => {
  const platforms = CURRENT_PLATFORMS.map((info) =>
    info.platform === "Windows"
      ? { ...info, version: "26.721.5000.0" }
      : info
  );

  assert.deepEqual(
    findUpdates(platforms, SAVED_VERSIONS).map((info) => info.platform),
    ["Windows"]
  );
});

test("不同平台版本号不同不会造成重复更新", () => {
  assert.notEqual(
    SAVED_VERSIONS["macOS-arm64"].version,
    SAVED_VERSIONS.Windows.version
  );
  assert.equal(findUpdates(CURRENT_PLATFORMS, SAVED_VERSIONS).length, 0);
});

test("可以为 CI 指定持久化版本记录", () => {
  assert.equal(
    resolveVersionFile(["--state-file", ".github/upstream-versions.json"]),
    path.resolve(process.cwd(), ".github/upstream-versions.json")
  );
});

test("缺少状态文件路径时直接失败", () => {
  assert.throws(
    () => resolveVersionFile(["--state-file", "--json"]),
    /需要提供文件路径/
  );
});

test("检测不完整时 JSON 报错、退出码为 2 且不保存部分结果", async () => {
  const testRoot = process.env.CODEX_REBUILD_TEST_ROOT || os.tmpdir();
  const dir = path.join(testRoot, `check-update-${randomUUID()}`);
  const stateFile = path.join(dir, "versions.json");
  const saved = { Windows: { version: "26.721.4979.0" } };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(saved));
  const output = [];
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const previousError = console.error;

  try {
    process.exitCode = 0;
    console.log = (line) => output.push(line);
    console.error = () => {};
    const result = await main({
      args: ["--json", "--save", "--state-file", stateFile],
      checkers: [
        async () => CURRENT_PLATFORMS[0],
        async () => CURRENT_PLATFORMS[1],
        async () => { throw new Error("Store unavailable"); },
      ],
    });

    const json = JSON.parse(output[0]);
    assert.equal(json.hasUpdates, null);
    assert.deepEqual(json.errors, { Windows: "Store unavailable" });
    assert.equal(result.errors.Windows, "Store unavailable");
    assert.equal(process.exitCode, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf-8")), saved);
  } finally {
    process.exitCode = previousExitCode;
    console.log = previousLog;
    console.error = previousError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
