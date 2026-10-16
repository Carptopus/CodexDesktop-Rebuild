#!/usr/bin/env node
/** 可重复的维护链功能测试：使用合成制品与 Electron 替身，不宣称 GUI 已验收。 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { requiredChecks, saveCompatibilityEvidence } = require("./windows-maintenance");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-maintenance-smoke-"));
const scriptRoot = __dirname;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const json = (file, value) => write(file, JSON.stringify(value));
let checks = 0;
function run(script, args, expected = 0, env = {}) {
  const result = spawnSync(process.execPath, [path.join(scriptRoot, script), ...args], {
    encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "false", GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", ...env },
  });
  assert.equal(result.error, undefined);
  if (expected === 0) assert.equal(result.status, 0, result.stdout + result.stderr);
  else assert.notEqual(result.status, 0, "本应拒绝此输入");
  checks++;
  return result;
}
try {
  if (process.platform === "win32") {
    const env = require("./windows-runtime-checks").isolatedEnvironment(path.join(temporary, "native-profile"));
    const native = spawnSync("pwsh", ["-NoProfile", "-Command", "[pscustomobject]@{appData=[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData);local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)}|ConvertTo-Json -Compress"], { env, encoding: "utf8" });
    assert.equal(native.status, 0, native.stderr);
    const actual = JSON.parse(native.stdout);
    assert.equal(path.resolve(actual.appData).toLowerCase(), env.APPDATA.toLowerCase());
    assert.equal(path.resolve(actual.local).toLowerCase(), env.LOCALAPPDATA.toLowerCase()); checks++;
  }
  run("windows-maintenance.js", ["candidate"], 1);
  const discoveryPreload = path.join(temporary, "discovery-preload.cjs");
  write(discoveryPreload, `const target=require.resolve(${JSON.stringify(path.join(scriptRoot, "fetch-msstore.js"))}); require.cache[target]={id:target,filename:target,loaded:true,exports:{getCookie:async()=>"cookie",getAppInfo:async()=>({categoryId:"fixture"}),getFileList:async()=>["26.1007.9446.0","26.917.71314.0","26.1007.2314.0"].map(v=>({name:"OpenAI.Codex_"+v+"_x64__2p2nqsd0c76g0.msix",size:"10",digest:Buffer.alloc(20).toString("base64"),updateID:v,revisionNumber:"1"})),getDownloadUrl:async()=>"https://tlu.dl.delivery.mp.microsoft.com/fixture.msix"}};`);
  const discoveryOutput = path.join(temporary, "discovery.json");
  const observed = path.join(temporary, "observed.json");
  json(observed, { schemaVersion: 1, upstream: { version: "26.1007.9446.0" } });
  const discovered = spawnSync(process.execPath, ["--require", discoveryPreload, path.join(scriptRoot, "windows-maintenance.js"), "discover", "--out", discoveryOutput, "--stable-manifest", observed], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } });
  assert.equal(discovered.status, 0, discovered.stderr);
  assert.match(discovered.stdout, /has_update=false/);
  assert.equal(JSON.parse(fs.readFileSync(discoveryOutput)).version, "26.1007.9446.0");
  checks++;
  json(observed, { schemaVersion: 1, upstream: { version: "26.1007.2314.0" } });
  const changed = spawnSync(process.execPath, ["--require", discoveryPreload, path.join(scriptRoot, "windows-maintenance.js"), "discover", "--out", discoveryOutput, "--stable-manifest", observed], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } });
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /has_update=true/);
  checks++;
  for (const mode of ["commonjs", "module"]) {
    const source = path.join(temporary, mode, "src");
    const asar = path.join(source, "win", "_asar");
    const testRoot = path.join(temporary, mode, "isolated");
    json(path.join(asar, "package.json"), { type: mode, main: "bootstrap.js" });
    const nativeImport = mode === "module" ? 'import {app} from "electron";' : 'const {app}=require("electron");';
    write(path.join(asar, "bootstrap.js"), '"use strict";\n' + nativeImport + '\nfunction resolveUserData({env}){return env.CODEX_ELECTRON_USER_DATA_PATH;} app.setName("fixture"),app.setPath("userData",resolveUserData({env:process.env})); app.requestSingleInstanceLock(); console.log("fixture started");\n');
    const mock = 'let data="",session="",named=false; exports.app={setName:()=>named=true,setPath:(k,v)=>{if(!named)throw Error("Owl path API too early");if(k==="userData")data=v;if(k==="sessionData")session=v;},getPath:k=>k==="sessionData"?session:data,requestSingleInstanceLock:()=>{if(session!==data)throw Error("sessionData not isolated before lock");return true;},whenReady:()=>Promise.resolve(),exit:()=>{process.exitCode=1;}};';
    json(path.join(asar, "node_modules", "electron", "package.json"), { type: "commonjs", main: "index.js" });
    write(path.join(asar, "node_modules", "electron", "index.js"), mock);
    const entry = path.join(asar, "bootstrap.js");
    const before = fs.readFileSync(entry);
    run("patch-test-isolation.js", ["win", "--check"], 0, { CODEX_PATCH_SOURCE_DIR: source });
    assert.deepEqual(fs.readFileSync(entry), before);
    run("patch-test-isolation.js", ["win"], 0, { CODEX_PATCH_SOURCE_DIR: source });
    const patched = fs.readFileSync(entry);
    run("patch-test-isolation.js", ["win"], 0, { CODEX_PATCH_SOURCE_DIR: source });
    assert.deepEqual(fs.readFileSync(entry), patched);
    const started = spawnSync(process.execPath, [entry], { encoding: "utf8", env: { ...process.env, CODEX_REBUILD_TEST_ROOT: testRoot } });
    assert.equal(started.status, 0, started.stderr);
    const proof = JSON.parse(fs.readFileSync(path.join(testRoot, "isolation-runtime.json")));
    assert.equal(proof.codexHome, path.join(testRoot, "codex-home"));
    assert.equal(proof.userData, path.join(testRoot, "electron-user-data"));
    assert.ok(fs.readFileSync(entry, "utf8").startsWith('"use strict";'));
    checks++;
    write(entry, '"use strict";\nconsole.log("unknown native bootstrap");\n');
    run("patch-test-isolation.js", ["win", "--check"], 1, { CODEX_PATCH_SOURCE_DIR: source });
  }
  const updaterSource = path.join(temporary, "updater", "win", "_asar", ".vite", "build");
  write(path.join(updaterSource, "gates.js"), 'const gates={shouldIncludeWindowsUpdater(){return true},shouldIncludeWindowsMsixUpdater(){return true},shouldIncludeUpdater(){return true}};');
  run("patch-updater.js", ["win"], 0, { CODEX_PATCH_SOURCE_DIR: path.join(temporary, "updater") });
  assert.equal((fs.readFileSync(path.join(updaterSource, "gates.js"), "utf8").match(/return !1/g) || []).length, 3);
  write(path.join(updaterSource, "caller.js"), "gates.shouldIncludeUpdater(1,2,3);");
  const callerResult = run("patch-updater.js", ["win"], 0, { CODEX_PATCH_SOURCE_DIR: path.join(temporary, "updater") });
  assert.match(callerResult.stdout, /call sites only/);
  assert.doesNotMatch(callerResult.stdout, /\[!\]/);
  fs.unlinkSync(path.join(updaterSource, "caller.js"));
  write(path.join(updaterSource, "gates.js"), "const changed=true;");
  assert.match(run("patch-updater.js", ["win"], 0, { CODEX_PATCH_SOURCE_DIR: path.join(temporary, "updater") }).stdout, /\[!\]/);

  const evidencePlatform = path.join(temporary, "evidence", "win");
  const evidenceAsar = path.join(evidencePlatform, "_asar");
  const evidenceOutput = path.join(temporary, "evidence-output");
  write(path.join(evidenceAsar, ".vite", "build", "early-bootstrap.js"), "const startup=true;");
  write(path.join(evidenceAsar, "webview", "assets", "app.js"), "const app=true;");
  const browserService = [
    'const gate="codex_browser_use_agent_request_header";',
    "async function read(){try{return await feature(gate)}catch{return!1}}",
  ].join("");
  for (const plugin of ["browser", "chrome"]) {
    write(
      path.join(
        evidencePlatform,
        "plugins",
        "openai-bundled",
        "plugins",
        plugin,
        "scripts",
        "browser-service.mjs",
      ),
      browserService,
    );
  }
  saveCompatibilityEvidence(evidenceAsar, { version: "fixture" }, evidenceOutput);
  const evidenceIndex = JSON.parse(fs.readFileSync(path.join(evidenceOutput, "index.json"), "utf8"));
  const browserEvidence = evidenceIndex.files.filter((item) => item.name === "browser-service.mjs");
  assert.equal(browserEvidence.length, 2);
  assert(browserEvidence.every((item) => item.copied));
  assert(browserEvidence.every((item) => item.matches.includes("codex_browser_use_agent_request_header")));
  assert.equal(
    fs.existsSync(path.join(
      evidenceOutput,
      "external",
      "plugins",
      "openai-bundled",
      "plugins",
      "browser",
      "scripts",
      "browser-service.mjs",
    )),
    true,
  );
  checks++;

  const pickerRoot = path.join(temporary, "picker");
  const pickerFile = path.join(pickerRoot, "win", "_asar", "webview", "assets", "model-picker.js");
  const nativePicker = 'function picker(input){const {modelListConfig:list,menuView:view,onToggleMenuView:toggle}=input;const items=list.options.map(option=>ui.jsx(menu.Item,{"data-model-selected":option.selected,role:`menuitemradio`,onSelect:event=>{event.preventDefault();option.onSelect();toggle(`simple`)}}));return ui.jsx("div",{"data-model-picker-view":view,children:items});}';
  write(pickerFile, nativePicker);
  const nativeCheck = run("patch-model-picker-submenu.js", ["win", "--check"], 0, { CODEX_PATCH_SOURCE_DIR: pickerRoot });
  assert.match(nativeCheck.stdout, /native inline model list verified/);
  run("patch-model-picker-submenu.js", ["win"], 0, { CODEX_PATCH_SOURCE_DIR: pickerRoot });
  assert.equal(fs.readFileSync(pickerFile, "utf8"), nativePicker);
  write(pickerFile, nativePicker.replace("event.preventDefault();", ""));
  run("patch-model-picker-submenu.js", ["win"], 1, { CODEX_PATCH_SOURCE_DIR: pickerRoot });
  write(pickerFile, nativePicker.replace("ui.jsx(\"div\"", "ui.jsx(menu.FlyoutSubmenuItem"));
  run("patch-model-picker-submenu.js", ["win"], 1, { CODEX_PATCH_SOURCE_DIR: pickerRoot });

  const candidate = path.join(temporary, "candidate");
  const zip = Buffer.from("synthetic ZIP payload for promotion checks");
  const msix = Buffer.from("synthetic official source for provenance checks");
  const sha = "1".repeat(40);
  const source = { schemaVersion: 1, version: "26.1007.9446.0", architecture: "x64", packageName: "OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0.msix", size: msix.length, sha256: hash(msix) };
  const metadata = { schemaVersion: 1, repository: "Carptopus/CodexDesktop-Rebuild", sourceCommit: sha, runId: "123", runAttempt: "1", revision: 1, upstream: source,
    zip: { name: "candidate.zip", size: zip.length, sha256: hash(zip) }, gate: { canPromote: true, blocks: [] } };
  const report = { upstream: source, gate: metadata.gate, cliInitialize: { passed: true }, updater: { disabled: true }, integrityHashEmbedded: true, components: { passed: true }, desktopSmoke: { passed: true } };
  const approval = { schemaVersion: 1, sourceCommit: sha, zipSha256: hash(zip), runId: "123", tester: "fixture", testedAt: "2026-10-14T12:00:00Z", isolationEvidence: "synthetic proof", rollbackEvidence: "synthetic proof", checks: Object.fromEntries(requiredChecks.map((name) => [name, "passed"])) };
  write(path.join(candidate, "candidate.zip"), zip);
  write(path.join(candidate, source.packageName), msix);
  json(path.join(candidate, "upstream.json"), source);
  json(path.join(candidate, "candidate.json"), metadata);
  json(path.join(candidate, "verify-report.json"), report);
  const acceptance = path.join(temporary, "approval.json");
  json(acceptance, approval);
  const arguments = ["verify-release", "--dir", candidate, "--acceptance", acceptance, "--repository", metadata.repository,
    "--run-id", "123", "--run-attempt", "1", "--source-commit", sha, "--zip-sha256", hash(zip)];
  run("windows-maintenance.js", arguments);
  for (const key of ["components", "desktopSmoke"]) {
    for (const value of [undefined, { passed: false }]) {
      json(path.join(candidate, "verify-report.json"), { ...report, [key]: value });
      run("windows-maintenance.js", arguments, 1);
    }
  }
  json(path.join(candidate, "verify-report.json"), report);
  for (const key of requiredChecks) {
    json(acceptance, { ...approval, checks: { ...approval.checks, [key]: "pending" } });
    run("windows-maintenance.js", arguments, 1);
  }
  json(acceptance, approval);
  write(path.join(candidate, "candidate.zip"), "changed ZIP");
  run("windows-maintenance.js", arguments, 1);
  write(path.join(candidate, "candidate.zip"), zip);
  write(path.join(candidate, source.packageName), "changed MSIX");
  run("windows-maintenance.js", arguments, 1);
  write(path.join(candidate, source.packageName), msix);
  json(path.join(candidate, "candidate.json"), { ...metadata, gate: { canPromote: false, blocks: ["necessary patch needs review"] } });
  run("windows-maintenance.js", arguments, 1);
  json(path.join(candidate, "candidate.json"), metadata);
  run("windows-maintenance.js", arguments.map((value) => value === "123" ? "999" : value), 1);
  run("windows-maintenance.js", arguments.map((value) => value === sha ? "2".repeat(40) : value), 1);

  const storageRoot = path.join(temporary, "storage-project");
  const storageTemp = path.join(temporary, "storage-temp");
  const storageForensics = path.join(temporary, "storage-forensics");
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  for (const name of ["100", "200", "300"]) {
    write(path.join(storageRoot, ".cache", "downloads", name, "payload.bin"), name);
    fs.utimesSync(path.join(storageRoot, ".cache", "downloads", name), old, new Date(old.getTime() + Number(name)));
    write(path.join(storageRoot, ".cache", "gh-downloads", name, "payload.bin"), name);
    fs.utimesSync(path.join(storageRoot, ".cache", "gh-downloads", name), old, new Date(old.getTime() + Number(name)));
    write(path.join(storageRoot, ".cache", "acceptance", name, "profile.bin"), name);
    fs.utimesSync(path.join(storageRoot, ".cache", "acceptance", name), old, new Date(old.getTime() + Number(name)));
  }
  write(path.join(storageRoot, ".cache", "downloads", "300", "payload.zip"), "done");
  write(path.join(storageRoot, ".cache", "downloads", "300", "payload.zip.parts", "0.part"), "duplicate");
  write(path.join(storageRoot, "build", "Codex", "Codex.exe"), "protected");
  write(path.join(storageRoot, "build", "previous", "Codex.exe"), "protected previous");
  for (const directory of ["src", "out", "out-win", "patch-reports"]) write(path.join(storageRoot, directory, "generated.bin"), "generated");
  for (const name of [".next-preparing-123", ".previous-retired-123"]) {
    write(path.join(storageRoot, "build", name, "Codex.exe"), "interrupted");
    fs.utimesSync(path.join(storageRoot, "build", name), old, old);
  }
  for (let day = 1; day <= 9; day++) write(path.join(storageForensics, `forensics-2026-10-${String(day).padStart(2, "0")}.log`), String(day));
  write(path.join(storageForensics, "chrome-debug.log"), "x".repeat(64));
  write(path.join(storageForensics, "forensics-2026-10-09.log"), "x".repeat(64));
  write(path.join(storageTemp, "codex-forensics-fatal.log"), "x".repeat(64));
  write(path.join(storageTemp, "codex-main-test-old", "fixture"), "old");
  fs.utimesSync(path.join(storageTemp, "codex-main-test-old"), old, old);
  write(path.join(storageTemp, "codex-rebuild-old", "fixture"), "old");
  fs.utimesSync(path.join(storageTemp, "codex-rebuild-old"), old, old);
  const storageEnv = { CODEX_STORAGE_TEST_MODE: "1", CODEX_STORAGE_TEST_ROOT: storageRoot,
    CODEX_STORAGE_TEST_TEMP: storageTemp, CODEX_STORAGE_TEST_FORENSICS: storageForensics,
    CODEX_STORAGE_TEST_LOG_LIMIT: "32", CODEX_STORAGE_TEST_FATAL_LOG_LIMIT: "16" };
  run("storage-governance.js", ["clean"], 0, storageEnv);
  assert.equal(fs.existsSync(path.join(storageRoot, ".cache", "downloads", "100")), false);
  assert.equal(fs.existsSync(path.join(storageRoot, ".cache", "downloads", "200")), true);
  assert.equal(fs.existsSync(path.join(storageRoot, ".cache", "gh-downloads", "100")), false);
  assert.equal(fs.existsSync(path.join(storageRoot, ".cache", "acceptance", "100")), false);
  assert.equal(fs.existsSync(path.join(storageRoot, ".cache", "downloads", "300", "payload.zip.parts")), false);
  assert.equal(fs.readFileSync(path.join(storageRoot, "build", "Codex", "Codex.exe"), "utf8"), "protected");
  assert.equal(fs.readFileSync(path.join(storageRoot, "build", "previous", "Codex.exe"), "utf8"), "protected previous");
  assert.equal(fs.existsSync(path.join(storageRoot, "build", ".next-preparing-123")), false);
  assert.equal(fs.existsSync(path.join(storageRoot, "build", ".previous-retired-123")), false);
  for (const directory of ["src", "out", "out-win", "patch-reports"]) assert.equal(fs.existsSync(path.join(storageRoot, directory)), false);
  assert.equal(fs.existsSync(path.join(storageTemp, "codex-main-test-old")), false);
  assert.equal(fs.existsSync(path.join(storageTemp, "codex-rebuild-old")), false);
  assert.equal(fs.readdirSync(storageForensics).filter(name => /^forensics-\d{4}-\d{2}-\d{2}\.log$/.test(name)).length, 7);
  assert.equal(fs.statSync(path.join(storageForensics, "chrome-debug.log")).size, 32);
  assert.equal(fs.statSync(path.join(storageForensics, "forensics-2026-10-09.log")).size, 32);
  assert.equal(fs.statSync(path.join(storageTemp, "codex-forensics-fatal.log")).size, 16);
  checks++;

  if (process.platform === "win32") {
    const archiveProject = path.join(temporary, "archive-project");
    const archiveScript = path.join(archiveProject, "local", "scripts", "Archive-Candidate.ps1");
    fs.mkdirSync(path.dirname(archiveScript), { recursive: true });
    fs.copyFileSync(path.join(scriptRoot, "..", "local", "scripts", "Archive-Candidate.ps1"), archiveScript);
    for (let index = 1; index <= 3; index++) {
      const candidateDirectory = path.join(archiveProject, `candidate-${index}`);
      const zipName = `candidate-${index}.zip`, packageName = `source-${index}.msix`;
      const zipPayload = `zip-${index}`, packagePayload = `msix-${index}`;
      write(path.join(candidateDirectory, zipName), zipPayload);
      write(path.join(candidateDirectory, packageName), packagePayload);
      json(path.join(candidateDirectory, "candidate.json"), {
        schemaVersion: 1, repository: "Carptopus/CodexDesktop-Rebuild",
        sourceCommit: String(index).repeat(40),
        upstream: { version: `1.0.0.${index}`, packageName, sha256: hash(packagePayload) },
        zip: { name: zipName, sha256: hash(zipPayload) },
      });
      const archived = spawnSync("pwsh", ["-NoProfile", "-File", archiveScript, "-CandidateDirectory", candidateDirectory, "-Keep", "2"], { encoding: "utf8" });
      assert.equal(archived.status, 0, archived.stdout + archived.stderr);
      const destination = path.join(archiveProject, "release", "archive", `1.0.0.${index}-${String(index).repeat(40)}`);
      fs.utimesSync(destination, new Date(2020, 0, index), new Date(2020, 0, index));
    }
    const kept = fs.readdirSync(path.join(archiveProject, "release", "archive")).sort();
    assert.deepEqual(kept, [`1.0.0.2-${"2".repeat(40)}`, `1.0.0.3-${"3".repeat(40)}`]);
    checks++;
  }
  console.log(`维护链功能测试通过：${checks} 个 CLI 场景；实际 GUI、原始 MSIX 和签名由候选验收覆盖。`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
