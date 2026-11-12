// 只保存阅读布局与 Markdown 粗体样式偏好，认证、Provider 与任务配置由原程序管理。
import { readSettings, writeSettings, reportSettingsError, SETTINGS_CHANGED } from "./rebuild-settings.mjs";
export const MIN_WIDTH_PERCENT = 50;
export const MAX_WIDTH_PERCENT = 100;
export const WIDTH_STEP = 5;
export const WIDTHS = Array.from(
  { length: (MAX_WIDTH_PERCENT - MIN_WIDTH_PERCENT) / WIDTH_STEP + 1 },
  (_, index) => String(MIN_WIDTH_PERCENT + index * WIDTH_STEP),
);
export const STORAGE_KEY = "readingWidthPercent";
export const BOLD_COLOR_MODES = ["default", "accent", "custom"];
export const BOLD_MODE_STORAGE_KEY = "markdownBoldColorMode";
export const BOLD_CUSTOM_COLOR_STORAGE_KEY = "markdownBoldCustomColor";
export const DEFAULT_BOLD_CUSTOM_COLOR = "#7c3aed";
const STYLE_ID = "codex-rebuild-reading-style";
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
let installed = false;

export function readingCss(value, boldMode = "default", customColor = DEFAULT_BOLD_CUSTOM_COLOR) {
  if (!WIDTHS.includes(value)) throw new Error("未知的正文宽度档位");
  if (!BOLD_COLOR_MODES.includes(boldMode)) throw new Error("未知的 Markdown 粗体颜色模式");
  if (boldMode === "custom" && !COLOR_PATTERN.test(customColor)) throw new Error("Markdown 粗体自定义颜色无效");
  const expanded = `min(100%,max(48rem,${value}%))`;
  const compact = `min(100%,max(40rem,${value}%))`;
  const selected = `html[data-codex-rebuild-reading-width] body{--thread-content-max-width:${expanded};--thread-content-expanded-max-width:${expanded};--thread-content-compact-max-width:${compact}}`;
  const boldSelector = ":is([data-codex-window-type=browser],[data-codex-window-type=chrome-extension],[data-codex-window-type=electron]) [data-selected-text-overlay-target] strong";
  const bold = boldMode === "default" ? "" : `${boldSelector}{color:${boldMode === "accent" ? "var(--app-color-text-accent,var(--codex-base-accent,currentColor))" : customColor.toLowerCase()}}`;
  return `${selected}
[data-selected-text-overlay-target]{--markdown-wide-block-max-width:100%}
[data-codex-rebuild-width-control]{appearance:none;width:9rem;height:1.25rem;cursor:pointer;background:transparent;color:inherit}
[data-codex-rebuild-width-control]::-webkit-slider-runnable-track{height:.25rem;border-radius:9999px;background:linear-gradient(to right,var(--app-color-text-accent,var(--codex-base-accent,#2f6fda)) 0 var(--codex-rebuild-width-progress),color-mix(in srgb,currentColor 18%,transparent) var(--codex-rebuild-width-progress) 100%);box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 12%,transparent)}
[data-codex-rebuild-width-control]::-webkit-slider-thumb{appearance:none;width:1rem;height:1rem;margin-top:-.375rem;border:2px solid var(--color-background-primary,var(--color-background-surface,Canvas));border-radius:9999px;background:var(--app-color-text-accent,var(--codex-base-accent,#2f6fda));box-shadow:0 0 0 1px color-mix(in srgb,currentColor 18%,transparent)}
[data-codex-rebuild-width-control]:focus-visible{outline:2px solid var(--app-color-text-accent,var(--codex-base-accent,#2f6fda));outline-offset:2px;border-radius:9999px}
[data-codex-rebuild-width-control]:disabled{cursor:not-allowed;opacity:.5}
${bold}
${Object.entries({ narrow: 520, feature: 600, compact: 640, wide: 800, xwide: 860, xxwide: 1040, editor: 800, default: 720 }).map(([name, size]) => `.codex-dialog.codex-rebuild-dialog-${name}{width:min(${size}px,calc(100vw / var(--codex-window-zoom,1) - 32px));max-width:calc(100vw / var(--codex-window-zoom,1) - 32px)}`).join("\n")}
`;
}

function widthPreference() {
  const value = String(readSettings()[STORAGE_KEY]);
  return WIDTHS.includes(value) ? value : String(MIN_WIDTH_PERCENT);
}

function boldModePreference() {
  const value = readSettings()[BOLD_MODE_STORAGE_KEY];
  return BOLD_COLOR_MODES.includes(value) ? value : "default";
}

function boldCustomColorPreference() {
  const value = readSettings()[BOLD_CUSTOM_COLOR_STORAGE_KEY];
  return COLOR_PATTERN.test(value) ? value.toLowerCase() : DEFAULT_BOLD_CUSTOM_COLOR;
}

function apply(width = widthPreference(), boldMode = boldModePreference(), customColor) {
  const resolvedColor = customColor ?? (boldMode === "custom" ? boldCustomColorPreference() : DEFAULT_BOLD_CUSTOM_COLOR);
  let style = document.getElementById(STYLE_ID);
  if (!style) { style = document.createElement("style"); style.id = STYLE_ID; document.head.append(style); }
  style.textContent = readingCss(width, boldMode, resolvedColor);
  document.documentElement.dataset.codexRebuildReadingWidth = width;
  document.documentElement.dataset.codexRebuildBoldColor = boldMode;
}

export function installReadingStyle() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  apply();
  window.addEventListener(SETTINGS_CHANGED, () => {
    apply(); window.dispatchEvent(new Event("codex-rebuild-reading-change"));
  });
}

export function renderReadingWidth(react, ui, Row, intl) {
  const chinese = String(intl.locale).startsWith("zh");
  const [value, setValue] = react.useState(widthPreference);
  const [boldMode, setBoldMode] = react.useState(boldModePreference);
  const [boldColor, setBoldColor] = react.useState(boldCustomColorPreference);
  react.useEffect(() => {
    const update = () => {
      const mode = boldModePreference();
      setValue(widthPreference()); setBoldMode(mode);
      if (mode === "custom") setBoldColor(boldCustomColorPreference());
    };
    window.addEventListener("codex-rebuild-reading-change", update);
    return () => window.removeEventListener("codex-rebuild-reading-change", update);
  }, []);
  const controlClass = "rounded-md border border-default bg-surface px-3 py-1.5 text-sm text-default";
  return ui.jsxs(react.Fragment, { children: [
    ui.jsx(Row, {
      size: "compact",
      label: chinese ? "聊天正文宽度" : "Chat content width",
      control: ui.jsxs("div", { className: "flex items-center gap-2", children: [
        ui.jsx("input", {
          type: "range",
          min: MIN_WIDTH_PERCENT,
          max: MAX_WIDTH_PERCENT,
          step: WIDTH_STEP,
          "aria-label": chinese ? "聊天正文宽度" : "Chat content width",
          "data-codex-rebuild-width-control": "true",
          className: "w-36",
          style: {
            accentColor: "var(--app-color-text-accent)",
            "--codex-rebuild-width-progress": `${(Number(value) - MIN_WIDTH_PERCENT) / (MAX_WIDTH_PERCENT - MIN_WIDTH_PERCENT) * 100}%`,
          },
          value,
          onChange: event => {
            const next = Number(event.currentTarget.value);
            return writeSettings({ [STORAGE_KEY]: next }).catch(reportSettingsError);
          },
        }),
        ui.jsx("output", {
          "aria-hidden": "true",
          className: "w-10 text-right text-sm tabular-nums text-secondary",
          children: `${value}%`,
        }),
      ] }),
    }, "codex-rebuild-reading-width"),
    ui.jsx(Row, {
      size: "compact",
      label: chinese ? "Markdown 粗体颜色" : "Markdown bold color",
      control: ui.jsxs("div", { className: "flex items-center gap-2", children: [
        ui.jsxs("select", {
          "aria-label": chinese ? "Markdown 粗体颜色" : "Markdown bold color",
          "data-codex-rebuild-bold-color-control": "true",
          className: controlClass,
          value: boldMode,
          onChange: event => {
            const next = event.currentTarget.value;
            return writeSettings({ [BOLD_MODE_STORAGE_KEY]: next }).catch(reportSettingsError);
          },
          children: BOLD_COLOR_MODES.map(option => ui.jsx("option", { value: option, children: ({
            default: chinese ? "跟随正文" : "Text color",
            accent: chinese ? "跟随强调色" : "Accent color",
            custom: chinese ? "自定义" : "Custom",
          })[option] }, option)),
        }),
        boldMode === "custom" && ui.jsx("input", {
          type: "color",
          "aria-label": chinese ? "Markdown 粗体自定义颜色" : "Custom Markdown bold color",
          "data-codex-rebuild-bold-custom-color": "true",
          className: "h-8 w-10 cursor-pointer rounded border border-default bg-surface p-1",
          value: boldColor,
          onChange: event => {
            const next = event.currentTarget.value.toLowerCase();
            return writeSettings({ [BOLD_CUSTOM_COLOR_STORAGE_KEY]: next, [BOLD_MODE_STORAGE_KEY]: "custom" })
              .catch(reportSettingsError);
          },
        }),
      ] }),
    }, "codex-rebuild-markdown-bold-color"),
  ] });
}

installReadingStyle();
