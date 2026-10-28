#!/usr/bin/env node
/** Windows 候选链：固定输入、诊断出包与正式晋升校验。 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { writeJson, sha256, validateSource, verifySourceFile, confinedFile } = require("./windows-artifacts");
const root = path.resolve(__dirname, "..");
const requiredChecks = [
  "isolation", "start-exit", "authentication", "thread-history", "provider-switch",
  "model-catalog", "home-navigation", "provider-quota", "service-tier", "thread-timeline",
  "mcp-refresh", "pet-menu", "remote-control", "compaction", "archive-delete", "browser-auth",
  "plugins-skills", "worker-config", "updater-disabled", "program-rollback", "data-restore",
  "reading-layout",
];

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function argsOf(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`无效参数：${args[i]}`);
    }
    options[args[i].slice(2)] = args[i + 1];
  }
  return options;
}

function runScript(name, args = [], env = {}) {
  execFileSync(process.execPath, [path.join(__dirname, name), ...args], {
    cwd: root, env: { ...process.env, ...env }, stdio: "inherit",
  });
}

function output(name, value) {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function discover(options) {
  const { getWindowsVersion, resolveSyncDirectory } = require("./sync-upstream");
  const info = await getWindowsVersion(options.version);
  if (!Number.isSafeInteger(info.size) || info.size <= 0 || !info.storeDigest) {
    throw new Error("Store 没有提供可验证的包大小或摘要");
  }
  const discoveryFile = options.out
    ? path.resolve(options.out)
    : path.join(resolveSyncDirectory(), "windows-discovery.json");
  writeJson(discoveryFile, {
    schemaVersion: 1, ...info, checkedAt: new Date().toISOString(),
  });
  let approvedVersion = "";
  if (options["stable-manifest"]) {
    const prior = readJson(options["stable-manifest"]);
    if (prior.schemaVersion !== 1 || !/^\d+(?:\.\d+){3}$/.test(prior.upstream?.version || "")) {
      throw new Error("历史候选版本记录无效，不能据此跳过构建");
    }
    approvedVersion = prior.upstream.version;
  }
  output("version", info.version);
  output("has_update", String(info.version !== approvedVersion));
}

async function verifyStoreDigest(file, expected) {
  // Windows Update File/Digest 是 SHA-1；未知格式明确拒绝，不能跳过校验。
  const bytes = Buffer.from(expected, "base64");
  if (bytes.length !== 20) throw new Error("未知 Store 摘要格式，需要核对来源接口");
  const hash = crypto.createHash("sha1");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (!hash.digest().equals(bytes)) throw new Error("下载文件与 Store 摘要不符");
}

async function prepareSource(options, directory) {
  if (options.source) {
    const source = validateSource(readJson(path.resolve(options.source)));
    const file = options.msix ? path.resolve(options.msix)
      : confinedFile(path.dirname(path.resolve(options.source)), source.packageName);
    await verifySourceFile(source, file);
    const destination = confinedFile(directory, source.packageName);
    if (path.resolve(file) !== path.resolve(destination)) fs.copyFileSync(file, destination);
    writeJson(path.join(directory, "upstream.json"), source);
    return source;
  }
  if (!options.discovery) throw new Error("候选需要 --discovery，或 --source 加已归档的 MSIX");
  const discovery = readJson(path.resolve(options.discovery));
  const file = confinedFile(directory, discovery.packageName);
  const url = new URL(discovery.url);
  if (discovery.architecture !== "x64" || !["http:", "https:"].includes(url.protocol)
    || !/(^|\.)delivery\.mp\.microsoft\.com$/i.test(url.hostname)) {
    throw new Error("下载来源必须是微软官方 Windows Update CDN 的 x64 主包");
  }
  execFileSync("curl.exe", ["--fail", "--location", "--retry", "3", "--retry-delay", "2",
    "--connect-timeout", "30", "--max-time", "900", "--output", file, discovery.url], { stdio: "inherit" });
  if (fs.statSync(file).size !== discovery.size) throw new Error("MSIX 下载大小不符");
  await verifyStoreDigest(file, discovery.storeDigest);
  const source = validateSource({ ...discovery, sha256: await sha256(file) });
  writeJson(path.join(directory, "upstream.json"), source);
  return source;
}

function inspectUpdater(asarRoot) {
  const { auditUpdaterSource } = require("./patch-updater");
  const directory = path.join(asarRoot, ".vite", "build");
  const methods = [];
  for (const name of fs.readdirSync(directory).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(directory, name), "utf8");
    if (!/shouldInclude(?:Sparkle|WindowsUpdater|WindowsMsixUpdater|Updater)/.test(source)) continue;
    methods.push(...auditUpdaterSource(source).map((method) => ({ file: name, ...method })));
  }
  const windowsMethods = methods.filter((method) => method.name !== "shouldIncludeSparkle");
  return { methods, disabled: windowsMethods.length > 0 && windowsMethods.every((method) => method.disabled) };
}

function findFilesNamed(directory, expectedName) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name === expectedName) files.push(fullPath);
    }
  }
  return files.sort();
}

function saveCompatibilityEvidence(
  asarRoot,
  source,
  destination = path.join(root, "patch-reports", "source-evidence"),
) {
  const signatures = ["shouldIncludeUpdater", "shouldIncludeWindowsUpdater", "shouldIncludeWindowsMsixUpdater",
    "FlyoutSubmenuItem", "flyoutHeader", "data-model-picker-model-row", "data-model-picker-view", "modelListConfig",
    "serviceTierAccess", "Failed to read service tier for request"];
  const functionalSignatures = ["mcpServer/startupStatus/updated", "mention-discovery",
    "Failed to sync local remote control enablement", "set-remote-control-connections-enabled",
    "remote-connections/gate-bridge", "isConfigDataPending", "codex.profileFooter.settingsFallback",
    "chatgptAccentPicker.ChatGptAccentPicker.updateError", "--color-image-generation-accent"];
  const files = [];
  for (const [label, directory] of [["main", ".vite/build"], ["webview", "webview/assets"]]) {
    const sourceDirectory = path.join(asarRoot, directory);
    for (const name of fs.readdirSync(sourceDirectory).filter((name) => /\.(?:js|css)$/.test(name))) {
      const file = path.join(sourceDirectory, name);
      const text = fs.readFileSync(file, "utf8");
      const matches = [...signatures, ...functionalSignatures, "settings.appearance.visualStyle", "--thread-content-expanded-max-width", "--markdown-wide-block-max-width"]
        .filter((signature) => text.includes(signature));
      const startupEvidence = label === "main" && /^(?:early-bootstrap|startup-requirements|application-network-startup)/.test(name);
      const settingsBridgeEvidence = label === "main" &&
        (text.includes("isTrustedIpcEvent") && text.includes("getContextForWebContents") ||
          name === "preload.js" && text.includes("electronBridge") && text.includes("exposeInMainWorld"));
      // 新版会在三个入口 chunk 之间移动实现；诊断必须包含共享定义与实际功能块。
      const frontendEvidence = label === "webview" &&
        (/^app-(?:initial|primary|shared)-.*\.js$/.test(name) ||
          name.endsWith(".js") && matches.some(match => functionalSignatures.includes(match)));
      if (!matches.length && !startupEvidence && !frontendEvidence && !settingsBridgeEvidence) continue;
      const copied = label === "main" ? require("./patch-updater").auditUpdaterSource(text).length > 0
        : matches.includes("flyoutHeader") || matches.includes("data-model-picker-model-row")
          || matches.includes("data-model-picker-view") && matches.includes("modelListConfig");
      const serviceTierEvidence = matches.includes("serviceTierAccess") &&
        matches.includes("Failed to read service tier for request");
      const readingEvidence = matches.includes("settings.appearance.visualStyle") || name.endsWith(".css") && matches.some(match => match.startsWith("--"));
      if (copied || serviceTierEvidence || readingEvidence || startupEvidence || frontendEvidence || settingsBridgeEvidence) {
        fs.mkdirSync(path.join(destination, label), { recursive: true });
        fs.copyFileSync(file, path.join(destination, label, name));
      }
      files.push({ directory, name, matches, copied: copied || serviceTierEvidence || readingEvidence || startupEvidence || frontendEvidence || settingsBridgeEvidence, sha256: crypto.createHash("sha256").update(text).digest("hex") });
    }
  }

  const platformRoot = path.dirname(asarRoot);
  const browserSignatures = [
    "codex_browser_use_agent_request_header",
    "Browser request-header policy requires caller identity.",
    "Browser feature gates require caller identity.",
    "agentRequestHeaderEnabled",
    "getExtensionRequestHeaders",
    "readRequirements",
    "requestHeadersVersion",
    "request_headers",
  ];
  for (const resourceName of ["plugins", "cua_node"]) {
    const resourceRoot = path.join(platformRoot, resourceName);
    for (const file of findFilesNamed(resourceRoot, "browser-service.mjs")) {
      const text = fs.readFileSync(file, "utf8");
      const relative = path.relative(platformRoot, file);
      const copiedFile = path.join(destination, "external", relative);
      fs.mkdirSync(path.dirname(copiedFile), { recursive: true });
      fs.copyFileSync(file, copiedFile);
      files.push({
        directory: path.dirname(relative).replaceAll("\\", "/"),
        name: path.basename(file),
        matches: browserSignatures.filter((signature) => text.includes(signature)),
        copied: true,
        sha256: crypto.createHash("sha256").update(text).digest("hex"),
      });
    }
  }
  writeJson(path.join(destination, "index.json"), { schemaVersion: 1, upstream: source, files,
    note: "原始官方资源片段，不含用户配置；用于精确适配，不能代表 GUI 已验收" });
}

function releaseGate(check, apply, updater) {
  const blocks = [];
  for (const report of [check, apply]) {
    if (!report.canBuild || report.errors.length) blocks.push(`${report.mode}: 补丁执行失败`);
    for (const item of report.results) {
      if (!item.required) continue;
      if (item.status !== "passed" || item.noticeSummary?.some((notice) => notice.kind === "review")) {
        blocks.push(`${report.mode}/${item.script}: 必要补丁失败或待核对`);
      }
    }
  }
  if (!updater.disabled) blocks.push("Windows 更新关闭状态尚未证实");
  return { canPromote: blocks.length === 0, blocks };
}

async function cliHandshake(cli, codexHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ["app-server"], {
      env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "", stderr = "", settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error); else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error(`app-server 握手超时：${stderr.slice(-1000)}`)), 30000);
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.on("exit", (code) => { if (!settled) finish(new Error(`app-server 提前退出：${code}; ${stderr.slice(-1000)}`)); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 1) continue;
        if (message.error || !message.result) finish(new Error(`app-server 初始化失败：${line}`));
        else {
          child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
          finish(null, { passed: true, result: message.result });
        }
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {
      clientInfo: { name: "codex-rebuild-smoke", version: "1.0.0" }, capabilities: { experimentalApi: true },
    } }) + "\n");
  });
}

async function inspectOutput(appDirectory, source, reports, directory) {
  const { inspectComponents, inspectDesktop } = require("./windows-runtime-checks");
  const { findUpstreamCodex } = require("./codex-binary-policy");
  const { computeAsarHeaderHash } = require("./build-from-upstream");
  const resources = path.join(appDirectory, "resources");
  const asar = path.join(resources, "app.asar");
  const cli = findUpstreamCodex("win", resources, "codex.exe");
  if (!cli || !fs.existsSync(path.join(appDirectory, "Codex.exe"))) throw new Error("产物缺少 launcher 或官方 CLI");
  const cliSource = findUpstreamCodex("win", path.join(root, "src", "win"), "codex.exe");
  if (!cliSource || await sha256(cli) !== await sha256(cliSource)) throw new Error("官方 CLI 被替换或损坏");
  const codexHome = path.join(directory, "cli-smoke-home");
  fs.mkdirSync(codexHome, { recursive: true });
  const cliVersion = execFileSync(cli, ["--version"], {
    env: { ...process.env, CODEX_HOME: codexHome }, encoding: "utf8", timeout: 30000, windowsHide: true,
  }).trim();
  const handshake = await cliHandshake(cli, codexHome);
  const headerHash = computeAsarHeaderHash(asar);
  const executables = ["Codex.exe", "ChatGPT.exe"].filter((name) => fs.existsSync(path.join(appDirectory, name)));
  const integrityHashEmbedded = executables.some((name) => fs.readFileSync(path.join(appDirectory, name)).includes(Buffer.from(headerHash)));
  const signatures = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-Command",
    "$items=@(Get-ChildItem -LiteralPath $env:REBUILD_APP_PATH -Filter '*.exe' -File | ForEach-Object { $s=Get-AuthenticodeSignature -LiteralPath $_.FullName; [pscustomobject]@{file=$_.Name;status=[string]$s.Status} }); ConvertTo-Json -InputObject $items -Compress"],
  { env: { ...process.env, REBUILD_APP_PATH: appDirectory }, encoding: "utf8" }));
  const updater = inspectUpdater(path.join(root, "src", "win", "_asar"));
  const gate = releaseGate(reports.check, reports.apply, updater);
  let components, desktopSmoke;
  try {
    const originalApp = path.join(process.env.CODEX_SYNC_DIR, "win-extract", "app");
    components = await inspectComponents(appDirectory, originalApp, directory);
    desktopSmoke = await inspectDesktop(appDirectory, directory);
    writeJson(path.join(root, "patch-reports", "runtime-checks.json"), { components, desktopSmoke });
  } catch (error) {
    writeJson(path.join(root, "patch-reports", "runtime-checks.json"), { components, desktopSmoke, passed: false, error: error.message, desktopDiagnostic: error.desktopDiagnostic });
    throw error;
  }
  // 缺少嵌入哈希可能是官方关闭校验，也可能是结构漂移；留诊断，禁止静默晋升。
  if (!integrityHashEmbedded) { gate.canPromote = false; gate.blocks.push("EXE 中未找到最终 ASAR 哈希，需要核对 runtime 完整性契约"); }
  return { schemaVersion: 1, upstream: source, cliVersion, cliSha256: await sha256(cli),
    cliInitialize: handshake, asarHeaderSha256: headerHash, integrityHashEmbedded,
    signatures, updater, components, desktopSmoke, gate, guiValidated: false };
}

async function candidate(options) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "win32") {
    throw new Error("完整 Windows 候选构建只在 GitHub Actions Windows runner 执行");
  }
  const directory = path.resolve(options.out || "artifacts/candidate");
  if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error("候选输出目录非空，不能覆盖已有产物");
  fs.mkdirSync(directory, { recursive: true });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim()) {
    throw new Error("构建源码存在未提交修改，无法绑定候选提交");
  }
  const source = await prepareSource(options, directory);
  const syncDirectory = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `codex-rebuild-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  process.env.CODEX_SYNC_DIR = syncDirectory;
  process.env.CODEX_REQUIRE_PINNED_SOURCE = "1";
  fs.mkdirSync(syncDirectory, { recursive: true });
  const { syncWin } = require("./sync-upstream");
  // 这个导入前 discovery 进程已经结束；当前进程的缓存路径在导入前明确固定。
  await syncWin(path.join(root, "src", "win"), { ...source, localPackage: path.join(directory, source.packageName) });
  saveCompatibilityEvidence(path.join(root, "src", "win", "_asar"), source);
  const checkDirectory = path.join(root, "patch-reports", "windows-check");
  const applyDirectory = path.join(root, "patch-reports", "windows-apply");
  runScript("patch-all.js", ["win", "--check", "--report", checkDirectory]);
  runScript("patch-all.js", ["win", "--report", applyDirectory]);
  runScript("settings-persistence-smoke.js", []);
  writeJson(path.join(root, "patch-reports", "frontend-source-checks.json"), require("./frontend-source-smoke").verifyFrontendSource(path.join(root, "src", "win", "_asar", "webview", "assets")));
  runScript("build-from-upstream.js", ["--platform", "win", "--defer-zip"]);
  const reports = { check: readJson(path.join(checkDirectory, "report.json")), apply: readJson(path.join(applyDirectory, "report.json")) };
  const verified = await inspectOutput(path.join(root, "out", "win", "Codex-win32-x64"), source, reports, directory);
  require("./build-from-upstream").createZip(path.join(root, "out", "Codex-verified.zip"), path.join(root, "out", "win", "Codex-win32-x64"));
  const files = fs.readdirSync(path.join(root, "out")).filter((file) => file.endsWith(".zip"));
  if (files.length !== 1) throw new Error("Windows ZIP 数量必须为 1");
  const revision = readJson(path.join(root, "package.json")).codexRebuildRevision;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("维护修订号必须在源码中固定为正整数");
  const zipName = `Codex-win-x64-${source.version}-r${revision}-${sourceCommit.slice(0, 8)}.zip`;
  fs.copyFileSync(path.join(root, "out", files[0]), path.join(directory, zipName));
  const zipHash = await sha256(path.join(directory, zipName));
  const metadata = { schemaVersion: 1, repository: process.env.GITHUB_REPOSITORY, sourceCommit,
    runId: String(process.env.GITHUB_RUN_ID), runAttempt: String(process.env.GITHUB_RUN_ATTEMPT),
    createdAt: new Date().toISOString(), upstream: source, zip: { name: zipName, sha256: zipHash, size: fs.statSync(path.join(directory, zipName)).size },
    revision, desktopVersion: reports.apply.upstream.win.version, gate: verified.gate };
  writeJson(path.join(directory, "candidate.json"), metadata);
  writeJson(path.join(directory, "verify-report.json"), verified);
  fs.writeFileSync(path.join(directory, "SHA256SUMS.txt"), `${zipHash}  ${zipName}\n${source.sha256}  ${source.packageName}\n`);
  writeJson(path.join(directory, "acceptance-template.json"), { schemaVersion: 1, sourceCommit,
    zipSha256: zipHash, runId: metadata.runId, tester: "", testedAt: "",
    isolationEvidence: "", rollbackEvidence: "", checks: Object.fromEntries(requiredChecks.map((name) => [name, "pending"])),
    notes: "填写实际结果；不能因脚本成功把 GUI 验收改为 passed。" });
  fs.rmSync(codexSmokeHome(directory), { recursive: true, force: true });
  for (const name of ["component-smoke", "desktop-smoke"]) fs.rmSync(path.join(directory, name), { recursive: true, force: true });
  output("zip_sha256", zipHash);
  output("can_promote", String(metadata.gate.canPromote));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\n## Windows 候选\n\n- MSIX: ${source.version}\n- CLI: ${verified.cliVersion}\n- ZIP SHA-256: \`${zipHash}\`\n- 自动发布门槛: ${metadata.gate.canPromote ? "通过，仍需 GUI 验收" : metadata.gate.blocks.join("；")}\n`);
}

function codexSmokeHome(directory) { return path.join(directory, "cli-smoke-home"); }

async function verifyRelease(options) {
  const directory = path.resolve(options.dir || "artifacts/candidate");
  const metadata = readJson(path.join(directory, "candidate.json"));
  const report = readJson(path.join(directory, "verify-report.json"));
  const approval = readJson(path.resolve(options.acceptance || "acceptance.json"));
  const hash = await sha256(confinedFile(directory, metadata.zip.name));
  if (metadata.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(metadata.sourceCommit || "")
    || !Number.isSafeInteger(metadata.revision) || metadata.revision < 1
    || !/^\d+$/.test(metadata.runId || "") || !/^\d+$/.test(metadata.runAttempt || "")
    || metadata.zip.size !== fs.statSync(confinedFile(directory, metadata.zip.name)).size
    || metadata.repository !== (options.repository || process.env.GITHUB_REPOSITORY)
    || hash !== metadata.zip.sha256 || hash !== options["zip-sha256"]
    || metadata.runId !== options["run-id"]
    || options["source-commit"] && metadata.sourceCommit !== options["source-commit"]
    || options["run-attempt"] && metadata.runAttempt !== options["run-attempt"]) throw new Error("候选源码、运行记录或 ZIP 哈希不一致");
  validateSource(metadata.upstream);
  await verifySourceFile(metadata.upstream, confinedFile(directory, metadata.upstream.packageName));
  if (JSON.stringify(readJson(path.join(directory, "upstream.json"))) !== JSON.stringify(metadata.upstream)
    || JSON.stringify(report.upstream) !== JSON.stringify(metadata.upstream)) throw new Error("来源记录不一致");
  if (!metadata.gate.canPromote || !report.gate.canPromote || metadata.gate.blocks.length || report.gate.blocks.length
    || !report.cliInitialize.passed || !report.updater.disabled || !report.integrityHashEmbedded
    || !report.components?.passed || !report.desktopSmoke?.passed) throw new Error("候选自动发布门槛未通过");
  if (approval.schemaVersion !== 1 || approval.sourceCommit !== metadata.sourceCommit
    || approval.zipSha256 !== hash || approval.runId !== metadata.runId
    || !approval.tester?.trim() || !Number.isFinite(Date.parse(approval.testedAt))
    || !approval.isolationEvidence?.trim() || !approval.rollbackEvidence?.trim()
    || requiredChecks.some((name) => approval.checks?.[name] !== "passed")) throw new Error("GUI/隔离/回退验收缺失或仍未通过");
  fs.copyFileSync(path.resolve(options.acceptance || "acceptance.json"), path.join(directory, "acceptance.json"));
  const tag = `win-${metadata.upstream.version}-r${metadata.revision}-${metadata.sourceCommit.slice(0, 8)}`;
  output("tag", tag);
  output("source_commit", metadata.sourceCommit);
  output("zip_name", metadata.zip.name);
  console.log("正式晋升校验通过：使用已验收原 ZIP，不重新构建");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = argsOf(args);
  if (command === "discover") await discover(options);
  else if (command === "candidate") await candidate(options);
  else if (command === "verify-release") await verifyRelease(options);
  else throw new Error("用法：windows-maintenance.js <discover|candidate|verify-release> [--参数 值]");
}
if (require.main === module) main().catch((error) => { console.error(`[error] ${error.message}`); process.exitCode = 1; });
module.exports = { findFilesNamed, requiredChecks, saveCompatibilityEvidence };
