// Vercel: production status, recent deploys, deploys per day against the
// limit, this month's usage charges (Pro and Enterprise teams), domains,
// and redeploy / roll back / cancel / resume / verify buttons.
// API docs: https://vercel.com/docs/rest-api
// Limits: https://vercel.com/docs/limits
import { ago, expectShape, num, optional, request, type Plugin, type PluginContext } from "./framework.ts";
import type { PluginItem, Tone } from "../../shared/types.ts";

const API = "https://api.vercel.com";
// Hobby: 100 deployments a day (rolling 24 hours). Change it in settings on Pro.
const DEFAULT_DEPLOYS_PER_DAY = 100;

/** The team to act on: the tile's setting, or the token owner's default team. */
async function team(ctx: PluginContext): Promise<string> {
  const t = ctx.config.team?.trim();
  if (t) return t.startsWith("team_") ? `teamId=${encodeURIComponent(t)}` : `slug=${encodeURIComponent(t)}`;
  const me = await optional(vc(ctx, "/v2/user", ""));
  return me?.user?.defaultTeamId ? `teamId=${encodeURIComponent(me.user.defaultTeamId)}` : "";
}

function vc<T = any>(ctx: PluginContext, path: string, teamQuery: string, init: { method?: string; body?: unknown; text?: boolean } = {}) {
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

/** Deploys created in the last 24 hours across the team (the daily limit is a rolling window). */
async function deploysLast24h(ctx: PluginContext, teamQuery: string): Promise<number> {
  const res = await vc(ctx, `/v7/deployments?limit=100&since=${Date.now() - 86400_000}`, teamQuery);
  expectShape(Array.isArray(res?.deployments), "Vercel", "deployment list");
  return res.deployments.length;
}

export interface UsageLine {
  service: string;
  quantity: number;
  unit: string;
  cost: number;
}

/** Sums FOCUS billing rows (JSON Lines) by service. */
export function summarizeCharges(jsonl: string): { lines: UsageLine[]; total: number } {
  const by = new Map<string, UsageLine>();
  let total = 0;
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    const row = JSON.parse(raw);
    const cost = Number(row.BilledCost) || 0;
    total += cost;
    if (row.ChargeCategory && row.ChargeCategory !== "Usage") continue;
    const key = `${row.ServiceName}|${row.ConsumedUnit ?? ""}`;
    const line = by.get(key) ?? { service: String(row.ServiceName ?? "Other"), quantity: 0, unit: String(row.ConsumedUnit ?? ""), cost: 0 };
    line.quantity += Number(row.ConsumedQuantity) || 0;
    line.cost += cost;
    by.set(key, line);
  }
  return { lines: [...by.values()].sort((a, b) => b.cost - a.cost || b.quantity - a.quantity), total };
}

/** This month's usage charges. Undefined when Vercel doesn't share them (Hobby teams). */
async function usageThisMonth(ctx: PluginContext, teamQuery: string) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const to = new Date(now.getTime() + 86400_000).toISOString();
  const text = await vc<string>(ctx, `/v1/billing/charges?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, teamQuery, { text: true });
  return summarizeCharges(String(text ?? ""));
}

const usd = (n: number) => `$${n.toFixed(2)}`;
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
    const [list, domains, deploys24h, usage] = await Promise.all([
      vc(ctx, `/v7/deployments?projectId=${p.id}&limit=8`, tq),
      optional(vc(ctx, `/v9/projects/${p.id}/domains`, tq)),
      optional(deploysLast24h(ctx, tq)),
      optional(usageThisMonth(ctx, tq)),
    ]);
    expectShape(Array.isArray(list?.deployments), "Vercel", "deployment list");
    const deployments: any[] = list.deployments;

    const live = p.targets?.production;
    // Dashboard links: a deploy's inspector URL is vercel.com/<team>/<project>/<id>.
    const projectUrl = String(deployments[0]?.inspectorUrl ?? "").replace(/\/[^/]+$/, "") || "https://vercel.com/dashboard";
    const usageUrl = /^https:\/\/vercel\.com\/[^/]+\/[^/]+$/.test(projectUrl) ? `${projectUrl.split("/").slice(0, 4).join("/")}/~/usage` : "https://vercel.com/dashboard";
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

    const deploysMax = Number(ctx.config.deploysPerDay) || DEFAULT_DEPLOYS_PER_DAY;
    const deployTone: Tone = deploys24h === undefined ? "neutral" : deploys24h >= deploysMax ? "bad" : deploys24h / deploysMax > 0.8 ? "warn" : "ok";

    const domainList: any[] = Array.isArray(domains?.domains) ? domains.domains : [];
    const domainItems: PluginItem[] = domainList.map((d) => ({
      title: d.name,
      subtitle: d.verified ? (d.redirect ? `redirects to ${d.redirect}` : "verified") : "not verified: add the DNS records Vercel shows",
      tone: d.verified ? "ok" : "warn",
      url: `https://${d.name}`,
      actions: d.verified ? [] : [{ id: "verifyDomain", label: "Verify", args: { domain: d.name } }],
    }));

    const usageSection = usage
      ? {
          title: "Usage this month",
          items: usage.lines.slice(0, 8).map((l) => ({ title: `${l.service}: ${qty(l.quantity)} ${l.unit}`.trim(), subtitle: `${usd(l.cost)} billed` })),
          empty: "No usage charged yet this month.",
        }
      : {
          title: "Usage this month",
          items: [
            {
              title: "Not available through Vercel's API on this plan",
              subtitle: "Vercel only shares usage data with Pro and Enterprise teams. The Usage page shows it. Free plan: 100 GB data transfer, 1M function invocations, 4 hours active CPU a month.",
              url: usageUrl,
            },
          ],
        };

    const notices = [
      p.paused ? "Vercel has paused this project, so the site is offline. On the free plan this happens when a usage limit is exceeded. Resume it when you're ready." : "",
      deploys24h !== undefined && deploys24h >= deploysMax ? "The daily deploy limit is used up: new deploys will fail until older ones are more than 24 hours old." : "",
    ].filter(Boolean);

    return {
      status,
      notice: notices.length ? notices.join(" ") : undefined,
      stats: [
        { label: "Production branch", value: p.link?.productionBranch ?? "–" },
        { label: "Published", value: live?.createdAt ? ago(live.createdAt) : "never" },
        ...(deploys24h !== undefined
          ? [{ label: "Deploys (24h)", value: `${num(deploys24h)} / ${num(deploysMax)}`, tone: deployTone, limit: { used: deploys24h, max: deploysMax } }]
          : []),
        ...(usage ? [{ label: "Billed this month", value: usd(usage.total) }] : []),
      ],
      sections: [
        { title: "Recent deploys", items, empty: "No deploys yet." },
        usageSection,
        ...(domainItems.length ? [{ title: "Domains", items: domainItems }] : []),
      ],
      actions: [
        ...(p.paused ? [{ id: "unpause", label: "Resume project", confirm: "Resume this project and bring the site back online?" }] : []),
        ...(live?.id ? [{ id: "redeploy", label: "Redeploy production", args: { deploymentId: live.id } }] : []),
      ],
      links: [
        ...(live?.url ? [{ label: "Live site", url: `https://${live.alias?.[0] ?? live.url}` }] : []),
        { label: "Deployments", url: `${projectUrl}/deployments` },
        { label: "Usage", url: usageUrl },
      ],
    };
  },

  // Saved every hour for analytics tiles.
  async collect(ctx) {
    const tq = await team(ctx);
    const [deploys, usage] = await Promise.all([deploysLast24h(ctx, tq), optional(usageThisMonth(ctx, tq))]);
    const tags = { team: tq ? decodeURIComponent(tq.split("=")[1]) : "personal" };
    return [
      { metric: "vercel.deploys_24h", value: deploys, tags },
      { metric: "vercel.deploys_24h.limit", value: Number(ctx.config.deploysPerDay) || DEFAULT_DEPLOYS_PER_DAY, tags },
      ...(usage ? [{ metric: "vercel.billed_usd_month", value: Math.round(usage.total * 100) / 100, tags }] : []),
    ];
  },

  actions: {
    async redeploy(ctx, { deploymentId }) {
      const tq = await team(ctx);
      const p = await project(ctx, tq);
      await vc(ctx, "/v13/deployments?forceNew=1", tq, {
        method: "POST",
        body: { name: p.name, project: p.id, deploymentId: String(deploymentId), target: "production" },
      });
      return "Redeploying production. It will go live when the build finishes.";
    },
    async rollback(ctx, { deploymentId }) {
      const tq = await team(ctx);
      const p = await project(ctx, tq);
      await vc(ctx, `/v1/projects/${p.id}/rollback/${encodeURIComponent(String(deploymentId))}`, tq, { method: "POST" });
      return "Rolled back: that deploy is now live.";
    },
    async cancel(ctx, { deploymentId }) {
      const tq = await team(ctx);
      await vc(ctx, `/v12/deployments/${encodeURIComponent(String(deploymentId))}/cancel`, tq, { method: "PATCH" });
      return "Deploy canceled.";
    },
    async unpause(ctx) {
      const tq = await team(ctx);
      const p = await project(ctx, tq);
      await vc(ctx, `/v1/projects/${p.id}/unpause`, tq, { method: "POST" });
      return "Project resumed.";
    },
    async verifyDomain(ctx, { domain }) {
      const tq = await team(ctx);
      const p = await project(ctx, tq);
      await vc(ctx, `/v9/projects/${p.id}/domains/${encodeURIComponent(String(domain))}/verify`, tq, { method: "POST" });
      return `Verification of ${domain} requested.`;
    },
  },
};
