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
}

const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v));

/**
 * The team's credit balance. Not in Netlify's published API docs, so it's
 * read carefully: undefined (not an error) on older plans or if it changes.
 */
async function credits(ctx: PluginContext, slug: string | undefined): Promise<Credits | undefined> {
  if (!slug) return undefined;
  const accounts = await optional(nf<any[]>(ctx, "/accounts"));
  let account = Array.isArray(accounts) ? accounts.find((a) => a?.slug === slug) : undefined;
  if (account?.id && !account.capabilities?.credits) account = await optional(nf(ctx, `/accounts/${account.id}`));
  const c = account?.capabilities?.credits;
  const included = Number(c?.included);
  const used = Number(c?.used);
  if (!Number.isFinite(included) || !Number.isFinite(used) || included <= 0) return undefined;
  return {
    included,
    used,
    remaining: Math.max(0, included - used),
    resets: account.next_usage_period_start,
    exceeded: nonEmpty(account.usages_exceeded),
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
  configFields: [{ key: "site", label: "Site", placeholder: "mysite.netlify.app", required: true }],

  async load(ctx) {
    const s = await nf(ctx, `/sites/${encodeURIComponent(site(ctx))}`);
    expectShape(s && typeof s.id === "string", "Netlify", "site details");
    const [deploys, credit, bandwidth] = await Promise.all([
      nf<any[]>(ctx, `/sites/${s.id}/deploys?per_page=6`),
      credits(ctx, s.account_slug),
      s.account_slug ? optional(nf(ctx, `/accounts/${s.account_slug}/bandwidth`)) : undefined,
    ]);
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
          { label: "Credits used", value: `${num(credit.used)} / ${num(credit.included)}`, tone: creditTone, limit: { used: credit.used, max: credit.included } },
          { label: "Credits left", value: num(credit.remaining), tone: creditTone },
          ...(daysUntil(credit.resets) ? [{ label: "Credits reset", value: daysUntil(credit.resets)! }] : []),
        ]
      : [];
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
        ? `Netlify says this team's credits are used up. New production deploys are blocked, and once the balance hits zero Netlify pauses the team's sites. Add credits on the Usage page${daysUntil(credit!.resets) ? `, or wait until they reset ${daysUntil(credit!.resets)}` : ""}.`
        : undefined,
      sections: [...(creditSection ? [creditSection] : []), { title: "Recent deploys", items, empty: "No deploys yet." }],
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
    const [credit, bw] = await Promise.all([credits(ctx, s.account_slug), optional(nf(ctx, `/accounts/${s.account_slug}/bandwidth`))]);
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
