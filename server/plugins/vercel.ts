// Vercel: production status, recent deploys, deploys per day against the
// limit, this month's usage charges (Pro and Enterprise teams), domains,
// and redeploy / roll back / cancel / resume / verify buttons.
// API docs: https://vercel.com/docs/rest-api
// Limits: https://vercel.com/docs/limits
import { ago, bytes, expectShape, num, optional, PluginError, request, type Plugin, type PluginContext } from "./framework.ts";
import type { PluginItem, Tone } from "../../shared/types.ts";

const API = "https://api.vercel.com";
// Hobby: 100 deployments a day (rolling 24 hours). Change it in settings on Pro.
const DEFAULT_DEPLOYS_PER_DAY = 100;

// The token owner's default team, remembered for an hour per token so each
// refresh and button press doesn't look it up again.
const defaultTeams = new Map<string, { teamId: string; at: number }>();
/** Clears the remembered default teams (used by tests). */
export function forgetVercelTeams() {
  defaultTeams.clear();
}

/** The team to act on: the tile's setting, or the token owner's default team. */
async function team(ctx: PluginContext): Promise<string> {
  const t = ctx.config.team?.trim();
  if (t) return t.startsWith("team_") ? `teamId=${encodeURIComponent(t)}` : `slug=${encodeURIComponent(t)}`;
  const token = ctx.secret("VERCEL_TOKEN");
  let known = defaultTeams.get(token);
  if (!known || Date.now() - known.at > 3600_000) {
    // Not optional: if this fails, guessing the personal scope would look in the wrong place.
    const me = await vc(ctx, "/v2/user", "");
    expectShape(me?.user, "Vercel", "account details");
    known = { teamId: String(me.user.defaultTeamId ?? ""), at: Date.now() };
    defaultTeams.set(token, known);
  }
  return known.teamId ? `teamId=${encodeURIComponent(known.teamId)}` : "";
}

function vc<T = any>(ctx: PluginContext, path: string, teamQuery: string, init: { method?: string; body?: unknown; text?: boolean; allow?: number[] } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  return request<T>(`${API}${path}${teamQuery ? sep + teamQuery : ""}`, {
    ...init,
    service: "Vercel",
    tokenKey: "VERCEL_TOKEN",
    headers: { Authorization: `Bearer ${ctx.secret("VERCEL_TOKEN")}` },
  });
}

function projectName(ctx: PluginContext) {
  const p = ctx.config.project?.trim().replace(/^https?:\/\//, "").replace(/\.vercel\.app\/?$/, "");
  if (!p) throw new Error("Set the Vercel project name (as shown in your Vercel dashboard).");
  return p;
}

async function project(ctx: PluginContext, teamQuery: string) {
  const p = await vc(ctx, `/v9/projects/${encodeURIComponent(projectName(ctx))}`, teamQuery);
  expectShape(p && typeof p.id === "string", "Vercel", "project details");
  return p;
}

function stateTone(state: string | undefined): Tone {
  if (state === "READY") return "ok";
  if (state === "ERROR") return "bad";
  if (["BUILDING", "INITIALIZING", "QUEUED"].includes(String(state))) return "pending";
  return "neutral";
}

/** Throws unless the deploy belongs to this tile's project, so buttons can't act on another project. */
async function ownDeployment(ctx: PluginContext, teamQuery: string, projectId: string, deploymentId: unknown) {
  const d = await vc(ctx, `/v13/deployments/${encodeURIComponent(String(deploymentId))}`, teamQuery);
  if (d?.projectId !== projectId) throw new PluginError("other", "That deploy belongs to a different project, so the hub left it alone.");
}

/**
 * Deploys created in the last 24 hours across the team (the daily limit is a
 * rolling window). Pages through the list and stops once the limit is
 * reached; `more` is true when there may be more than `count`.
 */
async function deploysLast24h(ctx: PluginContext, teamQuery: string, max: number): Promise<{ count: number; more: boolean }> {
  const since = Date.now() - 86400_000;
  let count = 0;
  let until: number | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await vc(ctx, `/v7/deployments?limit=100&since=${since}${until ? `&until=${until}` : ""}`, teamQuery);
    expectShape(Array.isArray(res?.deployments), "Vercel", "deployment list");
    count += res.deployments.length;
    until = res.pagination?.next ?? undefined;
    if (!until || !res.deployments.length) return { count, more: false };
    if (count >= max) break;
  }
  return { count, more: true };
}

export interface UsageLine {
  service: string;
  quantity: number;
  unit: string;
  cost: number;
}

/**
 * Sums FOCUS billing rows (JSON Lines) by service. `other` is what isn't usage
 * (plan fees, credits, tax), so the lines plus `other` add up to `total`.
 * A row that can't be read is skipped instead of losing the whole month.
 */
export function summarizeCharges(jsonl: string): { lines: UsageLine[]; total: number; other: number } {
  const by = new Map<string, UsageLine>();
  let total = 0;
  let other = 0;
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    const cost = Number(row?.BilledCost) || 0;
    total += cost;
    if (row?.ChargeCategory && row.ChargeCategory !== "Usage") {
      other += cost;
      continue;
    }
    const key = `${row.ServiceName}|${row.ConsumedUnit ?? ""}`;
    const line = by.get(key) ?? { service: String(row.ServiceName ?? "Other"), quantity: 0, unit: String(row.ConsumedUnit ?? ""), cost: 0 };
    line.quantity += Number(row.ConsumedQuantity) || 0;
    line.cost += cost;
    by.set(key, line);
  }
  return { lines: [...by.values()].sort((a, b) => b.cost - a.cost || b.quantity - a.quantity), total, other };
}

/**
 * This month's usage charges. Null when Vercel says it has none (404
 * `costs_not_found`, which is what Hobby teams get). Any other failure
 * throws, so a Pro team isn't mistaken for Hobby when the call fails.
 */
async function usageThisMonth(ctx: PluginContext, teamQuery: string) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const to = new Date(now.getTime() + 86400_000).toISOString();
  const text = await vc<string | null>(ctx, `/v1/billing/charges?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, teamQuery, {
    text: true,
    allow: [404],
  });
  return text === null ? null : summarizeCharges(text);
}

// Hobby allowances per rolling 30 days (https://vercel.com/docs/limits/fair-use-guidelines).
export const HOBBY = { transferBytes: 100e9, invocations: 1_000_000, memoryGbHours: 360 };

export interface Usage30d {
  transferBytes: number;
  invocations: number;
  memoryGbHours: number;
  requests: number;
  cacheHits: number;
  builds: number;
  buildSeconds: number;
}

/**
 * Team usage over the last 30 days from /v2/usage. Not in Vercel's published
 * docs (checked 2026-10-09), but it answers Hobby teams, unlike the billing
 * API. Active CPU and Fast Origin Transfer aren't in it.
 */
async function usage30d(ctx: PluginContext, teamQuery: string): Promise<Usage30d> {
  const to = new Date();
  const range = `from=${encodeURIComponent(new Date(to.getTime() - 30 * 86400_000).toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  const [req, builds] = await Promise.all([
    vc(ctx, `/v2/usage?type=requests&${range}`, teamQuery),
    optional(vc(ctx, `/v2/usage?type=builds&${range}`, teamQuery)),
  ]);
  expectShape(Array.isArray(req?.data), "Vercel", "usage");
  const sum = (rows: any[] | undefined, ...keys: string[]) =>
    (rows ?? []).reduce((s, r) => s + keys.reduce((k, key) => k + (Number(r?.[key]) || 0), 0), 0);
  return {
    transferBytes: sum(req.data, "bandwidth_outgoing_bytes", "bandwidth_incoming_bytes"),
    invocations: sum(req.data, "function_invocation_successful_count", "function_invocation_error_count", "function_invocation_timeout_count"),
    memoryGbHours: sum(req.data, "function_execution_successful_gb_hours", "function_execution_error_gb_hours", "function_execution_timeout_gb_hours"),
    requests: sum(req.data, "request_hit_count", "request_miss_count"),
    cacheHits: sum(req.data, "request_hit_count"),
    builds: sum(builds?.data, "build_completed_count", "build_failed_count"),
    buildSeconds: sum(builds?.data, "build_build_seconds"),
  };
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;
const qty = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: n < 10 ? 2 : 0 }).format(n);

export const vercel: Plugin = {
  id: "vercel",
  name: "Vercel",
  description: "Production status, recent deploys, deploys per day and this month's usage. Redeploy, roll back, cancel, resume or verify domains.",
  portalUrl: () => "https://vercel.com/dashboard",
  env: [
    {
      key: "VERCEL_TOKEN",
      help: "A Vercel access token for the team your project is in.",
      url: "https://vercel.com/account/settings/tokens",
      steps: [
        "Open the Tokens page in your Vercel account settings.",
        "Name it \"Management hub\".",
        "Under Scope, choose the team your project is in (on the free plan, that's your Hobby team).",
        "Pick an expiration date, then press \"Create\".",
        "Copy the token and paste it below. Vercel shows it only once.",
      ],
    },
  ],
  configFields: [
    { key: "project", label: "Project", placeholder: "my-site", required: true, help: "The project's name in your Vercel dashboard." },
    { key: "team", label: "Team (optional)", placeholder: "Your default team", help: "The team's slug (from vercel.com/<team>) if the project isn't in your default team." },
    { key: "deploysPerDay", label: "Deploys per day limit", placeholder: String(DEFAULT_DEPLOYS_PER_DAY), type: "number" },
  ],

  async load(ctx) {
    const tq = await team(ctx);
    const p = await project(ctx, tq);
    const deploysMax = Number(ctx.config.deploysPerDay) || DEFAULT_DEPLOYS_PER_DAY;
    const [list, domains, d24, usage, u30] = await Promise.all([
      vc(ctx, `/v7/deployments?projectId=${p.id}&limit=8`, tq),
      optional(vc(ctx, `/v9/projects/${p.id}/domains`, tq)),
      optional(deploysLast24h(ctx, tq, deploysMax)),
      optional(usageThisMonth(ctx, tq)),
      optional(usage30d(ctx, tq)),
    ]);
    expectShape(Array.isArray(list?.deployments), "Vercel", "deployment list");
    const deployments: any[] = list.deployments;
    const deploys24h = d24?.count;

    const live = p.targets?.production;
    // Dashboard links: a deploy's inspector URL is vercel.com/<team>/<project>/<id>.
    // Before the first deploy it's unknown, so the Deployments link is left out.
    const projectUrl = String(deployments[0]?.inspectorUrl ?? "").replace(/\/[^/]+$/, "");
    const knownUrl = /^https:\/\/vercel\.com\/[^/]+\/[^/]+$/.test(projectUrl);
    const usageUrl = knownUrl ? `${projectUrl.split("/").slice(0, 4).join("/")}/~/usage` : "https://vercel.com/dashboard";
    const items: PluginItem[] = deployments.map((d) => {
      const isLive = d.uid === live?.id;
      const state = d.readyState ?? d.state;
      const actions = [];
      if (["BUILDING", "INITIALIZING", "QUEUED"].includes(state)) {
        actions.push({ id: "cancel", label: "Cancel", args: { deploymentId: d.uid }, confirm: "Cancel this deploy while it builds?" });
      }
      if (state === "READY" && !isLive && d.target === "production") {
        actions.push({ id: "rollback", label: "Roll back to this", args: { deploymentId: d.uid }, confirm: "Make this older deploy the live site?" });
      }
      const msg = String(d.meta?.githubCommitMessage ?? d.meta?.gitlabCommitMessage ?? "").split("\n")[0];
      const branch = d.meta?.githubCommitRef ?? d.meta?.gitlabCommitRef;
      return {
        title: `${isLive ? "LIVE · " : ""}${msg || d.url || d.uid}`,
        subtitle: [d.target ?? "preview", branch, state?.toLowerCase(), d.errorMessage, ago(d.created)].filter(Boolean).join(" · "),
        tone: stateTone(state),
        url: d.inspectorUrl ?? `https://${d.url}`,
        actions,
      };
    });

    const prod = deployments.find((d) => d.target === "production");
    const prodState = prod?.readyState ?? prod?.state;
    const status = p.paused
      ? { label: "Project paused", tone: "bad" as Tone }
      : !prod
        ? { label: "No production deploys yet", tone: "neutral" as Tone }
        : prodState === "ERROR"
          ? { label: "Latest production deploy failed", tone: "bad" as Tone }
          : prodState === "READY"
            ? { label: "Live", tone: "ok" as Tone }
            : { label: `Deploying (${String(prodState).toLowerCase()})`, tone: "pending" as Tone };

    const deployTone: Tone = deploys24h === undefined ? "neutral" : deploys24h >= deploysMax ? "bad" : deploys24h / deploysMax > 0.8 ? "warn" : "ok";

    const domainList: any[] = Array.isArray(domains?.domains) ? domains.domains : [];
    const domainItems: PluginItem[] = domainList.map((d) => ({
      title: d.name,
      subtitle: d.verified ? (d.redirect ? `redirects to ${d.redirect}` : "verified") : "not verified: add the DNS records Vercel shows",
      tone: d.verified ? "ok" : "warn",
      url: `https://${d.name}`,
      actions: d.verified ? [] : [{ id: "verifyDomain", label: "Verify", args: { domain: d.name } }],
    }));

    // Vercel only has billing data for Pro/Enterprise: none (null) means Hobby, so its allowances
    // apply. If the billing call failed (undefined) the plan is unknown, and no limits are shown.
    const hobby = usage === null;
    const gauge = (label: string, used: number, max: number, show: (n: number) => string) => {
      const tone: Tone = used >= max ? "bad" : used / max > 0.8 ? "warn" : "ok";
      return hobby
        ? { label, value: `${show(used)} / ${show(max)}`, tone, limit: { used, max } }
        : { label, value: show(used) };
    };
    const usageStats = u30
      ? [
          gauge("Data transfer (30d)", u30.transferBytes, HOBBY.transferBytes, bytes),
          gauge("Function invocations (30d)", u30.invocations, HOBBY.invocations, num),
          gauge("Function memory (30d)", u30.memoryGbHours, HOBBY.memoryGbHours, (n) => `${qty(n)} GB-hrs`),
        ]
      : [];
    const overHobby = hobby && u30 && usageStats.some((s) => s.tone === "bad");

    const usageSection = usage
      ? {
          title: "Charges this month",
          items: [
            ...usage.lines.slice(0, 8).map((l) => ({ title: `${l.service}: ${qty(l.quantity)} ${l.unit}`.trim(), subtitle: `${usd(l.cost)} billed` })),
            ...(Math.abs(usage.other) >= 0.005 ? [{ title: "Plan fees, credits and tax", subtitle: `${usd(usage.other)} billed` }] : []),
          ],
          empty: "No usage charged yet this month.",
        }
      : u30
        ? {
            title: "Usage, last 30 days",
            items: [
              { title: plural(u30.requests, "request"), subtitle: u30.requests ? `${Math.round((u30.cacheHits / u30.requests) * 100)}% served from cache` : "No traffic yet" },
              { title: plural(u30.builds, "build"), subtitle: `${qty(u30.buildSeconds / 60)} minutes building` },
              {
                title: "Active CPU and origin transfer: not reported",
                subtitle: "Vercel's API doesn't share these (free plan: 4 hours active CPU, 10 GB origin transfer). The Usage page shows them.",
                url: usageUrl,
              },
            ],
          }
        : {
            title: "Usage",
            items: [
              {
                title: "Not available through Vercel's API right now",
                subtitle: "The Usage page shows it. Free plan: 100 GB data transfer, 1M function invocations, 4 hours active CPU per 30 days.",
                url: usageUrl,
              },
            ],
          };

    const notices = [
      p.paused ? "Vercel has paused this project, so the site is offline. On the free plan this happens when a usage limit is exceeded. Resume it when you're ready." : "",
      deploys24h !== undefined && deploys24h >= deploysMax ? "The daily deploy limit is used up: new deploys will fail until older ones are more than 24 hours old." : "",
      overHobby && !p.paused ? "This team is over a free-plan allowance for the last 30 days. Vercel may pause the project until usage drops back under it." : "",
    ].filter(Boolean);

    return {
      status,
      notice: notices.length ? notices.join(" ") : undefined,
      stats: [
        { label: "Production branch", value: p.link?.productionBranch ?? "–" },
        { label: "Published", value: live?.createdAt ? ago(live.createdAt) : "never" },
        ...(deploys24h !== undefined
          ? [{ label: "Deploys (24h)", value: `${num(deploys24h)}${d24?.more ? "+" : ""} / ${num(deploysMax)}`, tone: deployTone, limit: { used: deploys24h, max: deploysMax } }]
          : []),
        ...usageStats,
        ...(usage ? [{ label: "Billed this month", value: usd(usage.total) }] : []),
      ],
      sections: [
        { title: "Recent deploys", items, empty: "No deploys yet." },
        usageSection,
        ...(domainItems.length ? [{ title: "Domains", items: domainItems }] : []),
      ],
      actions: [
        ...(p.paused ? [{ id: "unpause", label: "Resume project", confirm: "Resume this project and bring the site back online?" }] : []),
        ...(live?.id ? [{ id: "redeploy", label: "Redeploy production", confirm: "Build and publish production again? This uses one of today's deploys." }] : []),
      ],
      links: [
        ...(live?.url ? [{ label: "Live site", url: `https://${live.alias?.[0] ?? live.url}` }] : []),
        ...(knownUrl ? [{ label: "Deployments", url: `${projectUrl}/deployments` }] : []),
        { label: "Usage", url: usageUrl },
      ],
    };
  },

  // Saved every hour for analytics tiles.
  async collect(ctx) {
    const tq = await team(ctx);
    const p = await project(ctx, tq);
    const deploysMax = Number(ctx.config.deploysPerDay) || DEFAULT_DEPLOYS_PER_DAY;
    const [deploys, usage, u30] = await Promise.all([deploysLast24h(ctx, tq, deploysMax), optional(usageThisMonth(ctx, tq)), optional(usage30d(ctx, tq))]);
    // Tagged with the id of the team that owns the project, so a slug in settings doesn't start a second series.
    const tags = { team: String(p.accountId ?? (tq ? decodeURIComponent(tq.split("=")[1]) : "personal")) };
    // Hobby limits only apply when Vercel says there's no billing data (see `load`).
    const limit = (metric: string, value: number) => (usage === null ? [{ metric: `${metric}.limit`, value, tags }] : []);
    return [
      { metric: "vercel.deploys_24h", value: deploys.count, tags },
      { metric: "vercel.deploys_24h.limit", value: deploysMax, tags },
      ...(usage ? [{ metric: "vercel.billed_usd_month", value: Math.round(usage.total * 100) / 100, tags }] : []),
      ...(u30
        ? [
            { metric: "vercel.transfer_30d_bytes", value: u30.transferBytes, tags },
            ...limit("vercel.transfer_30d_bytes", HOBBY.transferBytes),
            { metric: "vercel.invocations_30d", value: u30.invocations, tags },
            ...limit("vercel.invocations_30d", HOBBY.invocations),
            { metric: "vercel.requests_30d", value: u30.requests, tags },
          ]
        : []),
    ];
  },

  actions: {
    // Rebuilds what's live now, read from the project rather than from the button.
    async redeploy(ctx) {
      const tq = await team(ctx);
      const p = await project(ctx, tq);
      const live = p.targets?.production?.id;
      if (!live) throw new PluginError("other", "This project has nothing in production to redeploy yet.");
      await vc(ctx, "/v13/deployments?forceNew=1", tq, {
        method: "POST",
        body: { name: p.name, project: p.id, deploymentId: String(live), target: "production" },
      });
      return "Redeploying production. It will go live when the build finishes.";
    },
    async rollback(ctx, { deploymentId }) {
      const tq = await team(ctx);
      const p = await project(ctx, tq);
      await ownDeployment(ctx, tq, p.id, deploymentId);
      await vc(ctx, `/v1/projects/${p.id}/rollback/${encodeURIComponent(String(deploymentId))}`, tq, { method: "POST" });
      return "Rolled back: that deploy is now live.";
    },
    async cancel(ctx, { deploymentId }) {
      const tq = await team(ctx);
      const p = await project(ctx, tq);
      await ownDeployment(ctx, tq, p.id, deploymentId);
      await vc(ctx, `/v12/deployments/${encodeURIComponent(String(deploymentId))}/cancel`, tq, { method: "PATCH" });
      return "Deploy canceled.";
    },
    async unpause(ctx) {
      const tq = await team(ctx);
      const p = await project(ctx, tq);
      await vc(ctx, `/v1/projects/${p.id}/unpause`, tq, { method: "POST" });
      return "Project resumed.";
    },
    // The domain is looked up under this project, so Vercel refuses one that isn't on it.
    async verifyDomain(ctx, { domain }) {
      const tq = await team(ctx);
      const p = await project(ctx, tq);
      await vc(ctx, `/v9/projects/${p.id}/domains/${encodeURIComponent(String(domain))}/verify`, tq, { method: "POST" });
      return `Verification of ${domain} requested.`;
    },
  },
};
