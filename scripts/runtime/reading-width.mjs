// 只保存阅读布局与 Markdown 粗体样式偏好，认证、Provider 与任务配置由原程序管理。
export const WIDTHS = ["default", "85", "100"];
export const STORAGE_KEY = "codex-rebuild:reading-width:v1";
export const BOLD_COLOR_MODES = ["default", "accent", "custom"];
export const BOLD_MODE_STORAGE_KEY = "codex-rebuild:markdown-bold-color-mode:v1";
export const BOLD_CUSTOM_COLOR_STORAGE_KEY = "codex-rebuild:markdown-bold-custom-color:v1";
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
  const selected = value === "default" ? "" : `html[data-codex-rebuild-reading-width] body{--thread-content-max-width:${expanded};--thread-content-expanded-max-width:${expanded};--thread-content-compact-max-width:${compact}}`;
  const boldSelector = ":is([data-codex-window-type=browser],[data-codex-window-type=chrome-extension],[data-codex-window-type=electron]) [data-selected-text-overlay-target] strong";
  const bold = boldMode === "default" ? "" : `${boldSelector}{color:${boldMode === "accent" ? "var(--app-color-text-accent,var(--codex-base-accent,currentColor))" : customColor.toLowerCase()}}`;
  return `${selected}
[data-selected-text-overlay-target]{--markdown-wide-block-max-width:100%}
${bold}
${Object.entries({ narrow: 520, feature: 600, compact: 640, wide: 800, xwide: 860, xxwide: 1040, editor: 800, default: 720 }).map(([name, size]) => `.codex-dialog.codex-rebuild-dialog-${name}{width:min(${size}px,calc(100vw / var(--codex-window-zoom,1) - 32px));max-width:calc(100vw / var(--codex-window-zoom,1) - 32px)}`).join("\n")}
`;
}

function widthPreference() {
  const value = localStorage.getItem(STORAGE_KEY) ?? "default";
  return WIDTHS.includes(value) ? value : "default";
}

function boldModePreference() {
  const value = localStorage.getItem(BOLD_MODE_STORAGE_KEY) ?? "default";
  return BOLD_COLOR_MODES.includes(value) ? value : "default";
}

function boldCustomColorPreference() {
  const value = localStorage.getItem(BOLD_CUSTOM_COLOR_STORAGE_KEY) ?? DEFAULT_BOLD_CUSTOM_COLOR;
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
  window.addEventListener("storage", event => {
    if (![STORAGE_KEY, BOLD_MODE_STORAGE_KEY, BOLD_CUSTOM_COLOR_STORAGE_KEY, null].includes(event.key)) return;
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
      control: ui.jsxs("select", {
        "aria-label": chinese ? "聊天正文宽度" : "Chat content width",
        "data-codex-rebuild-width-control": "true",
        className: controlClass,
        value,
        onChange: event => {
          const next = event.currentTarget.value;
          localStorage.setItem(STORAGE_KEY, next); apply(next, boldModePreference()); setValue(next);
          window.dispatchEvent(new Event("codex-rebuild-reading-change"));
        },
        children: WIDTHS.map(option => ui.jsx("option", { value: option,
          children: option === "default" ? (chinese ? "默认" : "Default") : `${option}%` }, option)),
      }),
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
            localStorage.setItem(BOLD_MODE_STORAGE_KEY, next); apply(widthPreference(), next); setBoldMode(next);
            window.dispatchEvent(new Event("codex-rebuild-reading-change"));
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
            localStorage.setItem(BOLD_CUSTOM_COLOR_STORAGE_KEY, next); localStorage.setItem(BOLD_MODE_STORAGE_KEY, "custom");
            apply(widthPreference(), "custom", next); setBoldColor(next); setBoldMode("custom");
            window.dispatchEvent(new Event("codex-rebuild-reading-change"));
          },
        }),
      ] }),
    }, "codex-rebuild-markdown-bold-color"),
  ] });
}

installReadingStyle();
