// Charts for the analytics tile, in black and white. Small tiles get a
// hand-drawn sparkline; larger ones a full chart from Recharts.
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatValue, type AnalyticsResult, type RangeKey } from "../../../shared/metrics.ts";

type Points = NonNullable<AnalyticsResult["points"]>;

/** A small line with no axes. Gaps (no reading) break the line. */
export function Sparkline({ points }: { points: Points }) {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (values.length < 2) return <div className="an-nochart muted">Not enough readings for a chart yet</div>;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const x = (i: number) => (i / Math.max(1, points.length - 1)) * 100;
  const y = (v: number) => 28 - ((v - min) / span) * 26;

  // One polyline per unbroken run of readings.
  const runs: string[][] = [[]];
  points.forEach((p, i) => {
    if (p.value === null) runs.push([]);
    else runs[runs.length - 1].push(`${x(i).toFixed(2)},${y(p.value).toFixed(2)}`);
  });
  return (
    <svg className="an-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      {runs
        .filter((r) => r.length)
        .map((r, i) =>
          r.length === 1 ? (
            <circle key={i} cx={r[0].split(",")[0]} cy={r[0].split(",")[1]} r="1.2" />
          ) : (
            <polyline key={i} points={r.join(" ")} />
          ),
        )}
    </svg>
  );
}

function timeLabel(ts: number, range: RangeKey, withDay = false) {
  const d = new Date(ts);
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (range === "24h") return withDay ? `${day} ${time}` : time;
  return withDay && range === "7d" ? `${day} ${time}` : day;
}

/** Full chart with axes, a hover readout and the limit as a dashed line. */
export function FullChart({ result }: { result: AnalyticsResult }) {
  const metric = result.metric ?? "";
  const range = result.range ?? "7d";
  const limit = result.limit ?? null;
  const fmt = (v: number) => formatValue(metric, v);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={result.points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="currentColor" strokeOpacity={0.12} vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(ts: number) => timeLabel(ts, range)}
          stroke="currentColor"
          tick={{ fill: "currentColor", fontSize: 11 }}
          minTickGap={24}
        />
        <YAxis
          width={56}
          tickFormatter={fmt}
          stroke="currentColor"
          tick={{ fill: "currentColor", fontSize: 11 }}
          domain={[0, (max: number) => Math.max(max, limit ?? 0)]}
        />
        <Tooltip
          isAnimationActive={false}
          cursor={{ stroke: "currentColor", strokeDasharray: "2 2" }}
          labelFormatter={(ts) => timeLabel(Number(ts), range, true)}
          formatter={(v) => [fmt(Number(v)), "Value"]}
          contentStyle={{ border: "1px solid #000", borderRadius: 0, background: "#fff", color: "#000", fontSize: 12, padding: "4px 8px" }}
        />
        {limit !== null && (
          <ReferenceLine y={limit} stroke="currentColor" strokeDasharray="5 4" label={{ value: `Limit ${fmt(limit)}`, position: "insideTopRight", fill: "currentColor", fontSize: 11 }} />
        )}
        <Line type="linear" dataKey="value" stroke="currentColor" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
