// Types and helpers for the analytics module, shared by the server and the
// page. Every number the hub saves is a "point" in the metrics table.

export interface MetricPoint {
  /** Name like "resend.emails_month". A name ending in "_bytes" is shown as a size. */
  metric: string;
  value: number;
  /** Extra labels that tell series apart, e.g. {"account": "team"}. */
  tags?: Record<string, string>;
  /** When the value applies (milliseconds). Defaults to the current hour. */
  ts?: number;
}

/**
 * The limit for a metric is saved as a second metric with ".limit" added,
 * e.g. "resend.emails_month.limit". The analytics tile finds it by itself.
 */
export const LIMIT_SUFFIX = ".limit";

/** One line on a chart: a metric plus one set of tags. */
export interface Series {
  metric: string;
  tags: Record<string, string>;
  points: number;
  lastTs: number;
  lastValue: number;
}

export const RANGES = {
  "24h": { label: "Last 24 hours", ms: 24 * 3600_000, bucketHours: 1 },
  "7d": { label: "Last 7 days", ms: 7 * 86400_000, bucketHours: 6 },
  "30d": { label: "Last 30 days", ms: 30 * 86400_000, bucketHours: 24 },
  "90d": { label: "Last 90 days", ms: 90 * 86400_000, bucketHours: 24 },
} as const;
export type RangeKey = keyof typeof RANGES;

export const COMBINE = {
  latest: "Latest value",
  sum: "Total (sum)",
  avg: "Average",
  count: "Number of readings",
} as const;
export type CombineKey = keyof typeof COMBINE;

export interface CollectRun {
  at: number;
  results: { plugin: string; ok: boolean; points: number; error?: string }[];
}

/** What an analytics tile shows, worked out by the server. */
export interface AnalyticsResult {
  ok: boolean;
  error?: string;
  metric?: string;
  tags?: Record<string, string>;
  range?: RangeKey;
  /** The combined value over the range, and over the range before it. */
  value?: number | null;
  previous?: number | null;
  limit?: number | null;
  /** One entry per time bucket; null where nothing was saved. */
  points?: { ts: number; value: number | null }[];
  lastTs?: number | null;
}

/** Tags written as a stable key, so {"a":1,"b":2} and {"b":2,"a":1} match. */
export function tagKey(tags: Record<string, string> | undefined): string {
  const t = tags ?? {};
  return JSON.stringify(Object.fromEntries(Object.keys(t).sort().map((k) => [k, String(t[k])])));
}

/** How a series is named in pickers, e.g. "netlify.bandwidth_bytes · account=team". */
export function seriesLabel(metric: string, tags: Record<string, string>): string {
  const t = Object.entries(tags).map(([k, v]) => `${k}=${v}`).join(", ");
  return t ? `${metric} · ${t}` : metric;
}

export function formatValue(metric: string, n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (/_bytes(\.limit)?$/.test(metric)) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = n;
    while (Math.abs(v) >= 1000 && i < units.length - 1) {
      v /= 1000;
      i++;
    }
    return `${Math.abs(v) < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0 }).format(n);
}
