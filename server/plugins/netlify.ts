// Netlify: deploys, rebuilds, rollbacks and bandwidth.
// API docs: https://open-api.netlify.com
import { ago, bytes, expectShape, optional, request, type Plugin, type PluginContext } from "./framework.ts";
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

function deployTone(state: string): Tone {
  if (state === "ready") return "ok";
  if (state === "error") return "bad";
  if (["new", "pending_review", "accepted", "enqueued", "building", "uploading", "uploaded", "preparing", "prepared", "processing", "processed"].includes(state)) return "pending";
  return "neutral";
}

export const netlify: Plugin = {
  id: "netlify",
  name: "Netlify",
  description: "Recent deploys with rebuild, retry and one-click rollback, plus bandwidth use.",
  portalUrl: (c) => (c.site ? `https://app.netlify.com/sites/${String(c.site).replace(/\.netlify\.app$/, "")}` : "https://app.netlify.com"),
  env: [{ key: "NETLIFY_TOKEN", help: "Personal access token from app.netlify.com/user/applications." }],
  configFields: [{ key: "site", label: "Site", placeholder: "mysite.netlify.app", required: true }],

  async load(ctx) {
    const s = await nf(ctx, `/sites/${encodeURIComponent(site(ctx))}`);
    expectShape(s && typeof s.id === "string", "Netlify", "site details");
    const [deploys, bandwidth] = await Promise.all([
      nf<any[]>(ctx, `/sites/${s.id}/deploys?per_page=6`),
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
    const bw =
      bandwidth && Number.isFinite(bandwidth.used) && Number.isFinite(bandwidth.included) && bandwidth.included > 0
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
        ...(bw ? [bw] : []),
      ],
      sections: [{ title: "Recent deploys", items, empty: "No deploys yet." }],
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

  // Saved every hour for analytics tiles. Bandwidth is counted per Netlify
  // team (account), so it's tagged with the team, not the site.
  async collect(ctx) {
    const s = await nf(ctx, `/sites/${encodeURIComponent(site(ctx))}`);
    expectShape(s && typeof s.id === "string" && s.account_slug, "Netlify", "site details");
    const bw = await nf(ctx, `/accounts/${s.account_slug}/bandwidth`);
    expectShape(Number.isFinite(bw?.used), "Netlify", "bandwidth");
    const tags = { account: String(s.account_slug) };
    return [
      { metric: "netlify.bandwidth_bytes", value: bw.used, tags },
      ...(bw.included > 0 ? [{ metric: "netlify.bandwidth_bytes.limit", value: bw.included, tags }] : []),
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
