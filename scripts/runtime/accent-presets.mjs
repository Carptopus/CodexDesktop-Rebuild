export const ACCENT_PRESET_STORAGE_KEY = "codex-rebuild:accent-preset:v1";
export const ACCENT_PRESETS = new Set([
  "default",
  "blue",
  "green",
  "yellow",
  "pink",
  "orange",
  "purple",
  "black",
]);

function storage() {
  return globalThis.localStorage;
}

export function readLocalAccentPreset() {
  try {
    const value = storage()?.getItem(ACCENT_PRESET_STORAGE_KEY);
    return ACCENT_PRESETS.has(value) ? value : null;
  } catch {
    return null;
  }
}

function clearLocalAccentPreset() {
  try {
    storage()?.removeItem(ACCENT_PRESET_STORAGE_KEY);
  } catch {}
}

export function accentPresetSelection(accountTheme, fallback) {
  return accountTheme === null ? readLocalAccentPreset() ?? fallback : fallback;
}

export function resolveAccentPreset(accentSource, accountPreset) {
  if (accountPreset != null) return accentSource === "chatgpt" ? accountPreset : null;
  return readLocalAccentPreset();
}

export function selectAccentPreset(accountTheme, preset, applyLocal, selectAccount) {
  return Promise.resolve().then(() => {
    if (accountTheme !== null) {
      clearLocalAccentPreset();
      return selectAccount();
    }
    if (!ACCENT_PRESETS.has(preset)) return;
    storage()?.setItem(ACCENT_PRESET_STORAGE_KEY, preset);
    return applyLocal();
  });
}

export function useCustomAccent(onChange, value) {
  clearLocalAccentPreset();
  return onChange(value);
}
