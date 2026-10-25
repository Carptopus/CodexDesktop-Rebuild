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
  const discoveryCache = path.join(temporary, "discovery-cache");
  const observed = path.join(temporary, "observed.json");
  json(observed, { schemaVersion: 1, upstream: { version: "26.1007.9446.0" } });
  const discovered = spawnSync(process.execPath, ["--require", discoveryPreload, path.join(scriptRoot, "windows-maintenance.js"), "discover", "--out", discoveryOutput, "--stable-manifest", observed], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } });
  assert.equal(discovered.status, 0, discovered.stderr);
  assert.match(discovered.stdout, /has_update=false/);
  assert.equal(JSON.parse(fs.readFileSync(discoveryOutput)).version, "26.1007.9446.0");
  checks++;
  const missingDiscoveryCache = spawnSync(process.execPath, ["--require", discoveryPreload, path.join(scriptRoot, "windows-maintenance.js"), "discover"], {
    encoding: "utf8", env: { ...process.env, CODEX_SYNC_DIR: "", GITHUB_OUTPUT: "" },
  });
  assert.notEqual(missingDiscoveryCache.status, 0);
  assert.match(missingDiscoveryCache.stderr, /缺少 CODEX_SYNC_DIR/);
  const cachedDiscovery = spawnSync(process.execPath, ["--require", discoveryPreload, path.join(scriptRoot, "windows-maintenance.js"), "discover"], {
    encoding: "utf8", env: { ...process.env, CODEX_SYNC_DIR: discoveryCache, GITHUB_OUTPUT: "" },
  });
  assert.equal(cachedDiscovery.status, 0, cachedDiscovery.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(discoveryCache, "windows-discovery.json"))).version, "26.1007.9446.0");
  checks += 2;
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
    if (mode === "commonjs") {
      run("patch-crash-forensics.js", ["win", "--check"], 0, { CODEX_PATCH_SOURCE_DIR: source });
      assert.deepEqual(fs.readFileSync(entry), patched);
      run("patch-crash-forensics.js", ["win"], 0, { CODEX_PATCH_SOURCE_DIR: source });
      const combined = fs.readFileSync(entry);
      assert.ok(combined.indexOf('require("./codex-rebuild-test-environment.cjs")') < combined.indexOf("__CODEX_CRASH_FORENSICS_V4__"));
      run("patch-test-isolation.js", ["win", "--check"], 0, { CODEX_PATCH_SOURCE_DIR: source });
      run("patch-crash-forensics.js", ["win"], 0, { CODEX_PATCH_SOURCE_DIR: source });
      assert.deepEqual(fs.readFileSync(entry), combined, "隔离与诊断组合重复应用不能继续改写入口");
      checks++;
    }
    const started = spawnSync(process.execPath, [entry], { encoding: "utf8", env: { ...process.env, CODEX_REBUILD_TEST_ROOT: testRoot,
      LOCALAPPDATA: path.join(testRoot, "diagnostics") } });
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
  const frontendEvidence = [
    ["app-shared-fixture.js", "const sharedDefinitions=true;"],
    ["composer-content-fixture.js", "const composer={isConfigDataPending:false};"],
    ["remote-control-fixture.js", "const event='set-remote-control-connections-enabled';"],
    ["app-theme-fixture.js", "const theme={'--color-image-generation-accent':'blue'};"],
  ];
  for (const [name, source] of frontendEvidence) {
    write(path.join(evidenceAsar, "webview", "assets", name), source);
  }
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
  for (const [name, source] of frontendEvidence) {
    const entry = evidenceIndex.files.find(file => file.name === name);
    assert.equal(entry?.copied, true, `缺少新版独立功能块取证：${name}`);
    const copied = fs.readFileSync(path.join(evidenceOutput, "webview", name), "utf8");
    assert.equal(copied, source);
    assert.equal(entry.sha256, hash(copied));
  }
  checks++;
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

  const missingRequiredRoot = path.join(temporary, "missing-required-targets");
  fs.mkdirSync(path.join(missingRequiredRoot, "win", "_asar", "webview", "assets"), { recursive: true });
  run("patch-hide-pet-menu.js", ["win", "--check"], 1, { CODEX_PATCH_SOURCE_DIR: missingRequiredRoot });
  run("patch-hide-invite-menu.js", ["win", "--check"], 1, { CODEX_PATCH_SOURCE_DIR: missingRequiredRoot });
  run("patch-sidebar-usage.js", ["win", "--check"], 1, { CODEX_PATCH_SOURCE_DIR: missingRequiredRoot });
  run("sidebar-usage-smoke.js", []);
  run("patch-model-picker-submenu.js", ["win", "--check"], 1, { CODEX_PATCH_SOURCE_DIR: missingRequiredRoot });
  fs.writeFileSync(
    path.join(missingRequiredRoot, "win", "_asar", "webview", "assets", "archived-list.js"),
    "client.sendRequest(`thread/list`,{archived:!0,modelProviders:null});",
  );
  run("patch-archive-delete.js", ["win", "--check"], 1, { CODEX_PATCH_SOURCE_DIR: missingRequiredRoot });

  const inviteRoot = path.join(temporary, "invite-menu");
  const inviteFile = path.join(inviteRoot, "win", "_asar", "webview", "assets", "profile-dropdown-items-fixture.js");
  const inviteSource = 'function Invite(){return {id:`codex.profileDropdown.inviteFriend`,other:`codex.profileDropdown.inviteCoworker`}};function menu(){return [ui.jsx(Invite,{context:context,onSelect:close}),usage,settings,help]};';
  write(inviteFile, inviteSource);
  const inviteEnv = { CODEX_PATCH_SOURCE_DIR: inviteRoot };
  run("patch-hide-invite-menu.js", ["win", "--check"], 0, inviteEnv);
  assert.equal(fs.readFileSync(inviteFile, "utf8"), inviteSource);
  run("patch-hide-invite-menu.js", ["win"], 0, inviteEnv);
  const hiddenInvite = fs.readFileSync(inviteFile, "utf8");
  const renderMenu = source => Function("ui", "context", "close", "usage", "settings", "help", source + "return menu();")(
    { jsx: () => "invite" }, {}, () => {}, "usage", "settings", "help");
  assert.deepEqual(renderMenu(inviteSource), ["invite", "usage", "settings", "help"]);
  assert.deepEqual(renderMenu(hiddenInvite), [null, "usage", "settings", "help"]);
  run("patch-hide-invite-menu.js", ["win"], 0, inviteEnv);
  assert.equal(fs.readFileSync(inviteFile, "utf8"), hiddenInvite);
  write(inviteFile, inviteSource.replace("onSelect:close", "changed:close"));
  run("patch-hide-invite-menu.js", ["win"], 1, inviteEnv);
  assert.equal(fs.readFileSync(inviteFile, "utf8"), inviteSource.replace("onSelect:close", "changed:close"));

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

  console.log(`维护链功能测试通过：${checks} 个 CLI 场景；实际 GUI、原始 MSIX 和签名由候选验收覆盖。`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
