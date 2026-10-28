/** 侧栏额度展示；数据与刷新由官方账户查询维护。 */
export function renderSidebarUsage({ compact, auth, usage, intl, jsx }) {
  const zh = intl.locale.toLowerCase().startsWith("zh");
  const label = zh ? "剩余额度" : "Usage remaining";
  const valid = !auth.isLoading && !auth.authLoading && !auth.accountLoading &&
    auth.accountId != null && auth.userId != null &&
    usage?.account_id === auth.accountId && usage?.user_id === auth.userId;
  const windows = valid ? [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window]
    .filter(window => Number.isFinite(window?.used_percent)) : [];
  // 多窗口取最紧张的一项；不能用缺失数据推算出 100%。
  const remaining = windows.length ? Math.min(...windows.map(window =>
    Math.max(0, Math.min(100, 100 - window.used_percent)))) : null;
  const displayValue = remaining == null ? "—" : intl.formatNumber(remaining, { maximumFractionDigits: 0 });
  const percent = remaining == null ? displayValue : `${displayValue}%`;
  const accent = "var(--app-color-text-accent,var(--codex-base-accent,currentColor))";
  const color = remaining == null ? "currentColor" : remaining <= 10 ? "#dc503f" : remaining <= 25 ? "#bd7b16"
    : `color-mix(in srgb, ${accent} 75%, var(--color-text))`;
  const details = windows.map(window => {
    const hours = window.limit_window_seconds / 3600;
    const period = hours === 168 ? (zh ? "每周" : "Weekly")
      : Number.isFinite(hours) && hours > 0 ? (zh ? `${hours} 小时` : `${hours} hours`) : label;
    const left = intl.formatNumber(Math.max(0, Math.min(100, 100 - window.used_percent)), { maximumFractionDigits: 0 });
    const reset = Number.isFinite(window.reset_at) ? new Date(window.reset_at * 1000) : null;
    const resetText = reset && Number.isFinite(reset.getTime())
      ? new Intl.DateTimeFormat(intl.locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(reset) : null;
    return `${period}: ${left}%${resetText ? (zh ? `，${resetText} 重置` : `; resets ${resetText}`) : ""}`;
  });
  const title = details.length ? details.join("\n") : (zh ? "额度数据暂不可用" : "Usage data unavailable");
  const size = compact ? 32 : 24;
  return jsx.jsxs("span", {
    "data-codex-sidebar-usage": true, role: "img", "aria-label": `${label}: ${percent}`, title,
    style: { display: "inline-flex", width: size, height: size, flexShrink: 0, alignItems: "center", justifyContent: "center", color: "var(--color-text)", lineHeight: 0 },
    children: [jsx.jsxs("svg", {
      width: size, height: size, viewBox: "0 0 36 36", "aria-hidden": true, "data-no-autosize": true,
      // 官方按钮会自动缩放内部 SVG；使用其原生豁免，并把数字置于同一坐标系。
      style: { display: "block", width: size, height: size, flex: "none", margin: 0, overflow: "visible" },
      children: [jsx.jsx("circle", {
        cx: 18, cy: 18, r: 15, fill: "none", stroke: "currentColor", strokeWidth: 2, opacity: 0.1,
      }), remaining == null ? null : jsx.jsx("circle", {
        cx: 18, cy: 18, r: 15, fill: "none", stroke: color, strokeWidth: 2,
        pathLength: 100, strokeDasharray: `${remaining} 100`, transform: "rotate(-90 18 18)",
      }), jsx.jsx("text", {
        "data-codex-sidebar-usage-value": true, x: 18, y: 18, textAnchor: "middle", dominantBaseline: "central",
        style: { fill: "var(--color-text)", opacity: 1, fontSize: compact ? 13 : 15, fontWeight: 500, fontFamily: "inherit", fontVariantNumeric: "tabular-nums" },
        children: displayValue,
      })],
    })],
  });
}
