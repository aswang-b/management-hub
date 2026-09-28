// Plugin tests with a fake internet: each test lists the API responses a
// service would send, then checks what the tile shows and which requests
// the buttons make. Run with `npm test`.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runAction, runLoad } from "./index.ts";
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
  assert.match(r.error!, /Add GITHUB_TOKEN to the \.env file/);
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
    ["POST", /\/database\/query$/, [{ bytes: 450e6 }]],
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

// ---- Grid placement (shared by the server and the page)
import { refit, overlaps } from "../../shared/types.ts";

test("refit: shrinking the grid keeps tools from overlapping", () => {
  const tools = [
    { id: "a", x: 0, y: 0, w: 3, h: 1 },
    { id: "b", x: 3, y: 0, w: 1, h: 1 },
    { id: "c", x: 0, y: 1, w: 3, h: 3 },
    { id: "d", x: 4, y: 1, w: 2, h: 2 },
    { id: "e", x: 3, y: 4, w: 2, h: 2 },
    { id: "f", x: 0, y: 0 + 8, w: 6, h: 2 },
  ];
  const out = refit(tools, 4);
  for (const t of out) assert.ok(t.x >= 0 && t.x + t.w <= 4, `${t.id} fits`);
  for (const a of out) for (const b of out) if (a !== b) assert.ok(!overlaps(a, b), `${a.id} and ${b.id} overlap`);
  assert.deepEqual(out.find((t) => t.id === "a"), tools[0]); // untouched when it already fits
});
