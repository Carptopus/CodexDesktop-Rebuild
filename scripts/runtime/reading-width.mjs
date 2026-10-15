// 只保存阅读布局偏好，认证、Provider 与任务配置由原程序管理。
export const WIDTHS = ["default", "800", "960", "1120", "1280", "1440", "1600", "full"];
export const STORAGE_KEY = "codex-rebuild:reading-width:v1";
const STYLE_ID = "codex-rebuild-reading-style";
let installed = false;

export function readingCss(value) {
  if (!WIDTHS.includes(value)) throw new Error("未知的正文宽度档位");
  const width = value === "full" ? "100%" : `${value}px`;
  const selected = value === "default" ? "" : `html[data-codex-rebuild-reading-width] body{--thread-content-max-width:${width};--thread-content-expanded-max-width:${width};--thread-content-compact-max-width:${width}}`;
  return `${selected}
[data-selected-text-overlay-target]{--markdown-wide-block-max-width:var(--thread-content-max-width,100%)}
:is([data-codex-window-type=browser],[data-codex-window-type=chrome-extension],[data-codex-window-type=electron]) [data-selected-text-overlay-target] strong{color:var(--color-token-charts-green,var(--green-500,#00a240))}
${Object.entries({ narrow: 520, feature: 600, compact: 640, wide: 800, xwide: 860, xxwide: 1040, editor: 800, default: 720 }).map(([name, size]) => `.codex-dialog.codex-rebuild-dialog-${name}{width:min(${size}px,calc(100vw / var(--codex-window-zoom,1) - 32px));max-width:calc(100vw / var(--codex-window-zoom,1) - 32px)}`).join("\n")}
`;
}

function preference() {
  const value = localStorage.getItem(STORAGE_KEY) ?? "default";
  if (!WIDTHS.includes(value)) throw new Error("正文宽度设置无效，请重新选择");
  return value;
}

function apply(value) {
  let style = document.getElementById(STYLE_ID);
  if (!style) { style = document.createElement("style"); style.id = STYLE_ID; document.head.append(style); }
  style.textContent = readingCss(value);
  document.documentElement.dataset.codexRebuildReadingWidth = value;
}

export function installReadingStyle() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  try { apply(preference()); } catch (error) { console.error("[rebuild-reading]", error.message); apply("default"); }
  window.addEventListener("storage", event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try { apply(preference()); window.dispatchEvent(new Event("codex-rebuild-reading-change")); }
    catch (error) { console.error("[rebuild-reading]", error.message); }
  });
}

export function renderReadingWidth(react, ui, Row, intl) {
  const chinese = String(intl.locale).startsWith("zh");
  const [value, setValue] = react.useState(() => { try { return preference(); } catch { return "default"; } });
  const [error, setError] = react.useState(() => { try { preference(); return ""; } catch (error) { return error.message; } });
  react.useEffect(() => {
    const update = () => { try { setValue(preference()); setError(""); } catch (error) { setError(error.message); } };
    window.addEventListener("codex-rebuild-reading-change", update);
    return () => window.removeEventListener("codex-rebuild-reading-change", update);
  }, []);
  return ui.jsx(Row, {
    label: chinese ? "聊天正文宽度" : "Chat content width",
    description: error || (chinese ? "正文、输入区域及代码块/表格同步调整，窗口较窄时自动收缩。" : "Adjust chats, composer and wide blocks; shrink to fit smaller windows."),
    control: ui.jsxs("select", {
      "aria-label": chinese ? "聊天正文宽度" : "Chat content width",
      "data-codex-rebuild-width-control": "true",
      className: "rounded-md border border-default bg-surface px-3 py-1.5 text-sm text-default",
      value,
      onChange: event => {
        const next = event.currentTarget.value;
        try {
          if (!WIDTHS.includes(next)) throw new Error("未知的正文宽度档位");
          localStorage.setItem(STORAGE_KEY, next); apply(next); setValue(next); setError("");
          window.dispatchEvent(new Event("codex-rebuild-reading-change"));
        } catch (error) { setError(error.message); }
      },
      children: WIDTHS.map(option => ui.jsx("option", { value: option,
        children: option === "default" ? (chinese ? "默认" : "Default") : option === "full" ? (chinese ? "全宽" : "Full width") : `${option} ${chinese ? "像素" : "px"}` }, option)),
    }),
  });
}

installReadingStyle();
