// Plugin tests with a fake internet: each test lists the API responses a
// service would send, then checks what the tile shows and which requests
// the buttons make. Run with `npm test`.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runAction, runCollect, runLoad } from "./index.ts";
import { github } from "./github.ts";
import { supabase } from "./supabase.ts";
import { netlify } from "./netlify.ts";
import { cloudflare } from "./cloudflare.ts";
import { resend } from "./resend.ts";
import { google } from "./google.ts";
import { status } from "./status.ts";

type Route = [method: string, pattern: RegExp, body: unknown, status?: number];
let routes: Route[] = [];
let calls: { method: string; url: string; body?: any; auth?: string }[] = [];
const realFetch = globalThis.fetch;
let n = 0;
const id = () => `tool-${++n}`; // fresh id per call so the result cache never interferes

beforeEach(() => {
  routes = [];
  calls = [];
  process.env.GITHUB_TOKEN = "gh-test";
  process.env.SUPABASE_ACCESS_TOKEN = "sb-test";
  process.env.NETLIFY_TOKEN = "nf-test";
  process.env.CLOUDFLARE_API_TOKEN = "cf-test";
  process.env.RESEND_API_KEY = "rs-test";
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization });
    const r = routes.find(([m, p]) => m === method && p.test(url));
    if (!r) return new Response(JSON.stringify({ message: "no fake route" }), { status: 404 });
    return new Response(r[2] === null ? null : JSON.stringify(r[2]), { status: r[3] ?? 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const now = new Date().toISOString();

// ---- GitHub
const ghRoutes = (): Route[] => [
  ["GET", /\/repos\/me\/site$/, { default_branch: "main", open_issues_count: 5, pushed_at: now }],
  ["GET", /\/actions\/runs\?/, { workflow_runs: [
    { id: 11, name: "CI", display_title: "Fix nav", status: "completed", conclusion: "failure", head_branch: "main", html_url: "u", created_at: now },
    { id: 10, name: "CI", display_title: "Add page", status: "completed", conclusion: "success", head_branch: "main", html_url: "u", created_at: now },
  ] }],
  ["GET", /\/pulls\?/, [{ number: 3, title: "Update deps", user: { login: "bot" }, updated_at: now, html_url: "u" }]],
  ["GET", /\/actions\/workflows\?/, { workflows: [{ id: 99, name: "Deploy", path: ".github/workflows/deploy.yml", state: "active", html_url: "u" }] }],
  ["GET", /\/dependabot\/alerts/, [{}, {}]],
];

test("github: shows runs, PRs, issues and alerts", async () => {
  routes = ghRoutes();
  const r = await runLoad(github, id(), { repo: "me/site" });
  assert.ok(r.ok, r.error ?? "");
  assert.equal(r.view!.status!.tone, "bad");
  const stats = Object.fromEntries(r.view!.stats!.map((s) => [s.label, s.value]));
  assert.equal(stats["Open PRs"], "1");
  assert.equal(stats["Open issues"], "4");
  assert.equal(stats["Security alerts"], "2");
  const runs = r.view!.sections![0].items;
  assert.equal(runs[0].actions![0].id, "rerunFailed");
  assert.equal(calls[0].auth, "Bearer gh-test");
});

test("github: accepts a full GitHub URL as the repo", async () => {
  routes = ghRoutes();
  const r = await runLoad(github, id(), { repo: "https://github.com/me/site" });
  assert.ok(r.ok, r.error ?? "");
});

test("github: buttons call the right endpoints", async () => {
  routes = [["POST", /.*/, null, 204]];
  assert.ok((await runAction(github, id(), { repo: "me/site" }, "rerunFailed", { runId: 11 })).ok);
  assert.match(calls[0].url, /\/repos\/me\/site\/actions\/runs\/11\/rerun-failed-jobs$/);
  assert.ok((await runAction(github, id(), { repo: "me/site" }, "dispatch", { workflowId: 99, ref: "main" })).ok);
  assert.match(calls[1].url, /\/actions\/workflows\/99\/dispatches$/);
  assert.deepEqual(calls[1].body, { ref: "main" });
});

test("github: explains a bad token", async () => {
  routes = [["GET", /.*/, { message: "Bad credentials" }, 401]];
  const r = await runLoad(github, id(), { repo: "me/site" });
  assert.equal(r.errorKind, "auth");
  assert.match(r.error!, /GITHUB_TOKEN/);
});

test("github: missing token is a setup problem", async () => {
  delete process.env.GITHUB_TOKEN;
  const r = await runLoad(github, id(), { repo: "me/site" });
  assert.equal(r.errorKind, "setup");
  assert.match(r.error!, /needs GITHUB_TOKEN\. Press "Add token"/);
});

test("github: flags a changed API response", async () => {
  routes = [["GET", /.*/, { something: "else" }]];
  const r = await runLoad(github, id(), { repo: "me/site" });
  assert.equal(r.errorKind, "changed");
});

// ---- Supabase
test("supabase: paused project offers restore", async () => {
  routes = [
    ["GET", /\/projects\/abc$/, { status: "INACTIVE", region: "us-east-1" }],
    ["GET", /\/backups$/, { backups: [] }],
  ];
  const r = await runLoad(supabase, id(), { projectRef: "abc" });
  assert.ok(r.ok, r.error ?? "");
  assert.equal(r.view!.status!.label, "Paused");
  assert.equal(r.view!.actions![0].id, "restore");
  assert.ok(r.view!.notice);
});

test("supabase: active project shows DB size against the limit", async () => {
  routes = [
    ["GET", /\/projects\/abc$/, { status: "ACTIVE_HEALTHY", region: "us-east-1" }],
    ["GET", /\/health\?/, [{ name: "db", healthy: true, status: "ACTIVE_HEALTHY" }]],
    ["POST", /\/database\/query\/read-only$/, [{ bytes: 450e6 }]],
    ["GET", /\/backups$/, { backups: [{ inserted_at: now, status: "COMPLETED" }] }],
  ];
  const r = await runLoad(supabase, id(), { projectRef: "abc" });
  assert.ok(r.ok, r.error ?? "");
  const size = r.view!.stats!.find((s) => s.label === "Database size")!;
  assert.equal(size.tone, "warn");
  assert.equal(r.view!.actions![0].id, "pause");
  routes = [["POST", /.*/, {}]];
  assert.ok((await runAction(supabase, id(), { projectRef: "abc" }, "restore", {})).ok);
  assert.match(calls.at(-1)!.url, /\/v1\/projects\/abc\/restore$/);
});

test("supabase: reads the database size with a read-only query (scoped tokens need only Database: Read)", async () => {
  routes = [
    ["GET", /\/projects\/abc$/, { status: "ACTIVE_HEALTHY", region: "us-east-1" }],
    ["GET", /\/health\?/, []],
    // Some responses wrap the rows in an object.
    ["POST", /\/database\/query\/read-only$/, { result: [{ bytes: 100e6 }] }],
    ["GET", /\/backups$/, { backups: [] }],
  ];
  const r = await runLoad(supabase, id(), { projectRef: "abc" });
  assert.ok(r.ok, r.error ?? "");
  assert.match(r.view!.stats!.find((s) => s.label === "Database size")!.value, /^100 MB/);
  const query = calls.find((c) => c.method === "POST")!;
  assert.match(query.url, /\/database\/query\/read-only$/);
  assert.match(query.body.query, /pg_catalog\.pg_database_size/);
});

// ---- Netlify
test("netlify: deploys with retry and rollback", async () => {
  routes = [
    ["GET", /\/sites\/my\.netlify\.app$/, { id: "s1", name: "my", url: "http://my", ssl_url: "https://my", account_slug: "team", published_deploy: { id: "d2", published_at: now } }],
    ["GET", /\/sites\/s1\/deploys\?/, [
      { id: "d3", state: "error", context: "production", branch: "main", created_at: now, error_message: "Build failed" },
      { id: "d2", state: "ready", context: "production", branch: "main", created_at: now },
      { id: "d1", state: "ready", context: "production", branch: "main", created_at: now },
    ]],
    ["GET", /\/accounts\/team\/bandwidth$/, { used: 90e9, included: 100e9 }],
  ];
  const r = await runLoad(netlify, id(), { site: "https://my.netlify.app/" });
  assert.ok(r.ok, r.error ?? "");
  const [failed, live, old] = r.view!.sections![0].items;
  assert.equal(failed.actions![0].id, "retry");
  assert.match(live.title, /^LIVE/);
  assert.equal(live.actions!.length, 0);
  assert.equal(old.actions![0].id, "publish");
  assert.equal(r.view!.stats!.find((s) => s.label.startsWith("Bandwidth"))!.tone, "warn");

  routes.push(["POST", /.*/, {}]);
  assert.ok((await runAction(netlify, id(), { site: "my.netlify.app" }, "publish", { deployId: "d1" })).ok);
  assert.match(calls.at(-1)!.url, /\/sites\/s1\/deploys\/d1\/restore$/);
  assert.ok((await runAction(netlify, id(), { site: "my.netlify.app" }, "buildClean", {})).ok);
  assert.deepEqual(calls.at(-1)!.body, { clear_cache: true });
});

// ---- Cloudflare
test("cloudflare: zone info, traffic, purge and dev mode", async () => {
  routes = [
    ["GET", /\/zones\?name=example\.com$/, { success: true, result: [{ id: "z1", name: "example.com", status: "active", plan: { name: "Free" }, account: { id: "a1" } }] }],
    ["GET", /development_mode$/, { success: true, result: { value: "off" } }],
    ["GET", /settings\/ssl$/, { success: true, result: { value: "full" } }],
    ["GET", /dns_records/, { success: true, result: [], result_info: { total_count: 7 } }],
    ["POST", /\/graphql$/, { data: { viewer: { zones: [{ httpRequests1dGroups: [
      { sum: { requests: 1000, bytes: 5e6, cachedRequests: 600, threats: 0, pageViews: 300 }, uniq: { uniques: 50 } },
      { sum: { requests: 500, bytes: 2e6, cachedRequests: 150, threats: 2, pageViews: 100 }, uniq: { uniques: 30 } },
    ] }] } } }],
  ];
  const r = await runLoad(cloudflare, id(), { zone: "https://example.com/" });
  assert.ok(r.ok, r.error ?? "");
  const stats = Object.fromEntries(r.view!.stats!.map((s) => [s.label, s.value]));
  assert.equal(stats["Requests (7d)"], "1,500");
  assert.equal(stats["Cached (7d)"], "50%");
  assert.equal(stats["DNS records"], "7");
  assert.equal(stats["SSL mode"], "full");

  routes.push(["POST", /purge_cache$/, { success: true, result: { id: "z1" } }]);
  routes.push(["PATCH", /development_mode$/, { success: true, result: { value: "on" } }]);
  assert.ok((await runAction(cloudflare, id(), { zone: "example.com" }, "purge", {})).ok);
  assert.deepEqual(calls.at(-1)!.body, { purge_everything: true });
  assert.ok((await runAction(cloudflare, id(), { zone: "example.com" }, "devMode", { on: true })).ok);
  assert.deepEqual(calls.at(-1)!.body, { value: "on" });
});

// ---- Resend
test("resend: counts this month's emails across pages and flags unverified domains", async () => {
  const lastMonth = new Date(Date.now() - 40 * 86400_000).toISOString();
  routes = [
    ["GET", /\/domains$/, { data: [{ id: "dm1", name: "site.com", status: "verified" }, { id: "dm2", name: "new.com", status: "pending" }] }],
    ["GET", /\/emails\?limit=100&after=e2$/, { has_more: false, data: [{ id: "e3", to: ["c"], subject: "Hi", created_at: now, last_event: "bounced" }, { id: "e4", to: ["d"], created_at: lastMonth, last_event: "delivered" }] }],
    ["GET", /\/emails\?limit=100$/, { has_more: true, data: [{ id: "e1", to: ["a"], subject: "Hi", created_at: now, last_event: "delivered" }, { id: "e2", to: ["b"], subject: "Hi", created_at: now, last_event: "delivered" }] }],
  ];
  const r = await runLoad(resend, id(), { monthlyLimit: "3000" });
  assert.ok(r.ok, r.error ?? "");
  assert.equal(r.view!.status!.tone, "warn");
  const stats = Object.fromEntries(r.view!.stats!.map((s) => [s.label, s.value]));
  assert.equal(stats["Sent this month"], "3 / 3,000");
  assert.equal(stats["Bounced / complaints"], "1");
  assert.equal(r.view!.sections![0].items[1].actions![0].id, "verifyDomain");
  assert.equal(r.view!.actions!.length, 0); // no test addresses configured
});

test("resend: saves email counts and limits for analytics", async () => {
  routes = [["GET", /\/emails\?limit=100$/, { has_more: false, data: [
    { id: "e1", to: ["a"], created_at: now, last_event: "delivered" },
    { id: "e2", to: ["b"], created_at: now, last_event: "bounced" },
  ] }]];
  const r = await runCollect(resend, { monthlyLimit: "50000" });
  assert.ok(r.ok, r.error ?? "");
  const got = Object.fromEntries(r.points.map((p) => [p.metric, p.value]));
  assert.deepEqual(got, {
    "resend.emails_today": 2,
    "resend.emails_today.limit": 100,
    "resend.emails_month": 2,
    "resend.emails_month.limit": 50000,
    "resend.bounces_month": 1,
  });
});

test("netlify: saves bandwidth and the plan's allowance, tagged by team", async () => {
  routes = [
    ["GET", /\/sites\/my\.netlify\.app$/, { id: "s1", name: "my", account_slug: "team" }],
    ["GET", /\/accounts\/team\/bandwidth$/, { used: 90e9, included: 100e9 }],
  ];
  const r = await runCollect(netlify, { site: "my.netlify.app" });
  assert.ok(r.ok, r.error ?? "");
  assert.deepEqual(r.points, [
    { metric: "netlify.bandwidth_bytes", value: 90e9, tags: { account: "team" } },
    { metric: "netlify.bandwidth_bytes.limit", value: 100e9, tags: { account: "team" } },
  ]);
});

const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
const creditRoutes = (used: number, extra: object = {}): Route[] => [
  ["GET", /\/sites\/my\.netlify\.app$/, { id: "s1", name: "my", account_slug: "team", published_deploy: { id: "d1" } }],
  ["GET", /\/sites\/s1\/deploys\?/, []],
  ["GET", /\/accounts$/, [{ id: "a1", slug: "team", capabilities: { credits: { included: 3000, used } }, next_usage_period_start: inDays(17), ...extra }]],
];

test("netlify: shows credits left and what they're worth", async () => {
  routes = creditRoutes(660);
  const r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.ok(r.ok, r.error ?? "");
  const stats = Object.fromEntries(r.view!.stats!.map((s) => [s.label, s]));
  assert.equal(stats["Credits used"].value, "660 / 3,000");
  assert.deepEqual(stats["Credits used"].limit, { used: 660, max: 3000 });
  assert.equal(stats["Credits left"].value, "2,340");
  assert.match(stats["Credits reset"].value, /in 1[78] days/);
  assert.equal(stats["Bandwidth this period"], undefined); // credits replace the bandwidth bar
  // 2,340 credits = 156 deploys (15 each), 11.7M requests (2 per 10k), 234 GB-hours (10 each), 117 GB (20 per GB).
  const worth = r.view!.sections![0].items.map((i) => i.title);
  assert.deepEqual(worth, ["156 production deploys", "11.7M web requests", "234 GB-hours of compute", "117 GB of bandwidth"]);
  assert.equal(r.view!.notice, undefined);
});

test("netlify: warns when credits run low or out", async () => {
  routes = creditRoutes(2500);
  let r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.equal(r.view!.stats!.find((s) => s.label === "Credits left")!.tone, "warn");

  routes = creditRoutes(3000);
  r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.equal(r.view!.stats!.find((s) => s.label === "Credits left")!.tone, "bad");
  assert.match(r.view!.notice!, /credits are used up/);

  // Netlify can flag a team as over its limit even with credits showing.
  routes = creditRoutes(10, { usages_exceeded: ["credits"] });
  r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.match(r.view!.notice!, /New production deploys are blocked/);
});

test("netlify: reads credits from the team's own page when the list leaves them out", async () => {
  routes = [
    ...creditRoutes(0).slice(0, 2),
    ["GET", /\/accounts$/, [{ id: "a1", slug: "team" }]],
    ["GET", /\/accounts\/a1$/, { id: "a1", slug: "team", capabilities: { credits: { included: 300, used: 150 } } }],
  ];
  const r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.equal(r.view!.stats!.find((s) => s.label === "Credits left")!.value, "150");
});

test("netlify: saves credits for analytics on credit-based plans", async () => {
  routes = creditRoutes(660); // no bandwidth endpoint on these plans
  const r = await runCollect(netlify, { site: "my.netlify.app" });
  assert.ok(r.ok, r.error ?? "");
  const tags = { account: "team" };
  assert.deepEqual(r.points, [
    { metric: "netlify.credits_used", value: 660, tags },
    { metric: "netlify.credits_used.limit", value: 3000, tags },
    { metric: "netlify.credits_left", value: 2340, tags },
  ]);
});

test("netlify: a changed bandwidth response is reported, not saved", async () => {
  routes = [
    ["GET", /\/sites\/my\.netlify\.app$/, { id: "s1", name: "my", account_slug: "team" }],
    ["GET", /\/accounts\/team\/bandwidth$/, { credits: 5 }],
  ];
  const r = await runCollect(netlify, { site: "my.netlify.app" });
  assert.equal(r.ok, false);
  assert.match(r.error!, /needs an update/);
});

// ---- Google and status (no tokens)
test("google: builds console links for the project", async () => {
  routes = [["GET", /incidents\.json$/, [{ external_desc: "Old", end: now }]]];
  const r = await runLoad(google, id(), { projectId: "p-1" });
  assert.ok(r.ok, r.error ?? "");
  assert.equal(r.view!.links![0].url, "https://console.cloud.google.com/auth/audience?project=p-1");
  assert.equal(r.view!.status!.tone, "ok");
});

test("status: reports each service and the overall state", async () => {
  routes = [
    ["GET", /githubstatus/, { status: { indicator: "none", description: "All Systems Operational" }, incidents: [] }],
    ["GET", /netlifystatus/, { status: { indicator: "minor", description: "Minor Service Outage" }, incidents: [{ name: "Slow builds" }] }],
  ];
  const r = await runLoad(status, id(), { services: "github, netlify" });
  assert.ok(r.ok, r.error ?? "");
  assert.equal(r.view!.status!.tone, "warn");
  assert.match(r.view!.sections![0].items[1].subtitle!, /Slow builds/);
});
