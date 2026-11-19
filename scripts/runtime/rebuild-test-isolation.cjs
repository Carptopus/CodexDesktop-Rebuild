// 仅在独立验收启动器显式给出测试根目录时生效。
const testRoot = process.env.CODEX_REBUILD_TEST_ROOT;
if (testRoot) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { app } = require("electron");
  if (!path.isAbsolute(testRoot)) throw new Error("验收数据根目录必须是绝对路径");
  const root = path.resolve(testRoot);
  const codexHome = path.join(root, "codex-home");
  const userData = path.join(root, "electron-user-data");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_ELECTRON_USER_DATA_PATH = userData;
  fs.writeFileSync(path.join(root, "isolation-hook.json"), JSON.stringify({ pid: process.pid, stage: "native-user-data-set", actualUserData: app.getPath("userData") }));
  if (path.resolve(app.getPath("userData")) !== userData) throw new Error("官方 bootstrap 未采用验收 User Data，停止启动");
  app.setPath("sessionData", userData);
  if (process.env.CODEX_REBUILD_SMOKE_EXIT === "1") {
    const proof = { pid: process.pid, startedAt: new Date().toISOString(), windowLoaded: false };
    const save = () => fs.writeFileSync(path.join(root, "desktop-smoke.json"), JSON.stringify(proof, null, 2));
    app.on("browser-window-created", (_event, window) => {
      window.webContents.once("did-finish-load", async () => {
        const bounds = window.getBounds();
        if (bounds.width < 300 || bounds.height < 200) return;
        // HTML 加载事件不等于 React 可用；等待真实阅读模块和可见 UI 控件。
        try {
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline && !window.isDestroyed()) {
            const renderer = await window.webContents.executeJavaScript('({readingStyle:!!document.getElementById("codex-rebuild-reading-style"),controls:document.querySelectorAll("button,input,[role=button]").length,textLength:document.body?.innerText.trim().length||0})');
            if (renderer.readingStyle && renderer.controls > 0 && renderer.textLength > 0) {
              Object.assign(proof, { windowLoaded: true, loadedAt: new Date().toISOString(), url: window.webContents.getURL(), renderer });
              save(); setTimeout(() => app.quit(), 1500); return;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          proof.failure = "窗口 HTML 已加载，但阅读模块/真实 UI 控件未就绪"; save();
        } catch (error) { proof.failure = error.message; save(); }
      });
      window.webContents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
        if (!mainFrame || code === -3) return;
        proof.failure = `${code}: ${description}`; save();
      });
      window.webContents.on("render-process-gone", (_event, details) => { proof.failure = details.reason; save(); });
    });
    save();
  }
  app.whenReady().then(() => {
    const actual = app.getPath("userData");
    if (path.resolve(actual) !== userData || path.resolve(process.env.CODEX_HOME) !== codexHome) {
      console.error("[rebuild-isolation] 启动后数据目录被其他逻辑改写，停止验收");
      app.exit(1);
      return;
    }
    fs.writeFileSync(path.join(root, "isolation-runtime.json"), JSON.stringify({
      schemaVersion: 1, pid: process.pid, recordedAt: new Date().toISOString(),
      executable: process.execPath, codexHome, userData: actual, sessionData: app.getPath("sessionData"),
      note: "Electron 路径已核实；单实例锁与 Owl 外层行为仍需 GUI 验证",
    }, null, 2) + "\n");
  });
}
