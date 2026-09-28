// Tests for the analytics module: saving numbers, what a tile shows, and the
// hourly collection. Uses a throwaway in-memory database and a fake internet.
import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.HUB_DB = ":memory:";
const db = await import("./db.ts");
const { savePoints, listSeries, analytics, seriesValue } = await import("./metrics.ts");
const { collectAll, lastRun } = await import("./collector.ts");

const HOUR = 3600_000;
const NOW = new Date(2026, 8, 28, 12, 30).getTime(); // a fixed "now" so results don't depend on the clock
const realFetch = globalThis.fetch;
after(() => (globalThis.fetch = realFetch));

const rows = (metric: string) =>
  db.db.prepare("SELECT ts, value, tags FROM metrics WHERE metric = ? ORDER BY ts").all(metric) as any[];

test("saving twice in the same hour replaces the reading", () => {
  savePoints([{ metric: "t.visits", value: 5, tags: { b: "2", a: "1" } }], "test", NOW);
  savePoints([{ metric: "t.visits", value: 7, tags: { a: "1", b: "2" } }], "test", NOW + 10 * 60_000);
  const r = rows("t.visits");
  assert.equal(r.length, 1);
  assert.equal(r[0].value, 7);
  assert.equal(r[0].ts % HOUR, 0); // stored at the start of the hour
});

test("a bad point saves nothing from that batch", () => {
  assert.throws(() => savePoints([{ metric: "t.ok", value: 1 }, { metric: "no spaces allowed", value: 2 }], "test", NOW), /valid metric name/);
  assert.throws(() => savePoints([{ metric: "t.ok", value: NaN }], "test", NOW), /must be a number/);
  assert.equal(rows("t.ok").length, 0);
});

test("the metric list hides limits and shows the latest value", () => {
  savePoints([{ metric: "t.list", value: 1, ts: NOW - 2 * HOUR }, { metric: "t.list", value: 3, ts: NOW - HOUR }], "test");
  savePoints([{ metric: "t.list.limit", value: 10 }], "test", NOW);
  const s = listSeries().filter((x) => x.metric.startsWith("t.list"));
  assert.deepEqual(s.map((x) => [x.metric, x.points, x.lastValue]), [["t.list", 2, 3]]);
});

test("a tile combines the range and compares with the range before", () => {
  const day = 24 * HOUR;
  savePoints(
    [
      { metric: "t.emails", value: 10, ts: NOW - 30 * HOUR }, // previous 24h
      { metric: "t.emails", value: 20, ts: NOW - 5 * HOUR },
      { metric: "t.emails", value: 40, ts: NOW - 2 * HOUR },
      { metric: "t.emails", value: 99, ts: NOW - 3 * day }, // outside both ranges
    ],
    "test",
  );
  const series = seriesValue("t.emails", {});
  const get = (combine: string) => analytics({ series, range: "24h", combine }, NOW);
  assert.equal(get("latest").value, 40);
  assert.equal(get("latest").previous, 10);
  assert.equal(get("sum").value, 60);
  assert.equal(get("avg").value, 30);
  assert.equal(get("count").value, 2);

  const r = get("latest");
  assert.equal(r.points!.length, 24); // one per hour
  assert.equal(r.points!.filter((p) => p.value !== null).length, 2); // gaps stay empty
  assert.equal(r.points!.at(-1)!.ts, NOW - 30 * 60_000); // last bucket is the current hour
  assert.equal(r.lastTs, NOW - 2 * HOUR);
});

test("a tile finds the plugin's limit, unless one is typed or turned off", () => {
  const tags = { account: "team" };
  savePoints([{ metric: "t.bw_bytes", value: 80, tags }, { metric: "t.bw_bytes.limit", value: 100, tags }], "test", NOW);
  const series = seriesValue("t.bw_bytes", tags);
  assert.equal(analytics({ series }, NOW).limit, 100);
  assert.equal(analytics({ series, limit: 500 }, NOW).limit, 500);
  assert.equal(analytics({ series, limit: 0 }, NOW).limit, null);
  assert.deepEqual(analytics({ series }, NOW).tags, tags);
});

test("a tile without a metric asks for one", () => {
  const r = analytics({}, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error!, /Pick a metric/);
});

test("the hourly collection saves each plugin's numbers and survives a failing one", async () => {
  process.env.RESEND_API_KEY = "rs-test";
  process.env.NETLIFY_TOKEN = "bad";
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("api.resend.com/emails")) {
      return new Response(JSON.stringify({ has_more: false, data: [{ id: "e1", created_at: new Date().toISOString() }] }));
    }
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }) as typeof fetch;

  const p = db.createProject("Test");
  const tool = (type: string, config: Record<string, unknown>) =>
    db.createTool({ projectId: p.id, category: "plugin", type, x: 0, y: 0, w: 2, h: 2, config });
  tool("resend", {});
  tool("resend", {}); // same settings: collected once
  tool("netlify", { site: "my.netlify.app" });
  tool("github", { repo: "me/site" }); // no collect step: skipped

  const run = await collectAll(NOW);
  assert.deepEqual(
    run.results.map((r) => [r.plugin, r.ok, r.points]),
    [["Resend", true, 5], ["Netlify", false, 0]],
  );
  assert.match(run.results[1].error!, /NETLIFY_TOKEN/);
  assert.equal(rows("resend.emails_month")[0].value, 1);
  assert.equal(lastRun()!.at, NOW);
});
