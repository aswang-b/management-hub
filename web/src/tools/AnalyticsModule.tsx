// Analytics module: charts one saved metric. What it shows depends on its size:
//   1×1          a big number with the change against the previous period
//   2-3 wide × 1 the number plus a small line (sparkline)
//   2 tall+      a full chart with axes
// With a limit (typed in settings, or saved by the plugin) it also shows a
// gauge: "used / limit", with the warning style past 80%.
import { useCallback, useEffect, useState } from "react";
import type { Tool } from "../../../shared/types.ts";
import { COMBINE, RANGES, formatValue, seriesLabel, tagKey, type AnalyticsResult } from "../../../shared/metrics.ts";
import { api } from "../api.ts";
import { FullChart, Sparkline } from "./charts.tsx";
import { ToneMark } from "./PluginTool.tsx";
import type { ToolDef } from "./registry.tsx";

const REFRESH_MS = 5 * 60_000;

/** "netlify.bandwidth_bytes" → "Netlify bandwidth". */
function niceName(metric: string) {
  const [service, ...rest] = metric.split(".");
  const what = rest.join(" ").replace(/_bytes$/, "").replace(/_/g, " ");
  return `${service.charAt(0).toUpperCase()}${service.slice(1)} ${what}`.trim();
}

function ago(ts: number) {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}

async function collectNow() {
  const run = await api.collectMetrics();
  if (!run.results.length) return "Nothing to collect yet. Add a Resend or Netlify tile to a project first.";
  return run.results.map((r) => (r.ok ? `${r.plugin}: saved ${r.points} numbers.` : `${r.plugin} failed: ${r.error}`)).join(" ");
}

export const analyticsDef: Omit<ToolDef, "render"> = {
  key: "analytics",
  category: "module",
  type: "analytics",
  name: "Analytics",
  description: "Charts a number the hub saves every hour, such as emails sent or bandwidth, with a gauge when there's a limit.",
  sizes: [
    { w: 1, h: 1, label: "1 wide, 1 tall" },
    { w: 2, h: 1, label: "2 wide, 1 tall" },
    { w: 3, h: 1, label: "3 wide, 1 tall" },
    { w: 2, h: 2, label: "2 wide, 2 tall" },
    { w: 3, h: 2, label: "3 wide, 2 tall" },
    { w: 4, h: 2, label: "4 wide, 2 tall" },
    { w: 4, h: 3, label: "4 wide, 3 tall" },
  ],
  configFields: [
    { key: "series", label: "Metric", type: "select", required: true },
    { key: "title", label: "Name (optional)", placeholder: "Uses the metric's name if empty" },
    { key: "range", label: "Time range", type: "select", placeholder: "7d", options: Object.entries(RANGES).map(([value, r]) => ({ value, label: r.label })) },
    {
      key: "combine",
      label: "Combine readings as",
      type: "select",
      placeholder: "latest",
      options: Object.entries(COMBINE).map(([value, label]) => ({ value, label })),
      help: "Latest suits running totals like \"emails this month\". Sum suits counts of new things.",
    },
    {
      key: "limit",
      label: "Limit (optional)",
      type: "number",
      placeholder: "Plugin's own limit",
      help: "Leave empty to use the limit the plugin saves (Resend's plan, Netlify's bandwidth). Type 0 for no gauge.",
    },
  ],
  async loadSettings() {
    const { series, lastRun } = await api.metrics();
    const options = series.map((s) => ({
      value: `${s.metric}|${tagKey(s.tags)}`,
      label: `${seriesLabel(s.metric, s.tags)} (now ${formatValue(s.metric, s.lastValue)})`,
    }));
    const note = !lastRun?.results.length
      ? "No numbers saved yet. They come from the Resend and Netlify tiles in your projects, every hour while the hub runs."
      : `Numbers last collected ${ago(lastRun.at)}.` +
        lastRun.results.filter((r) => !r.ok).map((r) => ` ${r.plugin} failed: ${r.error}`).join("");
    return { options: { series: options }, note };
  },
  settingsAction: { label: "Collect now", run: collectNow },
};

export function AnalyticsModule({ tool }: { tool: Tool }) {
  const [r, setR] = useState<AnalyticsResult>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setR(await api.analytics(tool.id));
    } catch (e) {
      setR({ ok: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [tool.id]);

  const configKey = JSON.stringify(tool.config);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load, configKey]);

  const small = tool.h === 1;
  const metric = r?.metric ?? "";
  const title = String(tool.config.title || (metric ? niceName(metric) : "Analytics"));
  const rangeLabel = r?.range ? RANGES[r.range].label.toLowerCase() : "";
  const value = r?.value ?? null;
  const limit = r?.limit ?? null;
  const ratio = limit && value !== null ? value / limit : null;
  const tone = ratio === null ? undefined : ratio >= 1 ? "bad" : ratio >= 0.8 ? "warn" : undefined;
  const change = value !== null && r?.previous ? (value - r.previous) / Math.abs(r.previous) : null;
  const hasData = r?.points?.some((p) => p.value !== null);

  const changeText =
    change === null ? null : `${change > 0 ? "↑" : change < 0 ? "↓" : "="} ${Math.abs(Math.round(change * 100))}%`;
  const gauge = limit !== null && value !== null && (
    <div className="an-gauge" title={`${formatValue(metric, value)} of ${formatValue(metric, limit)}`}>
      <div className="meter">
        <div style={{ width: `${Math.min(100, (ratio ?? 0) * 100)}%` }} />
      </div>
      <span>
        {tone && <ToneMark tone={tone} />} {Math.round((ratio ?? 0) * 100)}% of {formatValue(metric, limit)}
      </span>
    </div>
  );

  return (
    <div className={`analytics ${small ? "an-small" : "an-large"} ${tool.w === 1 ? "an-narrow" : ""} ${tone === "bad" ? "an-bad" : ""}`}>
      <div className="an-head" title={r?.metric ? seriesLabel(r.metric, r.tags ?? {}) : undefined}>
        <span className="an-title">{title}</span>
        {!small && <span className="an-range">{rangeLabel}</span>}
        <span className="grow" />
        {!small && (
          <button className="icon-btn" title="Refresh" onClick={load} disabled={loading}>
            {loading ? "…" : "↻"}
          </button>
        )}
      </div>

      {!r && <div className="an-msg muted">Loading…</div>}
      {r && !r.ok && <div className="an-msg">{r.error}</div>}
      {r?.ok && !hasData && (
        <div className="an-msg muted">
          No readings in the {rangeLabel} yet.{r.lastTs ? ` Last one ${ago(r.lastTs)}.` : " The hub saves numbers every hour while it's running."}
        </div>
      )}

      {r?.ok && hasData && (
        <>
          <div className="an-figures">
            <span className="an-value">{formatValue(metric, value)}</span>
            {limit !== null && !small && <span className="an-of">/ {formatValue(metric, limit)}</span>}
            {changeText && (
              <span className="an-change" title={`Change vs. the ${RANGES[r.range!].label.toLowerCase().replace("last", "previous")}`}>
                {changeText}
              </span>
            )}
          </div>
          {gauge}
          {small && tool.w > 1 && <Sparkline points={r.points!} />}
          {!small && (
            <div className="an-chart">
              <FullChart result={r} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
