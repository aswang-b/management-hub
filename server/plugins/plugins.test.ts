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
import { vercel } from "./vercel.ts";

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
  process.env.VERCEL_TOKEN = "vc-test";
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization });
    const r = routes.find(([m, p]) => m === method && p.test(url));
    if (!r) return new Response(JSON.stringify({ message: "no fake route" }), { status: 404 });
    // A string body is sent as-is (e.g. JSON Lines); anything else as JSON.
    return new Response(r[2] === null ? null : typeof r[2] === "string" ? r[2] : JSON.stringify(r[2]), { status: r[3] ?? 200 });
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

const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
const deploy = (daysAgo: number, state = "ready", context = "production") => ({ id: `d${Math.random()}`, state, context, created_at: inDays(-daysAgo) });
// A team on a credit plan. Netlify reports the allowance and period but always "used: 0".
const creditRoutes = (o: { deploys?: object[]; bandwidth?: number; used?: number; extra?: object } = {}): Route[] => [
  ["GET", /\/sites\/my\.netlify\.app$/, { id: "s1", name: "my", account_slug: "team", published_deploy: { id: "d1" } }],
  ["GET", /\/sites\?filter=all/, [{ id: "s1", account_slug: "team" }, { id: "s9", account_slug: "someone-else" }]],
  ["GET", /\/sites\/s1\/deploys\?production=true&per_page=100&page=1$/, o.deploys ?? []],
  ["GET", /\/sites\/s9\/deploys/, [deploy(1), deploy(1)]], // another team's site: never counted
  ["GET", /\/sites\/s1\/deploys\?/, []],
  ["GET", /\/accounts\/team\/bandwidth$/, { used: o.bandwidth ?? 0, included: null }],
  ["GET", /\/accounts$/, [{
    id: "a1", slug: "team", capabilities: { credits: { included: 300, used: o.used ?? 0 } },
    current_usage_period_start: inDays(-20), next_usage_period_start: inDays(10), ...o.extra,
  }]],
];
const fourteenDeploys = [...Array.from({ length: 14 }, (_, i) => deploy(i)), deploy(2, "error"), deploy(30)];

test("netlify: estimates credits used from deploys and bandwidth, since Netlify reports 0", async () => {
  routes = creditRoutes({ deploys: fourteenDeploys, bandwidth: 153406447 });
  const r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.ok(r.ok, r.error ?? "");
  const stats = Object.fromEntries(r.view!.stats!.map((s) => [s.label, s]));
  // 14 successful production deploys this period x 15 = 210, plus 0.153 GB x 20 = 3 (the failed and last-period deploys are free).
  assert.equal(stats["Credits used (est.)"].value, "~213 / 300");
  assert.deepEqual(stats["Credits used (est.)"].limit, { used: 213, max: 300 });
  assert.equal(stats["Credits left (est.)"].value, "~87");
  assert.match(stats["Credits reset"].value, /in (9|10) days/);
  assert.equal(stats["Bandwidth this period"], undefined);

  const [worth, spent] = r.view!.sections!;
  // 87 credits = 5 deploys, 430K requests, 8.7 GB-hours, 4.35 GB of bandwidth.
  assert.deepEqual(worth.items.map((i) => i.title), ["5 production deploys", "430K web requests", "8.7 GB-hours of compute", "4.3 GB of bandwidth"]);
  assert.match(spent.title, /estimate/);
  assert.equal(spent.items[0].title, "14 production deploys: 210 credits");
  assert.equal(spent.items[1].title, "153 MB bandwidth: 3 credits");
  assert.match(spent.items[2].title, /not included/);
  assert.equal(r.view!.notice, undefined);
});

test("netlify: adds compute and web-request credits typed in by hand", async () => {
  routes = creditRoutes({ deploys: fourteenDeploys, bandwidth: 153406447 });
  const config = { site: "my.netlify.app", computeCredits: 21, computeCreditsAt: inDays(-1), requestCredits: 5.7, requestCreditsAt: inDays(0) };
  let r = await runLoad(netlify, id(), config);
  // 210 deploys + 3 bandwidth + 21 compute + 5.7 requests = 239.8
  assert.equal(r.view!.stats!.find((s) => s.label.startsWith("Credits used"))!.value, "~240 / 300");
  const spent = r.view!.sections![1].items.map((i) => i.title);
  assert.deepEqual(spent.slice(2), ["Compute: 21 credits", "Web requests: 5.7 credits"]);

  // A number entered before this period started is last period's usage: left out, with a warning.
  routes = creditRoutes({ deploys: fourteenDeploys, bandwidth: 153406447 });
  r = await runLoad(netlify, id(), { ...config, computeCreditsAt: inDays(-25) });
  assert.equal(r.view!.stats!.find((s) => s.label.startsWith("Credits used"))!.value, "~219 / 300");
  const stale = r.view!.sections![1].items[2];
  assert.match(stale.title, /last period's number/);
  assert.equal(stale.tone, "warn");
});

test("netlify: uses Netlify's own figure if it ever reports more than the estimate", async () => {
  routes = creditRoutes({ deploys: [deploy(1)], used: 120 });
  const r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.equal(r.view!.stats!.find((s) => s.label.startsWith("Credits left"))!.value, "~180");
});

test("netlify: warns when credits run low or out", async () => {
  routes = creditRoutes({ deploys: Array.from({ length: 17 }, () => deploy(1)) }); // 255 of 300
  let r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.equal(r.view!.stats!.find((s) => s.label.startsWith("Credits left"))!.tone, "warn");

  routes = creditRoutes({ deploys: Array.from({ length: 20 }, () => deploy(1)) }); // 300 of 300
  r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.equal(r.view!.stats!.find((s) => s.label.startsWith("Credits left"))!.tone, "bad");
  assert.match(r.view!.notice!, /By the hub's estimate/);

  // Netlify can flag a team as over its limit.
  routes = creditRoutes({ extra: { usages_exceeded: ["credits"] } });
  r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.match(r.view!.notice!, /Netlify says .* New production deploys are blocked/);
});

test("netlify: counts deploys across pages until they're older than the period", async () => {
  routes = creditRoutes();
  routes.unshift(
    ["GET", /deploys\?production=true&per_page=100&page=1$/, Array.from({ length: 100 }, () => deploy(1))],
    ["GET", /deploys\?production=true&per_page=100&page=2$/, [deploy(2), deploy(40)]],
  );
  const r = await runLoad(netlify, id(), { site: "my.netlify.app" });
  assert.equal(r.view!.sections![1].items[0].title, "101 production deploys: 1,515 credits");
  assert.ok(!calls.some((c) => /page=3/.test(c.url)));
});

test("netlify: saves estimated credits for analytics", async () => {
  routes = creditRoutes({ deploys: fourteenDeploys, bandwidth: 153406447 });
  const r = await runCollect(netlify, { site: "my.netlify.app" });
  assert.ok(r.ok, r.error ?? "");
  const tags = { account: "team" };
  assert.deepEqual(r.points, [
    { metric: "netlify.credits_used", value: 213, tags },
    { metric: "netlify.credits_used.limit", value: 300, tags },
    { metric: "netlify.credits_left", value: 87, tags },
    { metric: "netlify.bandwidth_bytes", value: 153406447, tags },
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

// ---- Vercel
const vDeploy = (uid: string, o: { target?: string | null; state?: string; msg?: string; hoursAgo?: number } = {}) => ({
  uid,
  url: `${uid}.vercel.app`,
  inspectorUrl: `https://vercel.com/alex/my-site/${uid}`,
  target: o.target === undefined ? "production" : o.target,
  readyState: o.state ?? "READY",
  created: Date.now() - (o.hoursAgo ?? 1) * 3600_000,
  meta: { githubCommitMessage: o.msg ?? `Commit ${uid}\ndetails`, githubCommitRef: "main" },
});
const charges = [
  { ChargeCategory: "Usage", ServiceName: "Fast Data Transfer", ConsumedQuantity: 12.5, ConsumedUnit: "GB", BilledCost: 0 },
  { ChargeCategory: "Usage", ServiceName: "Fast Data Transfer", ConsumedQuantity: 2.5, ConsumedUnit: "GB", BilledCost: 0 },
  { ChargeCategory: "Usage", ServiceName: "Function Invocations", ConsumedQuantity: 250000, ConsumedUnit: "invocations", BilledCost: 1.5 },
  { ChargeCategory: "Credit", ServiceName: "Pro credit", ConsumedQuantity: null, ConsumedUnit: null, BilledCost: -1.5 },
].map((r) => JSON.stringify(r)).join("\n");
const vercelRoutes = (o: { paused?: boolean; extra?: Route[]; billing?: unknown; billingStatus?: number } = {}): Route[] => [
  ...(o.extra ?? []),
  ["GET", /\/v2\/user$/, { user: { defaultTeamId: "team_1" } }],
  ["GET", /\/v9\/projects\/my-site\?teamId=team_1$/, {
    id: "prj_1", name: "my-site", paused: o.paused ?? false, link: { productionBranch: "main" },
    targets: { production: { id: "live", url: "live.vercel.app", alias: ["site.com"], createdAt: Date.now() - 3600_000 } },
  }],
  ["GET", /\/v7\/deployments\?projectId=prj_1&limit=8&teamId=team_1$/, { deployments: [
    vDeploy("new", { state: "BUILDING", msg: "Add page" }),
    vDeploy("live"),
    vDeploy("old", { hoursAgo: 30 }),
    vDeploy("pr", { target: null }),
  ], pagination: {} }],
  ["GET", /\/v7\/deployments\?limit=100&since=\d+&teamId=team_1$/, { deployments: [vDeploy("a"), vDeploy("b"), vDeploy("c")], pagination: {} }],
  ["GET", /\/v9\/projects\/prj_1\/domains\?teamId=team_1$/, { domains: [{ name: "site.com", verified: true }, { name: "www.site.com", verified: false }] }],
  ["GET", /\/v1\/billing\/charges\?/, o.billing ?? charges, o.billingStatus ?? 200],
];

test("vercel: status, deploys with actions, deploy limit, usage and domains", async () => {
  routes = vercelRoutes();
  const r = await runLoad(vercel, id(), { project: "my-site" });
  assert.ok(r.ok, r.error ?? "");
  assert.equal(r.view!.status!.label, "Deploying (building)"); // the newest production deploy is still building
  const stats = Object.fromEntries(r.view!.stats!.map((s) => [s.label, s]));
  assert.equal(stats["Deploys (24h)"].value, "3 / 100");
  assert.equal(stats["Billed this month"].value, "$0.00"); // usage offset by the plan's credit
  const [deploys, usage, domains] = r.view!.sections!;
  assert.equal(deploys.items[0].title, "Add page");
  assert.equal(deploys.items[0].actions![0].id, "cancel");
  assert.match(deploys.items[1].title, /^LIVE · Commit live/);
  assert.equal(deploys.items[1].actions!.length, 0);
  assert.equal(deploys.items[2].actions![0].id, "rollback");
  assert.ok(deploys.items[2].actions![0].confirm);
  assert.equal(deploys.items[3].actions!.length, 0); // previews aren't rollback targets
  assert.deepEqual(usage.items.map((i) => i.title), ["Function Invocations: 250,000 invocations", "Fast Data Transfer: 15 GB"]);
  assert.equal(domains.items[1].actions![0].id, "verifyDomain");
  assert.deepEqual(r.view!.actions!.map((a) => a.id), ["redeploy"]);
  assert.equal(r.view!.links!.find((l) => l.label === "Usage")!.url, "https://vercel.com/alex/~/usage");
});

test("vercel: says plainly when usage isn't available on the plan", async () => {
  routes = vercelRoutes({ billing: { error: { message: "Only available for Pro and Enterprise teams" } }, billingStatus: 403 });
  const r = await runLoad(vercel, id(), { project: "my-site" });
  assert.ok(r.ok, r.error ?? "");
  assert.equal(r.view!.stats!.find((s) => s.label === "Billed this month"), undefined);
  assert.match(r.view!.sections![1].items[0].title, /Not available through Vercel's API/);
});

test("vercel: a paused project offers Resume, and the deploy limit warns", async () => {
  routes = vercelRoutes({ paused: true });
  const r = await runLoad(vercel, id(), { project: "my-site", deploysPerDay: 3 });
  assert.equal(r.view!.status!.label, "Project paused");
  assert.match(r.view!.notice!, /paused this project/);
  assert.match(r.view!.notice!, /daily deploy limit is used up/);
  assert.equal(r.view!.actions![0].id, "unpause");
  assert.ok(r.view!.actions![0].confirm);
  assert.equal(r.view!.stats!.find((s) => s.label === "Deploys (24h)")!.tone, "bad");
});

test("vercel: uses the team from settings instead of the default", async () => {
  routes = vercelRoutes({ extra: [["GET", /\/v9\/projects\/my-site\?slug=acme$/, { id: "prj_9", name: "my-site", targets: {} }], ["GET", /\?.*slug=acme/, { deployments: [], domains: [] }]] });
  const r = await runLoad(vercel, id(), { project: "my-site", team: "acme" });
  assert.ok(r.ok, r.error ?? "");
  assert.ok(!calls.some((c) => c.url.includes("/v2/user")));
  assert.ok(calls.every((c) => c.url.includes("slug=acme")));
});

test("vercel: buttons call the right endpoints", async () => {
  routes = vercelRoutes({ extra: [["POST", /./, {}], ["PATCH", /./, {}]] });
  const cfg = { project: "my-site" };
  assert.ok((await runAction(vercel, id(), cfg, "redeploy", { deploymentId: "live" })).ok);
  let c = calls.at(-1)!;
  assert.match(c.url, /\/v13\/deployments\?forceNew=1&teamId=team_1$/);
  assert.deepEqual(c.body, { name: "my-site", project: "prj_1", deploymentId: "live", target: "production" });
  assert.equal(c.auth, "Bearer vc-test");
  assert.ok((await runAction(vercel, id(), cfg, "rollback", { deploymentId: "old" })).ok);
  assert.match(calls.at(-1)!.url, /\/v1\/projects\/prj_1\/rollback\/old\?teamId=team_1$/);
  assert.ok((await runAction(vercel, id(), cfg, "cancel", { deploymentId: "new" })).ok);
  c = calls.at(-1)!;
  assert.equal(c.method, "PATCH");
  assert.match(c.url, /\/v12\/deployments\/new\/cancel\?teamId=team_1$/);
  assert.ok((await runAction(vercel, id(), cfg, "unpause", {})).ok);
  assert.match(calls.at(-1)!.url, /\/v1\/projects\/prj_1\/unpause\?teamId=team_1$/);
  assert.ok((await runAction(vercel, id(), cfg, "verifyDomain", { domain: "www.site.com" })).ok);
  assert.match(calls.at(-1)!.url, /\/v9\/projects\/prj_1\/domains\/www\.site\.com\/verify\?teamId=team_1$/);
});

test("vercel: saves deploys and charges for analytics", async () => {
  routes = vercelRoutes();
  const r = await runCollect(vercel, { project: "my-site" });
  assert.ok(r.ok, r.error ?? "");
  const tags = { team: "team_1" };
  assert.deepEqual(r.points, [
    { metric: "vercel.deploys_24h", value: 3, tags },
    { metric: "vercel.deploys_24h.limit", value: 100, tags },
    { metric: "vercel.billed_usd_month", value: 0, tags },
  ]);
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
