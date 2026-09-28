// The analytics module's storage: one `metrics` table in data/hub.db holding
// every saved number (metric, time, value, tags, source), plus the maths an
// analytics tile needs (combine a range, compare with the previous range,
// split into time buckets for a chart).
import { db } from "./db.ts";
import {
  COMBINE, LIMIT_SUFFIX, RANGES, tagKey,
  type AnalyticsResult, type CombineKey, type MetricPoint, type RangeKey, type Series,
} from "../shared/metrics.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS metrics (
    metric TEXT NOT NULL,
    ts INTEGER NOT NULL,
    value REAL NOT NULL,
    tags TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL,
    PRIMARY KEY (metric, tags, ts)
  );
`);

const HOUR = 3600_000;
export const hourStart = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/i;

/**
 * Saves points. A point for the same metric, tags and time replaces the old
 * one, so running a collection twice in one hour doesn't double-count.
 */
export function savePoints(points: MetricPoint[], source: string, now = Date.now()): number {
  const stmt = db.prepare("INSERT OR REPLACE INTO metrics (metric, ts, value, tags, source) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const p of points) {
      if (!NAME.test(p.metric)) throw new Error(`"${p.metric}" isn't a valid metric name (use letters, digits, _ and dots, like "site.visits").`);
      if (!Number.isFinite(p.value)) throw new Error(`${p.metric}: value must be a number.`);
      stmt.run(p.metric, p.ts ?? hourStart(now), p.value, tagKey(p.tags), source);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return points.length;
}

/** Every series with data, for the tile's metric picker. Limits are left out. */
export function listSeries(): Series[] {
  const rows = db
    .prepare(
      `SELECT m.metric, m.tags, COUNT(*) AS points, MAX(m.ts) AS lastTs,
        (SELECT value FROM metrics l WHERE l.metric = m.metric AND l.tags = m.tags ORDER BY ts DESC LIMIT 1) AS lastValue
       FROM metrics m GROUP BY m.metric, m.tags ORDER BY m.metric, m.tags`,
    )
    .all() as any[];
  return rows
    .filter((r) => !r.metric.endsWith(LIMIT_SUFFIX))
    .map((r) => ({ metric: r.metric, tags: JSON.parse(r.tags), points: r.points, lastTs: r.lastTs, lastValue: r.lastValue }));
}

type Pt = { ts: number; value: number };

function readRange(metric: string, tags: string, from: number, to: number): Pt[] {
  return db
    .prepare("SELECT ts, value FROM metrics WHERE metric = ? AND tags = ? AND ts > ? AND ts <= ? ORDER BY ts")
    .all(metric, tags, from, to) as Pt[];
}

function latest(metric: string, tags: string): Pt | undefined {
  return db.prepare("SELECT ts, value FROM metrics WHERE metric = ? AND tags = ? ORDER BY ts DESC LIMIT 1").get(metric, tags) as Pt | undefined;
}

export function combine(points: Pt[], how: CombineKey): number | null {
  if (how === "count") return points.length;
  if (!points.length) return null;
  if (how === "latest") return points[points.length - 1].value;
  const sum = points.reduce((s, p) => s + p.value, 0);
  return how === "sum" ? sum : sum / points.length;
}

/** Start of the time bucket a moment falls in, in this computer's time zone. */
function bucketStart(ms: number, hours: number): number {
  const d = new Date(ms);
  if (hours >= 24) d.setHours(0, 0, 0, 0);
  else d.setHours(Math.floor(d.getHours() / hours) * hours, 0, 0, 0);
  return d.getTime();
}

/** The bucket after `b`. Steps past daylight-saving changes instead of repeating a bucket. */
function nextBucket(b: number, hours: number): number {
  const next = bucketStart(b + hours * HOUR, hours);
  return next > b ? next : bucketStart(b + (hours + 1) * HOUR, hours);
}

export interface AnalyticsConfig {
  /** The series, as `metric` + "|" + tag key (the picker's value). */
  series?: unknown;
  range?: unknown;
  combine?: unknown;
  /** Empty: use the saved ".limit" metric if there is one. 0: no limit. */
  limit?: unknown;
}

export const seriesValue = (metric: string, tags: Record<string, string>) => `${metric}|${tagKey(tags)}`;

export function analytics(config: AnalyticsConfig, now = Date.now()): AnalyticsResult {
  const [metric, tags = "{}"] = String(config.series ?? "").split(/\|(.*)/s);
  if (!metric) return { ok: false, error: "Pick a metric in this tile's settings (⚙ in builder mode)." };
  const range: RangeKey = String(config.range) in RANGES ? (String(config.range) as RangeKey) : "7d";
  const how: CombineKey = String(config.combine) in COMBINE ? (String(config.combine) as CombineKey) : "latest";
  const { ms, bucketHours } = RANGES[range];

  const current = readRange(metric, tags, now - ms, now);
  const previous = readRange(metric, tags, now - 2 * ms, now - ms);

  // One entry per bucket, so gaps (hub not running) show as gaps.
  const byBucket = new Map<number, Pt[]>();
  for (const p of current) {
    const b = bucketStart(p.ts, bucketHours);
    byBucket.set(b, [...(byBucket.get(b) ?? []), p]);
  }
  const points: AnalyticsResult["points"] = [];
  for (let b = nextBucket(bucketStart(now - ms, bucketHours), bucketHours); b <= now; b = nextBucket(b, bucketHours)) {
    points.push({ ts: b, value: byBucket.has(b) ? combine(byBucket.get(b)!, how) : null });
  }

  const typed = config.limit === undefined || config.limit === null || config.limit === "" ? undefined : Number(config.limit);
  const limit = typed === undefined || !Number.isFinite(typed) ? latest(metric + LIMIT_SUFFIX, tags)?.value ?? null : typed > 0 ? typed : null;

  return {
    ok: true,
    metric,
    tags: JSON.parse(tags),
    range,
    value: combine(current, how),
    previous: previous.length ? combine(previous, how) : null,
    limit,
    points,
    lastTs: latest(metric, tags)?.ts ?? null,
  };
}
