const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  resolveSyncDirectory,
  selectWindowsPackage,
  validateWindowsPackage,
} = require("./sync-upstream");

const ARM64_PACKAGE = {
  name: "OpenAI.Codex_26.715.10079.0_arm64__2p2nqsd0c76g0.msix",
};
const X64_PACKAGE = {
  name: "OpenAI.Codex_26.715.10079.0_x64__2p2nqsd0c76g0.msix",
};

test("同步缓存目录必须由维护入口显式提供", () => {
  const previous = process.env.CODEX_SYNC_DIR;
  delete process.env.CODEX_SYNC_DIR;
  try {
    assert.throws(() => resolveSyncDirectory(), /缺少 CODEX_SYNC_DIR/);
  } finally {
    if (previous == null) delete process.env.CODEX_SYNC_DIR;
    else process.env.CODEX_SYNC_DIR = previous;
  }
});

test("同步缓存目录解析显式环境变量", () => {
  const previous = process.env.CODEX_SYNC_DIR;
  process.env.CODEX_SYNC_DIR = ".cache-explicit-test";
  try {
    assert.equal(resolveSyncDirectory(), path.resolve(".cache-explicit-test"));
  } finally {
    if (previous == null) delete process.env.CODEX_SYNC_DIR;
    else process.env.CODEX_SYNC_DIR = previous;
  }
});

function createExtractDir(t, architecture, version = "26.715.10079.0") {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-msix-test-"));
  t.after(() => fs.rmSync(extractDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(extractDir, "AppxManifest.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="OpenAI.Codex" ProcessorArchitecture="${architecture}" Version="${version}" />
</Package>\n`
  );
  return extractDir;
}

test("ARM64 排在前面时仍选择 x64 MSIX", () => {
  assert.equal(selectWindowsPackage([ARM64_PACKAGE, X64_PACKAGE]), X64_PACKAGE);
});

test("没有 x64 MSIX 时直接失败", () => {
  assert.throws(
    () => selectWindowsPackage([ARM64_PACKAGE]),
    /No Windows x64 MSIX package found/
  );
});

test("不会把其他 x64 依赖包当成 Codex 主包", () => {
  assert.throws(
    () => selectWindowsPackage([{
      name: "Microsoft.VCLibs_14.0.0.0_x64__8wekyb3d8bbwe.msix",
    }]),
    /No Windows x64 MSIX package found/
  );
});

test("解压后的 x64 清单通过校验", (t) => {
  const extractDir = createExtractDir(t, "x64");
  assert.deepEqual(
    validateWindowsPackage(extractDir, {
      architecture: "x64",
      version: "26.715.10079.0",
    }),
    { architecture: "x64", version: "26.715.10079.0" }
  );
});

test("解压后的 ARM64 清单无法进入 x64 构建", (t) => {
  const extractDir = createExtractDir(t, "arm64");
  assert.throws(
    () => validateWindowsPackage(extractDir, {
      architecture: "x64",
      version: "26.715.10079.0",
    }),
    /architecture mismatch: expected x64, got arm64/
  );
});

test("包名版本和清单版本不一致时直接失败", (t) => {
  const extractDir = createExtractDir(t, "x64", "26.715.10080.0");
  assert.throws(
    () => validateWindowsPackage(extractDir, {
      architecture: "x64",
      version: "26.715.10079.0",
    }),
    /version mismatch: expected 26\.715\.10079\.0, got 26\.715\.10080\.0/
  );
});
