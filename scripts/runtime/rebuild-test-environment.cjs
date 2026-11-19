// Owl 的入口前阶段只设置环境；Electron 路径 API 要等原生 bootstrap 初始化。
if (process.env.CODEX_REBUILD_TEST_ROOT) {
  const fs = require("node:fs"), path = require("node:path");
  const root = process.env.CODEX_REBUILD_TEST_ROOT;
  if (!path.isAbsolute(root)) throw new Error("验收数据根目录必须是绝对路径");
  process.on("uncaughtExceptionMonitor", error => {
    try { fs.writeFileSync(path.join(root, "startup-error.json"), JSON.stringify({ message: error.message, stack: error.stack })); } catch {}
  });
  for (const [key, name] of [["CODEX_HOME", "codex-home"], ["CODEX_ELECTRON_USER_DATA_PATH", "electron-user-data"]]) {
    const directory = path.join(path.resolve(root), name);
    fs.mkdirSync(directory, { recursive: true }); process.env[key] = directory;
  }
  if (process.env.CODEX_REBUILD_SMOKE_EXIT === "1") {
    const record = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
    record("test-environment.json", { pid: process.pid, codexHome: process.env.CODEX_HOME, userData: process.env.CODEX_ELECTRON_USER_DATA_PATH });
    const app = require("electron").app, exit = app.exit;
    app.exit = function(code) { record("app-exit.json", { code, stack: new Error("app.exit caller").stack }); return exit.call(app, code); };
    process.on("exit", code => record("process-exit.json", { code }));
  }
}
