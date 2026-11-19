// 主进程负责独立 JSON 文件；渲染层仅保留已确认的快照，不读写浏览器存储。
export const DEFAULT_SETTINGS = Object.freeze({
  readingWidthPercent: 50,
  markdownBoldColorMode: "default",
  markdownBoldCustomColor: "#7c3aed",
  accentPreset: null,
});
export const SETTINGS_CHANGED = "codex-rebuild-settings-change";
let current;
let bridge;

export function reportSettingsError(error) {
  console.error("[CodexRebuild] 外观配置读写失败", error);
}

function accept(snapshot) {
  if (!snapshot || snapshot.error) throw new Error(snapshot?.error ?? "外观配置快照缺失");
  current = Object.freeze({ ...snapshot });
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SETTINGS_CHANGED));
}

function initialize() {
  if (current) return;
  bridge = globalThis.electronBridge?.rebuildSettings;
  try {
    if (!bridge) throw new Error("外观配置桥未加载");
    accept(bridge.read());
  } catch (error) {
    current = DEFAULT_SETTINGS;
    reportSettingsError(error);
  }
  bridge?.onChange(snapshot => {
    try { accept(snapshot); notify(); }
    catch (error) { reportSettingsError(error); }
  });
}

export function readSettings() {
  initialize();
  return current;
}

export async function writeSettings(patch) {
  initialize();
  if (!bridge) throw new Error("外观配置桥未加载，未保存");
  // 只有主进程确认落盘成功后才更新界面，避免显示已保存却实际丢失。
  const observed = current;
  const snapshot = await bridge.write(patch);
  // 广播可能已经送来更新的快照，较早请求的回复不能将它覆盖回去。
  if (current === observed) { accept(snapshot); notify(); }
  return current;
}
