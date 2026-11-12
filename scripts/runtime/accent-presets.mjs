import { readSettings, writeSettings, reportSettingsError } from "./rebuild-settings.mjs";
export const ACCENT_PRESET_STORAGE_KEY = "accentPreset";
export const CUSTOM_ACCENT_PRESET = "custom";
export const ACCENT_PRESETS = new Set([
  "default",
  "blue",
  "green",
  "yellow",
  "pink",
  "orange",
  "purple",
  "black",
  CUSTOM_ACCENT_PRESET,
]);

export function readLocalAccentPreset() {
  const value = readSettings()[ACCENT_PRESET_STORAGE_KEY];
  return ACCENT_PRESETS.has(value) ? value : null;
}

async function saveLocalAccentPreset(preset) {
  try { await writeSettings({ [ACCENT_PRESET_STORAGE_KEY]: preset }); }
  catch (error) { reportSettingsError(error); }
}

export function accentPresetSelection(accountTheme, accentSource, fallback) {
  if (accountTheme === undefined || accentSource === "chatgpt") return fallback;
  return readLocalAccentPreset() ?? "default";
}

export function resolveAccentPreset(accentSource, accountPreset) {
  if (accentSource === "chatgpt") return accountPreset;
  const preset = readLocalAccentPreset();
  if (preset === CUSTOM_ACCENT_PRESET) return null;
  // 官方账户的“默认”会先解析成 effectiveTheme；未登录时没有这层账户数据。
  // Windows 官方当前的有效默认色是 blue，本地模式在渲染阶段补齐同一语义。
  return preset == null || preset === "default" ? "blue" : preset;
}

export function selectAccentPreset(accountTheme, preset, applyLocal, selectAccount) {
  return Promise.resolve().then(async () => {
    // 上游可能新增预设；本模块不认识时不保存本地值，也不吞掉官方选择动作。
    if (!ACCENT_PRESETS.has(preset)) return selectAccount();
    // 无论当前是否能同步到 ChatGPT 账户，都保留一份本地预设。
    // 自定义 Provider 重启后可能拿不到账户主题；此时仍应恢复用户上次选择的官方预设。
    await saveLocalAccentPreset(preset);
    if (accountTheme !== null) {
      return selectAccount();
    }
    return applyLocal();
  });
}

export async function useCustomAccent(onChange, value) {
  // 缺少键表示从未设置，本地模式会采用官方默认蓝色；显式 custom 才表示用户选择自定义色。
  await saveLocalAccentPreset(CUSTOM_ACCENT_PRESET);
  return onChange(value);
}
