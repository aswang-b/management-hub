// The hourly job that saves plugin numbers for analytics tiles. Every plugin
// tile whose plugin has a `collect` step is asked for its numbers once an
// hour, while the hub is running. One failing plugin doesn't stop the rest.
import { cacheGet, cacheSet, listPluginTools } from "./db.ts";
import { getPlugin, runCollect } from "./plugins/index.ts";
import { hourStart, savePoints } from "./metrics.ts";
import type { CollectRun } from "../shared/metrics.ts";

const LAST_RUN_KEY = "metrics:lastRun";
const CHECK_MS = 5 * 60_000;
let running: Promise<CollectRun> | undefined;

export function lastRun(): CollectRun | undefined {
  const hit = cacheGet(LAST_RUN_KEY, Infinity);
  return hit ? JSON.parse(String(hit.value)) : undefined;
}

export function collectAll(now = Date.now()): Promise<CollectRun> {
  // If a run is already going (e.g. "Collect now" during the hourly run), share it.
  running ??= collect(now).finally(() => (running = undefined));
  return running;
}

async function collect(now: number): Promise<CollectRun> {
  const results: CollectRun["results"] = [];
  const seen = new Set<string>();
  for (const tool of listPluginTools()) {
    const plugin = getPlugin(tool.type);
    if (!plugin?.collect) continue;
    // Two tiles with the same settings would save the same numbers.
    const key = `${plugin.id}:${JSON.stringify(tool.config)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const r = await runCollect(plugin, tool.config);
    let error = r.error;
    let saved = 0;
    if (r.ok) {
      try {
        saved = savePoints(r.points, `plugin:${plugin.id}`, now);
      } catch (e) {
        error = (e as Error).message;
      }
    }
    results.push({ plugin: plugin.name, ok: !error, points: saved, ...(error ? { error } : {}) });
    if (error) console.log(`Analytics: ${plugin.name} couldn't save its numbers: ${error}`);
  }
  const run = { at: now, results };
  cacheSet(LAST_RUN_KEY, JSON.stringify(run), "application/json");
  return run;
}

/** Collects when the hub starts (if this hour isn't done yet), then once every hour. */
export function startCollector() {
  const tick = () => {
    const last = lastRun();
    if (!last || hourStart(last.at) < hourStart(Date.now())) collectAll().catch((e) => console.log(`Analytics collection failed: ${e}`));
  };
  setTimeout(tick, 5_000);
  // Checking every few minutes (rather than one timer per hour) copes with
  // the computer sleeping: it catches up soon after waking.
  setInterval(tick, CHECK_MS).unref();
}
