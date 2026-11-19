/** Windows 真实产物检查：同包工具、原生组件及隔离桌面启动。 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { sha256 } = require("./windows-artifacts");

function peMachine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, 64, 0) !== 64 || header.readUInt16LE(0) !== 0x5a4d) throw new Error(`无效 MZ：${file}`);
    const offset = header.readUInt32LE(60), pe = Buffer.alloc(6);
    if (offset + 6 > fs.fstatSync(fd).size || fs.readSync(fd, pe, 0, 6, offset) !== 6 || pe.readUInt32LE(0) !== 0x4550) throw new Error(`无效 PE：${file}`);
    return pe.readUInt16LE(4);
  } finally { fs.closeSync(fd); }
}

function isolatedEnvironment(root) {
  const env = {};
  for (const key of ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATH", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  for (const [key, name] of Object.entries({ CODEX_HOME: "codex-home", USERPROFILE: "profile", APPDATA: "profile/AppData/Roaming", LOCALAPPDATA: "profile/AppData/Local", TEMP: "profile/AppData/Local/Temp", TMP: "profile/AppData/Local/Temp" })) {
    env[key] = path.join(root, name); fs.mkdirSync(env[key], { recursive: true });
  }
  for (const name of ["Desktop", "Documents", "Downloads", "AppData/LocalLow"]) fs.mkdirSync(path.join(env.USERPROFILE, name), { recursive: true });
  return env;
}

function run(file, args, cwd, env) {
  return execFileSync(file, args, { cwd, env, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }).trim();
}

function filesUnder(root, predicate) {
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`运行组件路径不能经过链接：${file}`);
    if (entry.isDirectory()) results.push(...filesUnder(file, predicate));
    else if (entry.isFile() && predicate(file)) results.push(file);
  }
  return results;
}

async function inspectComponents(app, originalApp, output) {
  const env = isolatedEnvironment(path.join(output, "component-smoke"));
  const resources = path.join(app, "resources"), binaries = [];
  const targets = ["Codex.exe", "resources/codex.exe", "resources/codex-code-mode-host.exe", "resources/rg.exe", "resources/cua_node/bin/node.exe"];
  const chrome = "resources/plugins/openai-bundled/plugins/chrome/extension-host/windows/x64/extension-host.exe";
  if (fs.existsSync(path.join(originalApp, chrome))) targets.push(chrome);
  for (const relative of ["resources/cua_node/bin/node_repl.exe",
    "resources/cua_node/bin/node_modules/@oai/cua/bin/windows/codex-computer-use.exe",
    "resources/cua_node/bin/node_modules/@oai/sky/bin/windows/codex-computer-use.exe",
    "resources/cua_node/bin/node_modules/@oai/sky/bin/windows/swift/x64/codex-computer-use-swift.exe"]) {
    if (fs.existsSync(path.join(originalApp, relative))) targets.push(relative);
  }
  const nativeFiles = filesUnder(resources, file => file.endsWith(".node")
    && !/(?:[\\/](?:android[^\\/]*|darwin[^\\/]*|linux[^\\/]*|win32-(?:arm64|ia32)[^\\/]*|windows[\\/](?:arm64|x86))(?:[\\/]|$)|-(?:darwin|linux|android|win32-arm64|win32-ia32))/i.test(file));
  if (!nativeFiles.length) throw new Error("候选没有 Windows 原生模块");
  targets.push(...nativeFiles.map(file => path.relative(app, file)));
  for (const relative of targets) {
    const file = path.join(app, relative), original = path.join(originalApp, relative);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`关键运行组件缺失：${relative}`);
    if (peMachine(file) !== 0x8664) throw new Error(`关键运行组件不是 x64：${relative}`);
    const hash = await sha256(file);
    if (relative !== "Codex.exe") {
      if (!fs.existsSync(original) || await sha256(original) !== hash) throw new Error(`同包运行组件被改动：${relative}`);
    }
    binaries.push({ file: relative.replaceAll("\\", "/"), size: fs.statSync(file).size, machine: "x64", sha256: hash, originalMatch: relative !== "Codex.exe" });
  }
  const codeModeHelp = run(path.join(resources, "codex-code-mode-host.exe"), ["--help"], resources, env);
  if (!codeModeHelp.includes("--listen")) throw new Error("code-mode-host 未返回预期帮助");
  const rgVersion = run(path.join(resources, "rg.exe"), ["--version"], resources, env);
  const fixture = path.join(output, "component-smoke", "search.txt");
  fs.writeFileSync(fixture, "ordinary\n辅助工具验证\n", "utf8");
  const search = run(path.join(resources, "rg.exe"), ["--fixed-strings", "--line-number", "辅助工具验证", fixture], resources, env);
  if (search !== "2:辅助工具验证") throw new Error("rg 中文搜索未通过");
  const cua = path.join(resources, "cua_node", "bin");
  const cuaImport = run(path.join(cua, "node.exe"), ["--input-type=module", "-e", 'await import("@oai/sky"); console.log("CUA_IMPORT_OK")'], cua, env);
  if (!cuaImport.includes("CUA_IMPORT_OK")) throw new Error("CUA 原生组件加载未通过");
  return { passed: true, binaries, codeModeHelp, rgVersion, rgSearch: search, cuaImport,
    note: "基础启动/加载检查通过，尚不代表实际代码模式任务或 GUI 业务验收通过" };
}

async function inspectDesktop(app, output) {
  const root = path.join(output, "desktop-smoke"), env = isolatedEnvironment(root);
  const executable = path.join(app, "Codex.exe"), cli = path.join(app, "resources", "codex.exe");
  Object.assign(env, { CODEX_REBUILD_TEST_ROOT: root, CODEX_REBUILD_SMOKE_EXIT: "1", CODEX_ELECTRON_USER_DATA_PATH: path.join(root, "electron-user-data"), CODEX_CLI_PATH: cli });
  const proofPath = path.join(root, "desktop-smoke.json");
  if (fs.existsSync(proofPath)) throw new Error("桌面冒烟目录存在旧证据");
  const child = spawn(executable, [`--user-data-dir=${env.CODEX_ELECTRON_USER_DATA_PATH}`, "--enable-logging=stderr"], { cwd: app, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-64000); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-64000); });
  let exited = false, exitCode, spawnError;
  child.on("error", error => { spawnError = error; });
  child.on("exit", code => { exited = true; exitCode = code; });
  let proof;
  try {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (fs.existsSync(proofPath)) {
        proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
        if (proof.failure) throw new Error(`桌面启动失败：${proof.failure}`);
        if (proof.windowLoaded) break;
      }
      if (exited && !proof?.windowLoaded) throw new Error(`候选提前退出，未获得窗口加载证据；退出码 ${exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const isolationFile = path.join(root, "isolation-runtime.json");
    if (!proof?.windowLoaded || !fs.existsSync(isolationFile)) throw new Error("桌面窗口/隔离 ready 证据缺失");
    const isolation = JSON.parse(fs.readFileSync(isolationFile, "utf8"));
    if (path.resolve(isolation.codexHome) !== path.resolve(env.CODEX_HOME)
      || path.resolve(isolation.userData) !== path.resolve(env.CODEX_ELECTRON_USER_DATA_PATH)
      || path.resolve(isolation.sessionData) !== path.resolve(env.CODEX_ELECTRON_USER_DATA_PATH)
      || ![executable, path.join(app, "ChatGPT.exe")].some(file => path.resolve(file).toLowerCase() === path.resolve(isolation.executable).toLowerCase())
      || isolation.pid !== proof.pid) throw new Error("桌面冒烟实际程序/数据路径不一致");
    const exitDeadline = Date.now() + 15000;
    while (!exited && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 250));
    if (!exited || exitCode !== 0) throw new Error(`候选未正常退出：${exitCode}`);
    return { passed: true, isolation, proof, note: "隔离空数据窗口启动检查，不代替登录、Provider、数据恢复等人工验收" };
  } catch (error) {
    const records = {};
    for (const name of ["desktop-smoke.json", "isolation-runtime.json", "isolation-hook.json", "startup-error.json", "native-startup-error.json", "test-environment.json", "app-exit.json", "process-exit.json"]) {
      const file = path.join(root, name); if (fs.existsSync(file)) records[name] = fs.readFileSync(file, "utf8");
    }
    const priority = file => /CodexForensics|startup-error|isolation-hook/.test(file) ? 0 : /\.(?:log|jsonl)$/.test(file) ? 1 : 2;
    const logs = filesUnder(root, file => /\.(?:log|jsonl)$/.test(file) && !/^\d+\.log$/.test(path.basename(file))).sort((a,b) => priority(a)-priority(b));
    for (const file of logs.slice(0, 12)) {
      const size = fs.statSync(file).size, fd = fs.openSync(file, "r");
      try {
        const tail = Buffer.alloc(Math.min(size, 64000)); fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
        records[path.relative(root, file)] = tail.toString("utf8");
      } finally { fs.closeSync(fd); }
    }
    error.desktopDiagnostic = { executable, pid: child.pid, exitCode, stdout, stderr, records };
    throw error;
  } finally {
    // 仅清理由本次候选路径创建的进程，不能终止当前正式 Codex。
    if (!exited) child.kill();
    execFileSync("pwsh", ["-NoProfile", "-Command", "$prefix=$env:REBUILD_SMOKE_APP + [IO.Path]::DirectorySeparatorChar; $items=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) }); foreach($item in $items){ Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500; $remaining=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) }); if($remaining.Count){throw '候选进程残留'}"],
      { env: { ...process.env, REBUILD_SMOKE_APP: path.resolve(app) }, windowsHide: true, timeout: 15000, stdio: "pipe" });
  }
}

module.exports = { peMachine, isolatedEnvironment, inspectComponents, inspectDesktop };
