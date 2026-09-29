// Netlify: deploys, rebuilds, rollbacks, and credits (or bandwidth on older plans).
// API docs: https://open-api.netlify.com
import { ago, bytes, expectShape, num, optional, request, type Plugin, type PluginContext } from "./framework.ts";
import type { PluginItem, Tone } from "../../shared/types.ts";

const API = "https://api.netlify.com/api/v1";

function nf<T = any>(ctx: PluginContext, path: string, init: { method?: string; body?: unknown } = {}) {
  return request<T>(`${API}${path}`, {
    ...init,
    service: "Netlify",
    tokenKey: "NETLIFY_TOKEN",
    headers: { Authorization: `Bearer ${ctx.secret("NETLIFY_TOKEN")}` },
  });
}

function site(ctx: PluginContext) {
  const s = ctx.config.site?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!s) throw new Error("Set the site as its Netlify domain (mysite.netlify.app) or site ID.");
  return s;
}

// What things cost on Netlify's credit-based plans (from September 2025).
// https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/
// Deploy Previews, branch deploys, failed deploys and form submissions are free.
export const CREDIT_COSTS = { deploy: 15, per10kRequests: 2, perComputeGbHour: 10, perBandwidthGb: 20 };

/** What the remaining credits would buy if all spent on one thing. */
export function creditEquivalents(remaining: number) {
  const r = Math.max(0, remaining);
  return {
    deploys: Math.floor(r / CREDIT_COSTS.deploy),
    requests: Math.floor(r / CREDIT_COSTS.per10kRequests) * 10_000,
    computeGbHours: r / CREDIT_COSTS.perComputeGbHour,
    bandwidthBytes: (r / CREDIT_COSTS.perBandwidthGb) * 1e9,
  };
}

interface Credits {
  included: number;
  used: number;
  remaining: number;
  resets?: string;
  exceeded: boolean;
  /** How `used` was worked out (see `credits`). */
  estimate: {
    deploys: number;
    deployCredits: number;
    bandwidthBytes: number;
    bandwidthCredits: number;
    manual: { label: string; credits?: number; at?: string; stale: boolean }[];
  };
}

// Credits the API doesn't report; typed in by hand in the tile's settings.
const MANUAL = [
  { key: "computeCredits", label: "Compute" },
  { key: "requestCredits", label: "Web requests" },
];

/** The hand-entered numbers, and whether each belongs to the current period. */
function manualCredits(ctx: PluginContext, since: Date) {
  return MANUAL.map((m) => {
    const credits = Number(ctx.config[m.key]);
    const at = ctx.config[`${m.key}At`];
    const known = ctx.config[m.key] !== undefined && Number.isFinite(credits);
    // A number typed before this period started is last period's usage.
    const stale = known && Boolean(at) && new Date(at).getTime() < since.getTime();
    return { label: m.label, credits: known ? credits : undefined, at, stale };
  });
}

const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v));
const MAX_PAGES = 5;

/** Successful production deploys of every site in the team since `since` (these cost credits). */
async function productionDeploysSince(ctx: PluginContext, slug: string, since: Date): Promise<number> {
  const sites = await nf<any[]>(ctx, "/sites?filter=all&per_page=100");
  expectShape(Array.isArray(sites), "Netlify", "site list");
  let count = 0;
  for (const s of sites.filter((s) => s?.account_slug === slug)) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await nf<any[]>(ctx, `/sites/${s.id}/deploys?production=true&per_page=100&page=${page}`);
      expectShape(Array.isArray(list), "Netlify", "deploy list");
      const inPeriod = list.filter((d) => new Date(d.created_at) >= since);
      count += inPeriod.filter((d) => d.context === "production" && d.state === "ready").length;
      if (list.length < 100 || inPeriod.length < list.length) break; // newest first: older pages are outside the period
    }
  }
  return count;
}

/**
 * The team's credits. Netlify's API reports the plan's allowance and period,
 * but not credits used (its `capabilities.credits.used` stays 0), so usage
 * is estimated from what the API does report: production deploys this period
 * and bandwidth. Web requests and function compute aren't reported anywhere,
 * so the estimate leaves them out. Undefined (not an error) on older plans or
 * if the account data changes; none of this is in Netlify's published docs.
 */
async function credits(ctx: PluginContext, slug: string | undefined, bandwidthUsed: number | undefined): Promise<Credits | undefined> {
  if (!slug) return undefined;
  const accounts = await optional(nf<any[]>(ctx, "/accounts"));
  let account = Array.isArray(accounts) ? accounts.find((a) => a?.slug === slug) : undefined;
  if (account?.id && !account.capabilities?.credits) account = await optional(nf(ctx, `/accounts/${account.id}`));
  const included = Number(account?.capabilities?.credits?.included);
  const since = new Date(account?.current_usage_period_start);
  if (!Number.isFinite(included) || included <= 0 || Number.isNaN(since.getTime())) return undefined;

  const deploys = (await optional(productionDeploysSince(ctx, slug, since))) ?? 0;
  const bandwidthBytes = Number.isFinite(bandwidthUsed) ? bandwidthUsed! : 0;
  const estimate = {
    deploys,
    deployCredits: deploys * CREDIT_COSTS.deploy,
    bandwidthBytes,
    bandwidthCredits: (bandwidthBytes / 1e9) * CREDIT_COSTS.perBandwidthGb,
    manual: manualCredits(ctx, since),
  };
  const manualTotal = estimate.manual.reduce((sum, m) => sum + (m.stale ? 0 : (m.credits ?? 0)), 0);
  const reported = Number(account.capabilities.credits.used) || 0;
  // If Netlify starts reporting real usage, it will be at least our estimate.
  const used = Math.round(Math.max(reported, estimate.deployCredits + estimate.bandwidthCredits + manualTotal));
  return {
    included,
    used,
    remaining: Math.max(0, included - used),
    resets: account.next_usage_period_start,
    exceeded: nonEmpty(account.usages_exceeded),
    estimate,
  };
}

const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

function daysUntil(date: string | undefined) {
  const d = date ? Math.ceil((new Date(date).getTime() - Date.now()) / 86400_000) : NaN;
  return Number.isFinite(d) ? (d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`) : undefined;
}

function deployTone(state: string): Tone {
  if (state === "ready") return "ok";
  if (state === "error") return "bad";
  if (["new", "pending_review", "accepted", "enqueued", "building", "uploading", "uploaded", "preparing", "prepared", "processing", "processed"].includes(state)) return "pending";
  return "neutral";
}

export const netlify: Plugin = {
  id: "netlify",
  name: "Netlify",
  description: "Recent deploys with rebuild, retry and one-click rollback, plus credits left and what they are worth.",
  portalUrl: (c) => (c.site ? `https://app.netlify.com/sites/${String(c.site).replace(/\.netlify\.app$/, "")}` : "https://app.netlify.com"),
  env: [
    {
      key: "NETLIFY_TOKEN",
      help: "A Netlify personal access token.",
      url: "https://app.netlify.com/user/applications#personal-access-tokens",
      steps: [
        "Open the Applications page in your Netlify user settings.",
        "Under \"Personal access tokens\", press \"New access token\".",
        "Name it \"Management hub\", pick an expiration and generate it.",
        "Copy the token and paste it below. Netlify shows it only once.",
      ],
    },
  ],
  configFields: [
    { key: "site", label: "Site", placeholder: "mysite.netlify.app", required: true },
    ...MANUAL.map((m) => ({
      key: m.key,
      label: `${m.label} credits used (optional)`,
      type: "number" as const,
      timestamped: true,
      placeholder: "e.g. 21",
      help: `Netlify's API doesn't report ${m.label.toLowerCase()}. Copy it from Usage & billing > Credit usage breakdown, and update it now and then.`,
    })),
  ],

  async load(ctx) {
    const s = await nf(ctx, `/sites/${encodeURIComponent(site(ctx))}`);
    expectShape(s && typeof s.id === "string", "Netlify", "site details");
    const [deploys, bandwidth] = await Promise.all([
      nf<any[]>(ctx, `/sites/${s.id}/deploys?per_page=6`),
      s.account_slug ? optional(nf(ctx, `/accounts/${s.account_slug}/bandwidth`)) : undefined,
    ]);
    const credit = await credits(ctx, s.account_slug, Number(bandwidth?.used));
    expectShape(Array.isArray(deploys), "Netlify", "deploy list");

    const publishedId = s.published_deploy?.id;
    const items: PluginItem[] = deploys.map((d: any) => {
      const live = d.id === publishedId;
      const actions = [];
      if (d.state === "error") actions.push({ id: "retry", label: "Retry", args: { deployId: d.id } });
      if (d.state === "ready" && !live && d.context === "production") {
        actions.push({
          id: "publish",
          label: "Roll back to this",
          args: { deployId: d.id },
          confirm: "Publish this older deploy as the live site?",
        });
      }
      return {
        title: `${live ? "LIVE · " : ""}${d.title || d.commit_ref?.slice(0, 7) || d.id.slice(0, 8)}`,
        subtitle: `${d.context} · ${d.branch ?? ""} · ${d.state}${d.error_message ? ` · ${d.error_message}` : ""} · ${ago(d.created_at)}`,
        tone: deployTone(d.state),
        url: `https://app.netlify.com/sites/${s.name}/deploys/${d.id}`,
        actions,
      };
    });

    const latest = deploys[0];
    // Credit-based plans: one balance covers deploys, requests, compute and bandwidth.
    const out = credit && (credit.exceeded || credit.remaining <= 0);
    const creditTone: Tone = out ? "bad" : credit && credit.remaining / credit.included < 0.2 ? "warn" : "ok";
    const creditStats = credit
      ? [
          { label: "Credits used (est.)", value: `~${num(credit.used)} / ${num(credit.included)}`, tone: creditTone, limit: { used: credit.used, max: credit.included } },
          { label: "Credits left (est.)", value: `~${num(credit.remaining)}`, tone: creditTone },
          ...(daysUntil(credit.resets) ? [{ label: "Credits reset", value: daysUntil(credit.resets)! }] : []),
        ]
      : [];
    const e = credit?.estimate;
    const spentSection = e && {
      title: "Where credits went this period (estimate)",
      items: [
        { title: `${num(e.deploys)} production deploys: ${num(e.deployCredits)} credits`, subtitle: `All sites in the team, ${CREDIT_COSTS.deploy} credits each` },
        { title: `${bytes(e.bandwidthBytes)} bandwidth: ${num(Math.round(e.bandwidthCredits))} credits`, subtitle: `${CREDIT_COSTS.perBandwidthGb} credits per GB` },
        ...e.manual.map((m) =>
          m.credits === undefined
            ? {
                title: `${m.label}: not included`,
                subtitle: "Netlify's API doesn't report this. Type it into this tile's settings (from Netlify's Usage page) to include it.",
                url: `https://app.netlify.com/teams/${s.account_slug}/billing/usage`,
              }
            : m.stale
              ? {
                  title: `${m.label}: not included (last period's number)`,
                  subtitle: `You entered ${num(m.credits)} ${ago(m.at)}, before this period started. Update it in this tile's settings.`,
                  tone: "warn" as Tone,
                  url: `https://app.netlify.com/teams/${s.account_slug}/billing/usage`,
                }
              : {
                  title: `${m.label}: ${num(m.credits)} credits`,
                  subtitle: `Entered by you${m.at ? ` ${ago(m.at)}` : ""}; update it in this tile's settings`,
                },
        ),
      ],
    };
    const left = credit && creditEquivalents(credit.remaining);
    const creditSection = left && {
      title: "Credits left are enough for (any one of these)",
      items: [
        { title: `${num(left.deploys)} production deploys`, subtitle: `${CREDIT_COSTS.deploy} credits each · previews and branch deploys are free` },
        { title: `${compact(left.requests)} web requests`, subtitle: `${CREDIT_COSTS.per10kRequests} credits per 10,000` },
        { title: `${left.computeGbHours.toFixed(left.computeGbHours < 10 ? 1 : 0)} GB-hours of compute`, subtitle: `${CREDIT_COSTS.perComputeGbHour} credits per GB-hour (functions)` },
        { title: `${bytes(left.bandwidthBytes)} of bandwidth`, subtitle: `${CREDIT_COSTS.perBandwidthGb} credits per GB` },
      ],
    };

    const bw =
      !credit && bandwidth && Number.isFinite(bandwidth.used) && Number.isFinite(bandwidth.included) && bandwidth.included > 0
        ? {
            label: "Bandwidth this period",
            value: `${bytes(bandwidth.used)} / ${bytes(bandwidth.included)}`,
            tone: (bandwidth.used / bandwidth.included > 0.8 ? "warn" : "ok") as Tone,
            limit: { used: bandwidth.used, max: bandwidth.included },
          }
        : undefined;

    return {
      status: latest
        ? { label: `Latest deploy: ${latest.state}`, tone: deployTone(latest.state) }
        : { label: "No deploys yet", tone: "neutral" },
      stats: [
        { label: "Site", value: s.name },
        { label: "Published", value: ago(s.published_deploy?.published_at ?? s.updated_at) },
        ...creditStats,
        ...(bw ? [bw] : []),
      ],
      notice: out
        ? `${credit!.exceeded ? "Netlify says this team's credits are used up. New production deploys are blocked, and" : "By the hub's estimate this team's credits are used up (check the Usage page). Netlify blocks new production deploys, and"} once the balance hits zero Netlify pauses the team's sites. Add credits on the Usage page${daysUntil(credit!.resets) ? `, or wait until they reset ${daysUntil(credit!.resets)}` : ""}.`
        : undefined,
      sections: [
        ...(creditSection ? [creditSection] : []),
        ...(spentSection ? [spentSection] : []),
        { title: "Recent deploys", items, empty: "No deploys yet." },
      ],
      actions: [
        { id: "build", label: "Rebuild site" },
        { id: "buildClean", label: "Clear cache & rebuild", confirm: "Clear the build cache and rebuild?" },
      ],
      links: [
        { label: "Live site", url: s.ssl_url || s.url },
        { label: "Deploys", url: `https://app.netlify.com/sites/${s.name}/deploys` },
        { label: "Usage", url: `https://app.netlify.com/teams/${s.account_slug}/billing/usage` },
      ],
    };
  },

  // Saved every hour for analytics tiles. Credits and bandwidth are counted
  // per Netlify team (account), so they're tagged with the team, not the site.
  // Credit-based plans report credits; older plans report bandwidth.
  async collect(ctx) {
    const s = await nf(ctx, `/sites/${encodeURIComponent(site(ctx))}`);
    expectShape(s && typeof s.id === "string" && s.account_slug, "Netlify", "site details");
    const bw = await optional(nf(ctx, `/accounts/${s.account_slug}/bandwidth`));
    const credit = await credits(ctx, s.account_slug, Number(bw?.used));
    const hasBandwidth = Number.isFinite(bw?.used);
    expectShape(credit || hasBandwidth, "Netlify", "credit balance or bandwidth");
    const tags = { account: String(s.account_slug) };
    return [
      ...(credit
        ? [
            { metric: "netlify.credits_used", value: credit.used, tags },
            { metric: "netlify.credits_used.limit", value: credit.included, tags },
            { metric: "netlify.credits_left", value: credit.remaining, tags },
          ]
        : []),
      ...(hasBandwidth ? [{ metric: "netlify.bandwidth_bytes", value: bw.used, tags }] : []),
      ...(hasBandwidth && bw.included > 0 ? [{ metric: "netlify.bandwidth_bytes.limit", value: bw.included, tags }] : []),
    ];
  },

  actions: {
    async build(ctx) {
      const s = await nf(ctx, `/sites/${encodeURIComponent(site(ctx))}`);
      await nf(ctx, `/sites/${s.id}/builds`, { method: "POST", body: {} });
      return "Build started.";
    },
    async buildClean(ctx) {
      const s = await nf(ctx, `/sites/${encodeURIComponent(site(ctx))}`);
      await nf(ctx, `/sites/${s.id}/builds`, { method: "POST", body: { clear_cache: true } });
      return "Build started with a clean cache.";
    },
    async retry(ctx, { deployId }) {
      await nf(ctx, `/deploys/${encodeURIComponent(String(deployId))}/retry`, { method: "POST" });
      return "Retrying deploy.";
    },
    async publish(ctx, { deployId }) {
      const s = await nf(ctx, `/sites/${encodeURIComponent(site(ctx))}`);
      await nf(ctx, `/sites/${s.id}/deploys/${encodeURIComponent(String(deployId))}/restore`, { method: "POST" });
      return "That deploy is now live.";
    },
  },
};
