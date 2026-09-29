// Cloudflare Pages: deploy status, builds used this month, Workers/Functions
// requests today, custom domains, and retry / roll back / rebuild buttons.
// API docs: https://developers.cloudflare.com/api/resources/pages/
// Limits: https://developers.cloudflare.com/pages/platform/limits/
import { ago, expectShape, num, optional, type Plugin, type PluginContext } from "./framework.ts";
import { CLOUDFLARE_TOKEN, cf, cfGraphql } from "./cloudflare.ts";
import type { PluginItem, Tone } from "../../shared/types.ts";

// Free plan limits (change them in the tile settings on a paid plan).
// Builds: 500 a month for the whole account. Workers and Pages Functions
// share 100,000 requests a day, reset at midnight UTC.
const DEFAULT_BUILDS = 500;
const DEFAULT_REQUESTS = 100_000;
const PER_PAGE = 25;
const MAX_PAGES = 8;

function projectName(ctx: PluginContext) {
  const p = ctx.config.project?.trim().replace(/^https?:\/\//, "").replace(/\.pages\.dev\/?$/, "");
  if (!p) throw new Error("Set the Pages project name (as in my-site.pages.dev).");
  return p;
}

/** The account holding the project: the one set in settings, or the only/first one that has it. */
async function locate(ctx: PluginContext): Promise<{ account: string; project: any }> {
  const name = projectName(ctx);
  const accounts = ctx.config.accountId?.trim()
    ? [{ id: ctx.config.accountId.trim() }]
    : await cf<any[]>(ctx, "/accounts?per_page=50");
  expectShape(Array.isArray(accounts), "Cloudflare", "account list");
  for (const a of accounts) {
    const project = await cf(ctx, `/accounts/${a.id}/pages/projects/${encodeURIComponent(name)}`, { allow: [404] });
    if (project) {
      expectShape(typeof project.name === "string", "Cloudflare", "Pages project");
      return { account: a.id, project };
    }
  }
  throw new Error(`Cloudflare has no Pages project named ${name} that this token can see. Check the name, and that the token has the Cloudflare Pages permission.`);
}

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

/** Builds used this month across every Pages project in the account (direct uploads don't count). */
async function buildsThisMonth(ctx: PluginContext, account: string): Promise<number> {
  const since = monthStart();
  const projects = await cf<any[]>(ctx, `/accounts/${account}/pages/projects?per_page=100`);
  expectShape(Array.isArray(projects), "Cloudflare", "Pages project list");
  let count = 0;
  for (const p of projects) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await cf<any[]>(ctx, `/accounts/${account}/pages/projects/${encodeURIComponent(p.name)}/deployments?per_page=${PER_PAGE}&page=${page}`);
      expectShape(Array.isArray(list), "Cloudflare", "Pages deployment list");
      const inMonth = list.filter((d) => new Date(d.created_on) >= since);
      count += inMonth.filter((d) => !d.is_skipped && d.deployment_trigger?.type !== "ad_hoc").length;
      if (list.length < PER_PAGE || inMonth.length < list.length) break; // newest first
    }
  }
  return count;
}

const REQUESTS_QUERY = `query ($account: String!, $date: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    pages: pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: { date: $date }) { sum { requests } }
    workers: workersInvocationsAdaptive(limit: 10000, filter: { date: $date }) { sum { requests } }
  } }
}`;

/** Pages Functions + Workers requests today (UTC): they share the free plan's daily limit. */
async function requestsToday(ctx: PluginContext, account: string): Promise<number | undefined> {
  const res = await cfGraphql(ctx, REQUESTS_QUERY, { account, date: new Date().toISOString().slice(0, 10) });
  const a = res?.data?.viewer?.accounts?.[0];
  if (!a) return undefined; // e.g. the token lacks Account Analytics
  const sum = (rows: any[] | undefined) => (rows ?? []).reduce((s, r) => s + (Number(r?.sum?.requests) || 0), 0);
  return sum(a.pages) + sum(a.workers);
}

function stageTone(status: string | undefined): Tone {
  if (status === "success") return "ok";
  if (status === "failure") return "bad";
  if (status === "active" || status === "idle") return "pending";
  return "neutral";
}

const usageTone = (used: number, max: number): Tone => (used >= max ? "bad" : used / max > 0.8 ? "warn" : "ok");

export const cloudflarePages: Plugin = {
  id: "cloudflare-pages",
  name: "Cloudflare Pages",
  description: "Deploy status, builds used this month, Functions requests today and custom domains. Retry, roll back or rebuild.",
  portalUrl: () => "https://dash.cloudflare.com/?to=/:account/pages",
  env: [CLOUDFLARE_TOKEN],
  configFields: [
    { key: "project", label: "Pages project", placeholder: "my-site", required: true, help: "The name in my-site.pages.dev." },
    {
      key: "accountId",
      label: "Account ID (optional)",
      placeholder: "Found automatically",
      help: "Only needed if your token can see several Cloudflare accounts. It's the long code in the dashboard's address: dash.cloudflare.com/<account ID>/…",
    },
    { key: "buildsLimit", label: "Builds per month", placeholder: String(DEFAULT_BUILDS), type: "number" },
    { key: "requestsLimit", label: "Functions requests per day", placeholder: String(DEFAULT_REQUESTS), type: "number" },
  ],

  async load(ctx) {
    const { account, project: p } = await locate(ctx);
    const base = `/accounts/${account}/pages/projects/${encodeURIComponent(p.name)}`;
    const [deployments, domains, builds, requests] = await Promise.all([
      cf<any[]>(ctx, `${base}/deployments?per_page=8`),
      optional(cf<any[]>(ctx, `${base}/domains`)),
      optional(buildsThisMonth(ctx, account)),
      optional(requestsToday(ctx, account)),
    ]);
    expectShape(Array.isArray(deployments), "Cloudflare", "Pages deployment list");

    const buildsMax = Number(ctx.config.buildsLimit) || DEFAULT_BUILDS;
    const requestsMax = Number(ctx.config.requestsLimit) || DEFAULT_REQUESTS;
    const liveId = p.canonical_deployment?.id;
    const dash = `https://dash.cloudflare.com/${account}/pages/view/${p.name}`;

    const items: PluginItem[] = deployments.map((d) => {
      const live = d.id === liveId;
      const stage = d.latest_stage ?? {};
      const meta = d.deployment_trigger?.metadata ?? {};
      const actions = [];
      if (stage.status === "failure") actions.push({ id: "retry", label: "Retry", args: { deploymentId: d.id } });
      if (stage.status === "success" && !live && d.environment === "production") {
        actions.push({ id: "rollback", label: "Roll back to this", args: { deploymentId: d.id }, confirm: "Make this older deploy the live site?" });
      }
      return {
        title: `${live ? "LIVE · " : ""}${String(meta.commit_message ?? "").split("\n")[0] || d.short_id || d.id.slice(0, 8)}`,
        subtitle: [d.environment, meta.branch, `${stage.name ?? "?"}: ${stage.status ?? "?"}`, d.is_skipped ? "skipped" : "", ago(d.created_on)].filter(Boolean).join(" · "),
        tone: d.is_skipped ? "neutral" : stageTone(stage.status),
        url: `${dash}/${d.id}`,
        actions,
      };
    });

    // Status: the newest production deploy.
    const prod = deployments.find((d) => d.environment === "production");
    const prodStatus = prod?.latest_stage?.status;
    const status = !prod
      ? { label: "No production deploys yet", tone: "neutral" as Tone }
      : prodStatus === "failure"
        ? { label: "Latest production deploy failed", tone: "bad" as Tone }
        : prodStatus === "success"
          ? { label: "Live", tone: "ok" as Tone }
          : { label: `Deploying (${prod.latest_stage?.name ?? "…"})`, tone: "pending" as Tone };

    const domainItems: PluginItem[] = (domains ?? []).map((d) => ({
      title: d.name,
      subtitle: d.status === "active" ? "active" : `${d.status}${d.verification_data?.error_message ? ` · ${d.verification_data.error_message}` : ""}`,
      tone: d.status === "active" ? "ok" : ["error", "blocked", "deactivated"].includes(d.status) ? "bad" : "pending",
      url: `https://${d.name}`,
    }));

    const full = [
      builds !== undefined && builds >= buildsMax ? "This month's builds are used up: new Git pushes won't build until next month." : "",
      requests !== undefined && requests >= requestsMax ? "Today's Workers/Functions requests are used up: Functions stop answering until midnight UTC." : "",
    ].filter(Boolean);

    return {
      status,
      notice: full.length ? full.join(" ") : undefined,
      stats: [
        { label: "Production branch", value: p.production_branch ?? "–" },
        { label: "Published", value: p.canonical_deployment ? ago(p.canonical_deployment.created_on) : "never" },
        ...(builds !== undefined
          ? [{ label: "Builds this month", value: `${num(builds)} / ${num(buildsMax)}`, tone: usageTone(builds, buildsMax), limit: { used: builds, max: buildsMax } }]
          : []),
        ...(requests !== undefined
          ? [{ label: "Functions requests today", value: `${num(requests)} / ${num(requestsMax)}`, tone: usageTone(requests, requestsMax), limit: { used: requests, max: requestsMax } }]
          : []),
      ],
      sections: [
        { title: "Recent deploys", items, empty: "No deploys yet." },
        ...(domainItems.length ? [{ title: "Custom domains", items: domainItems }] : []),
      ],
      actions: p.canonical_deployment ? [{ id: "retry", label: "Rebuild live deploy", args: { deploymentId: p.canonical_deployment.id } }] : [],
      links: [
        { label: "Live site", url: `https://${p.subdomain ?? `${p.name}.pages.dev`}` },
        { label: "Deployments", url: dash },
        { label: "Usage", url: `https://dash.cloudflare.com/${account}/workers/plans` },
      ],
    };
  },

  // Saved every hour for analytics tiles. Both counts are for the whole
  // account, so they're tagged with the account.
  async collect(ctx) {
    const { account } = await locate(ctx);
    const [builds, requests] = await Promise.all([buildsThisMonth(ctx, account), optional(requestsToday(ctx, account))]);
    const tags = { account };
    return [
      { metric: "cloudflare.pages_builds_month", value: builds, tags },
      { metric: "cloudflare.pages_builds_month.limit", value: Number(ctx.config.buildsLimit) || DEFAULT_BUILDS, tags },
      ...(requests !== undefined
        ? [
            { metric: "cloudflare.functions_requests_today", value: requests, tags },
            { metric: "cloudflare.functions_requests_today.limit", value: Number(ctx.config.requestsLimit) || DEFAULT_REQUESTS, tags },
          ]
        : []),
    ];
  },

  actions: {
    async retry(ctx, { deploymentId }) {
      const { account, project } = await locate(ctx);
      await cf(ctx, `/accounts/${account}/pages/projects/${encodeURIComponent(project.name)}/deployments/${encodeURIComponent(String(deploymentId))}/retry`, { method: "POST" });
      return "Building again. This uses one of the month's builds.";
    },
    async rollback(ctx, { deploymentId }) {
      const { account, project } = await locate(ctx);
      await cf(ctx, `/accounts/${account}/pages/projects/${encodeURIComponent(project.name)}/deployments/${encodeURIComponent(String(deploymentId))}/rollback`, { method: "POST" });
      return "That deploy is now live.";
    },
  },
};
