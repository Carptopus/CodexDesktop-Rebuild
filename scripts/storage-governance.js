#!/usr/bin/env node
/** 本地存储治理：审计固定输出，清理可重建缓存，不触碰当前/上一版程序与正式验收记录。 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const testMode = process.env.CODEX_STORAGE_TEST_MODE === "1";
const root = testMode
  ? path.resolve(process.env.CODEX_STORAGE_TEST_ROOT || "")
  : path.resolve(__dirname, "..");
const tempRoot = testMode
  ? path.resolve(process.env.CODEX_STORAGE_TEST_TEMP || "")
  : os.tmpdir();
const forensicsRoot = testMode
  ? path.resolve(process.env.CODEX_STORAGE_TEST_FORENSICS || "")
  : path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir(), "CodexForensics");
const cacheRoot = path.join(root, ".cache");
const mode = process.argv[2] || "audit";
const DAY = 24 * 60 * 60 * 1000;
const LOG_LIMIT = testMode
  ? Number(process.env.CODEX_STORAGE_TEST_LOG_LIMIT || 16 * 1024 * 1024)
  : 16 * 1024 * 1024;
const FATAL_LOG_LIMIT = testMode
  ? Number(process.env.CODEX_STORAGE_TEST_FATAL_LOG_LIMIT || 1024 * 1024)
  : 1024 * 1024;
const OWNED_TEMP_PREFIXES = [
  "codex-accent-probe-", "codex-accent-theme-", "codex-cli-policy-test-",
  "codex-dmg-test-", "codex-external-overlay-test-", "codex-home-nav-",
  "codex-main-test-", "codex-maintenance-smoke-", "codex-msix-test-",
  "codex-nested-cli-test-", "codex-owl-integrity-test-", "codex-owl-launcher-test-",
  "codex-owl-manifest-test-", "codex-owl-test-", "codex-patch-report-",
  "codex-preview-smoke-", "codex-readonly-overlay-test-", "codex-sentry-test-",
  "codex-rebuild-", "rebuild-download-smoke-",
];

if (!root || !tempRoot || !forensicsRoot || !["audit", "clean"].includes(mode)) {
  throw new Error("用法：node scripts/storage-governance.js audit|clean");
}

function assertChild(target, parent, label) {
  const resolved = path.resolve(target);
  const boundary = path.resolve(parent);
  if (resolved !== boundary && !resolved.startsWith(boundary + path.sep)) {
    throw new Error(`${label} 越界：${resolved}`);
  }
  return resolved;
}

function removeOwned(target, parent, removed) {
  const resolved = assertChild(target, parent, "清理目标");
  if (resolved === path.resolve(parent)) throw new Error(`禁止删除治理根目录：${resolved}`);
  if (!fs.existsSync(resolved)) return;
  const item = fs.lstatSync(resolved);
  if (item.isSymbolicLink()) throw new Error(`禁止删除链接目标：${resolved}`);
  fs.rmSync(resolved, { recursive: item.isDirectory(), force: true });
  removed.push(resolved);
}

function directorySize(directory) {
  if (!fs.existsSync(directory)) return { files: 0, bytes: 0 };
  const pending = [directory];
  let files = 0, bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(file);
      else { files++; bytes += fs.statSync(file).size; }
    }
  }
  return { files, bytes };
}

function pruneCompletedAndExpiredParts(removed) {
  if (!fs.existsSync(cacheRoot)) return;
  const pending = [cacheRoot], now = Date.now();
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name.endsWith(".parts")) {
        const completed = item.slice(0, -".parts".length);
        if (fs.existsSync(completed) || now - fs.statSync(item).mtimeMs > 2 * DAY) {
          removeOwned(item, cacheRoot, removed);
        }
      } else pending.push(item);
    }
  }
}

function pruneRunDirectories(directory, removed, keep = 2, protectedNames = []) {
  if (!fs.existsSync(directory)) return;
  const protectedSet = new Set(protectedNames.map(name => name.toLowerCase()));
  const directories = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !protectedSet.has(entry.name.toLowerCase()))
    .map(entry => {
      const full = path.join(directory, entry.name);
      return { full, modified: fs.statSync(full).mtimeMs };
    })
    .sort((left, right) => right.modified - left.modified);
  for (const entry of directories.slice(keep)) removeOwned(entry.full, directory, removed);
}

function pruneDownloadRuns(removed, keep = 2) {
  pruneRunDirectories(path.join(cacheRoot, "downloads"), removed, keep);
  // 早期下载脚本和手工 gh 下载使用此目录；继续纳入同一保留规则。
  pruneRunDirectories(path.join(cacheRoot, "gh-downloads"), removed, keep);
}

function pruneAcceptanceRuns(removed, keep = 2) {
  pruneRunDirectories(path.join(cacheRoot, "acceptance"), removed, keep, ["staged-candidate"]);
  pruneRunDirectories(path.join(root, "acceptance"), removed, keep, ["staged-candidate"]);
}

function pruneOwnedTemp(removed) {
  if (!fs.existsSync(tempRoot)) return;
  const now = Date.now();
  for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !OWNED_TEMP_PREFIXES.some(prefix => entry.name.startsWith(prefix))) continue;
    const full = path.join(tempRoot, entry.name);
    if (now - fs.statSync(full).mtimeMs > DAY) removeOwned(full, tempRoot, removed);
  }
}

function compactFile(file, maximum, compacted) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return;
  const size = fs.statSync(file).size;
  if (size <= maximum) return;
  const buffer = Buffer.alloc(maximum);
  const handle = fs.openSync(file, "r");
  try { fs.readSync(handle, buffer, 0, maximum, size - maximum); }
  finally { fs.closeSync(handle); }
  fs.writeFileSync(file, buffer);
  compacted.push(file);
}

function pruneForensics(removed, compacted, keep = 7) {
  if (!fs.existsSync(forensicsRoot)) return;
  const logs = fs.readdirSync(forensicsRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^forensics-\d{4}-\d{2}-\d{2}\.log$/.test(entry.name))
    .map(entry => path.join(forensicsRoot, entry.name))
    .sort((left, right) => path.basename(right).localeCompare(path.basename(left)));
  for (const file of logs.slice(keep)) removeOwned(file, forensicsRoot, removed);
  for (const file of logs.slice(0, keep)) compactFile(file, LOG_LIMIT, compacted);
  compactFile(path.join(forensicsRoot, "chrome-debug.log"), LOG_LIMIT, compacted);
  compactFile(path.join(tempRoot, "codex-forensics-fatal.log"), FATAL_LOG_LIMIT, compacted);
}

function hasNestedLink(directory) {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

function pruneInterruptedBuilds(removed) {
  const buildRoot = path.join(root, "build");
  if (!fs.existsSync(buildRoot) || fs.existsSync(path.join(buildRoot, ".candidate-switch.lock"))) return;
  const hasProtectedVersions = ["Codex", "previous"].every(name =>
    fs.existsSync(path.join(buildRoot, name, "Codex.exe")));
  const now = Date.now();
  for (const entry of fs.readdirSync(buildRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const preparing = /^\.next-preparing-\d+$/.test(entry.name);
    const retired = /^\.previous-retired-\d+$/.test(entry.name);
    if (!preparing && !(retired && hasProtectedVersions)) continue;
    const full = path.join(buildRoot, entry.name);
    if (now - fs.statSync(full).mtimeMs <= DAY || hasNestedLink(full)) continue;
    removeOwned(full, buildRoot, removed);
  }
}

function pruneGeneratedOutputs(removed) {
  for (const name of ["src", "out", "patch-reports"]) {
    const target = path.join(root, name);
    if (fs.existsSync(target)) removeOwned(target, root, removed);
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^out-.+/.test(entry.name)) continue;
    removeOwned(path.join(root, entry.name), root, removed);
  }
}

function audit() {
  const paths = [
    cacheRoot,
    path.join(root, "build"),
    path.join(root, "src"),
    path.join(root, "out"),
    path.join(root, "patch-reports"),
    path.join(root, "artifacts"),
    path.join(root, "acceptance"),
    path.join(root, "release", "archive"),
    forensicsRoot,
  ];
  return paths.filter(file => fs.existsSync(file)).map(file => {
    const size = directorySize(file);
    return { path: file, files: size.files, mib: Number((size.bytes / 1048576).toFixed(1)) };
  });
}

const removed = [], compacted = [];
if (mode === "clean") {
  pruneCompletedAndExpiredParts(removed);
  pruneDownloadRuns(removed);
  pruneAcceptanceRuns(removed);
  pruneOwnedTemp(removed);
  pruneForensics(removed, compacted);
  pruneInterruptedBuilds(removed);
  pruneGeneratedOutputs(removed);
}
console.log(JSON.stringify({
  mode,
  policy: {
    downloadRuns: 2, acceptanceRuns: 2, incompletePartsDays: 2,
    forensicsLogs: 7, forensicsLogMiB: 16, fatalLogMiB: 1,
    ownedTempHours: 24, interruptedBuildHours: 24,
    generatedOutputs: ["src", "out", "out-*", "patch-reports"],
  },
  removed, compacted, usage: audit(),
}, null, 2));
