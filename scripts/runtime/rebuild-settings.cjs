// 本地外观偏好只读写真实 CODEX_HOME 下的固定文件，不接入官方会话或浏览器存储。
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const CHANNELS = Object.freeze({ read: "codex_rebuild:settings-read", write: "codex_rebuild:settings-write", changed: "codex_rebuild:settings-changed" });
const DEFAULTS = Object.freeze({ readingWidthPercent: 50, markdownBoldColorMode: "default", markdownBoldCustomColor: "#7c3aed", accentPreset: null });
const KEYS = Object.keys(DEFAULTS);
const PRESETS = new Set(["default", "blue", "green", "yellow", "pink", "orange", "purple", "black", "custom"]);
const MAX_BYTES = 64 * 1024;

function validate(value, partial = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地外观配置必须是 JSON 对象");
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => !KEYS.includes(key)) || !partial && KEYS.some(key => !Object.hasOwn(value, key))) throw new Error("本地外观配置字段无效");
  if (Object.hasOwn(value, "readingWidthPercent") && (!Number.isInteger(value.readingWidthPercent) || value.readingWidthPercent < 50 || value.readingWidthPercent > 100 || value.readingWidthPercent % 5 !== 0)) throw new Error("正文宽度必须是 50 到 100 的 5% 档位");
  if (Object.hasOwn(value, "markdownBoldColorMode") && !["default", "accent", "custom"].includes(value.markdownBoldColorMode)) throw new Error("Markdown 粗体颜色模式无效");
  if (Object.hasOwn(value, "markdownBoldCustomColor") && (typeof value.markdownBoldCustomColor !== "string" || !/^#[0-9a-f]{6}$/.test(value.markdownBoldCustomColor))) throw new Error("Markdown 粗体自定义颜色必须是小写六位十六进制色值");
  if (Object.hasOwn(value, "accentPreset") && value.accentPreset !== null && !PRESETS.has(value.accentPreset)) throw new Error("本地强调色预设无效");
  return value;
}

function snapshot(value) { return Object.fromEntries(KEYS.map(key => [key, value[key]])); }

function install({ codexHome, isTrustedIpcEvent, electron = require("electron") }) {
  if (typeof codexHome !== "string" || !path.isAbsolute(codexHome) || typeof isTrustedIpcEvent !== "function") throw new Error("本地外观配置缺少真实启动目录或官方 IPC 校验");
  const { ipcMain } = electron;
  const file = path.join(codexHome, "codex-rebuild-settings.json");
  const subscribers = new Map();
  let pending = Promise.resolve();
  const read = () => {
    let bytes;
    try {
      if (fs.statSync(file).size > MAX_BYTES) throw new Error("本地外观配置文件超过大小限制");
      bytes = fs.readFileSync(file);
    } catch (error) { if (error.code === "ENOENT") return snapshot(DEFAULTS); throw error; }
    if (bytes.length > MAX_BYTES) throw new Error("本地外观配置文件超过大小限制");
    return snapshot(validate(JSON.parse(bytes.toString("utf8"))));
  };
  const forget = sender => {
    const stop = subscribers.get(sender);
    if (stop) sender.removeListener("destroyed", stop);
    subscribers.delete(sender);
  };
  const remember = sender => {
    if (subscribers.has(sender) || sender.isDestroyed()) return;
    const stop = () => forget(sender);
    subscribers.set(sender, stop); sender.once("destroyed", stop);
  };
  const broadcast = value => {
    for (const sender of subscribers.keys()) {
      try {
        if (sender.isDestroyed() || !isTrustedIpcEvent({ sender, senderFrame: sender.mainFrame })) { forget(sender); continue; }
        sender.send(CHANNELS.changed, snapshot(value));
      } catch { forget(sender); }
    }
  };
  const onRead = event => {
    // 同步 IPC 的所有拒绝/读取异常分支都必须设置 returnValue，避免 renderer 挂起。
    try {
      if (!isTrustedIpcEvent(event)) throw new Error("拒绝未受信任的本地外观配置读取");
      remember(event.sender); event.returnValue = read();
    } catch (error) { event.returnValue = { error: error.message || String(error) }; }
  };
  const onWrite = (event, patch) => {
    if (!isTrustedIpcEvent(event)) return Promise.reject(new Error("拒绝未受信任的本地外观配置写入"));
    let update;
    try { update = { ...validate(patch, true) }; } catch (error) { return Promise.reject(error); }
    remember(event.sender);
    const operation = pending.then(() => {
      // 排队后重新读取完整磁盘值，保留其他窗口刚写入的字段；无效文件禁止覆盖。
      const value = snapshot(validate({ ...read(), ...update }));
      const temporary = path.join(codexHome, `.codex-rebuild-settings.${process.pid}.${randomUUID()}.tmp`);
      let created = false, descriptor;
      try {
        fs.mkdirSync(codexHome, { recursive: true });
        descriptor = fs.openSync(temporary, "wx", 0o600); created = true;
        fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8" });
        fs.fsyncSync(descriptor);
        const closing = descriptor; descriptor = undefined; fs.closeSync(closing);
        fs.renameSync(temporary, file); created = false;
      } finally {
        try { if (descriptor !== undefined) fs.closeSync(descriptor); }
        finally { if (created) fs.rmSync(temporary, { force: true }); }
      }
      broadcast(value); return value;
    });
    pending = operation.catch(() => {});
    return operation;
  };
  ipcMain.on(CHANNELS.read, onRead);
  ipcMain.handle(CHANNELS.write, onWrite);
  return () => {
    ipcMain.removeListener(CHANNELS.read, onRead); ipcMain.removeHandler(CHANNELS.write);
    for (const sender of subscribers.keys()) forget(sender);
  };
}

module.exports = { install, CHANNELS };
