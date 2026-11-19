/** 侧栏额度展示；数据与刷新由官方账户查询维护。 */
const RESET_DURATION = {
  id: "settings.usage.personalLimits.resetsInDuration", defaultMessage: "Resets in {duration}",
};

function formatReset(resetAt, now, intl) {
  if (!Number.isFinite(resetAt)) return null;
  const resetTime = new Date(resetAt * 1000).getTime();
  if (!Number.isFinite(resetTime)) return null;

  const totalMinutes = Math.max(0, Math.ceil((resetTime - now) / 60_000));
  if (totalMinutes === 0) {
    return intl.formatMessage({ id: "settings.usage.personalLimits.resetsNow", defaultMessage: "Resets now" });
  }
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor(totalMinutes % 1440 / 60);
  const minutes = totalMinutes % 60;

  if (typeof Intl.DurationFormat === "function" && Intl.DurationFormat.supportedLocalesOf(intl.locale).length &&
      (intl.locale === intl.defaultLocale || intl.messages?.[RESET_DURATION.id])) {
    const duration = new Intl.DurationFormat(intl.locale, {
      style: new Intl.Locale(intl.locale).language === "en" ? "narrow" : "short",
      hoursDisplay: days > 0 ? "always" : "auto",
      minutesDisplay: days > 0 ? "auto" : "always",
    }).format(days > 0 ? { days, hours } : { hours, minutes });
    return intl.formatMessage(RESET_DURATION, { duration });
  }
  if (days > 0) {
    return intl.formatMessage({
      id: "settings.usage.personalLimits.resetsInDaysHours", defaultMessage: "Resets in {days}d {hours}h",
    }, { days, hours });
  }
  if (hours > 0) {
    return intl.formatMessage({
      id: "settings.usage.personalLimits.resetsInHoursMinutes", defaultMessage: "Resets in {hours}h {minutes}m",
    }, { hours, minutes });
  }
  return intl.formatMessage({
    id: "settings.usage.personalLimits.resetsInMinutes", defaultMessage: "Resets in {minutes}m",
  }, { minutes });
}

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
  const color = remaining != null && remaining < 15
    ? "var(--color-usage-meter-warning,#dc503f)"
    : "var(--color-usage-meter-fill,var(--color-text-secondary,currentColor))";
  const unavailable = zh ? "额度数据暂不可用" : "Usage data unavailable";
  const usageTitle = now => windows.length ? windows.map(window => {
    const hours = window.limit_window_seconds / 3600;
    const period = hours === 168 ? (zh ? "每周" : "Weekly")
      : Number.isFinite(hours) && hours > 0 ? (zh ? `${hours} 小时` : `${hours} hours`) : label;
    const left = intl.formatNumber(Math.max(0, Math.min(100, 100 - window.used_percent)), { maximumFractionDigits: 0 });
    const reset = formatReset(window.reset_at, now, intl);
    return `${period}: ${left}%${reset ? `${zh ? "，" : " · "}${reset}` : ""}`;
  }).join("\n") : unavailable;
  const size = compact ? 32 : 24;
  return jsx.jsxs("span", {
    "data-codex-sidebar-usage": true, role: "img", "aria-label": `${label}: ${percent}`, title: usageTitle(Date.now()),
    // 共享额度状态未变化时也要按悬停时刻计算倒计时。
    onMouseEnter: ({ currentTarget }) => { currentTarget.title = usageTitle(Date.now()); },
    style: { display: "inline-flex", width: size, height: size, flexShrink: 0, alignItems: "center", justifyContent: "center", color: "var(--color-text)", lineHeight: 0 },
    children: [jsx.jsxs("svg", {
      width: size, height: size, viewBox: "0 0 36 36", "aria-hidden": true, "data-no-autosize": true,
      // 官方按钮会自动缩放内部 SVG；使用其原生豁免，并把数字置于同一坐标系。
      style: { display: "block", width: size, height: size, flex: "none", margin: 0, overflow: "visible" },
      children: [jsx.jsx("circle", {
        cx: 18, cy: 18, r: 15, fill: "none",
        stroke: "var(--color-usage-meter-track,var(--color-border-strong))", strokeWidth: 2,
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
