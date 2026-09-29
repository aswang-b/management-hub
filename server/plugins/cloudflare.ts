// Cloudflare: zone status, SSL mode, DNS count, 7-day traffic, cache purge
// and development mode.
// API docs: https://developers.cloudflare.com/api
import { expectShape, num, bytes, optional, request, type Plugin, type PluginContext } from "./framework.ts";
import type { EnvVar, Tone } from "../../shared/types.ts";

export const API = "https://api.cloudflare.com/client/v4";

/** Calls Cloudflare's API. Status codes in `allow` return null instead of an error. */
export async function cf<T = any>(ctx: PluginContext, path: string, init: { method?: string; body?: unknown; allow?: number[] } = {}): Promise<T> {
  const res = await request(`${API}${path}`, {
    ...init,
    service: "Cloudflare",
    tokenKey: "CLOUDFLARE_API_TOKEN",
    headers: { Authorization: `Bearer ${ctx.secret("CLOUDFLARE_API_TOKEN")}` },
  });
  if (res === null && init.allow) return null as T;
  // Cloudflare wraps every response in { success, errors, result }.
  expectShape(res && "result" in res, "Cloudflare", path.split("?")[0]);
  return (path.includes("dns_records") ? res : res.result) as T;
}

/** Runs a GraphQL Analytics query. */
export function cfGraphql(ctx: PluginContext, query: string, variables: Record<string, unknown>) {
  return request(`${API}/graphql`, {
    method: "POST",
    service: "Cloudflare",
    tokenKey: "CLOUDFLARE_API_TOKEN",
    headers: { Authorization: `Bearer ${ctx.secret("CLOUDFLARE_API_TOKEN")}` },
    body: { query, variables },
  });
}

/** One token serves both Cloudflare plugins (the zone one and Pages). */
export const CLOUDFLARE_TOKEN: EnvVar = {
  key: "CLOUDFLARE_API_TOKEN",
  help: "A Cloudflare API token limited to your domain and account. The Cloudflare and Cloudflare Pages plugins share it.",
  url: "https://dash.cloudflare.com/profile/api-tokens",
  steps: [
    "Open the API Tokens page in your Cloudflare profile. Already have a token for the other Cloudflare plugin? Press ⋯ next to it, then \"Edit\", add the permissions below and save: the token itself stays the same. Otherwise press \"Create Token\", and at the bottom next to \"Create Custom Token\" press \"Get started\".",
    "Name it \"Management hub\" and add the permissions for the plugins you use.",
    "Cloudflare plugin (your domain), all under Zone: Zone: Read, Zone Settings: Edit, DNS: Read, Cache Purge: Purge, Analytics: Read.",
    "Cloudflare Pages plugin, under Account: Cloudflare Pages: Edit (Read is enough if you don't need the Retry, Roll back and Rebuild buttons), Account Analytics: Read.",
    "Under Account Resources choose \"Include\" and your account. Under Zone Resources choose \"Include\", \"Specific zone\" and your domain.",
    "Press \"Continue to summary\", then \"Create Token\" (or \"Update Token\"). For a new token, copy it and paste it below. Cloudflare shows it only once.",
  ],
};

async function zone(ctx: PluginContext) {
  const name = ctx.config.zone?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!name) throw new Error("Set the domain (zone), e.g. example.com.");
  const zones = await cf<any[]>(ctx, `/zones?name=${encodeURIComponent(name)}`);
  if (!zones.length) throw new Error(`Cloudflare has no zone named ${name} that this token can see.`);
  return zones[0];
}

const TRAFFIC_QUERY = `query ($zone: String!, $since: Date!) {
  viewer { zones(filter: { zoneTag: $zone }) {
    httpRequests1dGroups(limit: 7, filter: { date_geq: $since }, orderBy: [date_ASC]) {
      sum { requests bytes cachedRequests threats pageViews }
      uniq { uniques }
    }
  } }
}`;

export const cloudflare: Plugin = {
  id: "cloudflare",
  name: "Cloudflare",
  description: "Zone status, SSL, DNS and 7-day traffic. Purge the cache or toggle development mode.",
  portalUrl: () => "https://dash.cloudflare.com",
  env: [CLOUDFLARE_TOKEN],
  configFields: [{ key: "zone", label: "Domain", placeholder: "example.com", required: true }],

  async load(ctx) {
    const z = await zone(ctx);
    const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const [devMode, ssl, dns, traffic] = await Promise.all([
      optional(cf(ctx, `/zones/${z.id}/settings/development_mode`)),
      optional(cf(ctx, `/zones/${z.id}/settings/ssl`)),
      optional(cf(ctx, `/zones/${z.id}/dns_records?per_page=1`)),
      optional(
        cfGraphql(ctx, TRAFFIC_QUERY, { zone: z.id, since }),
      ),
    ]);

    const days: any[] = traffic?.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? [];
    const total = days.reduce(
      (a, d) => ({
        requests: a.requests + (d.sum?.requests ?? 0),
        bytes: a.bytes + (d.sum?.bytes ?? 0),
        cached: a.cached + (d.sum?.cachedRequests ?? 0),
        threats: a.threats + (d.sum?.threats ?? 0),
        visitors: a.visitors + (d.uniq?.uniques ?? 0),
      }),
      { requests: 0, bytes: 0, cached: 0, threats: 0, visitors: 0 },
    );
    const devOn = devMode?.value === "on";

    return {
      status: {
        label: z.paused ? "Cloudflare paused" : `Zone ${z.status}`,
        tone: (z.paused ? "warn" : z.status === "active" ? "ok" : "pending") as Tone,
      },
      notice: devOn ? "Development mode is on: the cache is bypassed until it turns off (3 hours after enabling)." : undefined,
      stats: [
        { label: "Plan", value: z.plan?.name ?? "?" },
        ...(ssl ? [{ label: "SSL mode", value: String(ssl.value) }] : []),
        ...(dns?.result_info ? [{ label: "DNS records", value: String(dns.result_info.total_count) }] : []),
        ...(days.length
          ? [
              { label: "Requests (7d)", value: num(total.requests) },
              { label: "Unique visitors (7d)", value: num(total.visitors) },
              { label: "Bandwidth (7d)", value: bytes(total.bytes) },
              { label: "Cached (7d)", value: total.requests ? `${Math.round((total.cached / total.requests) * 100)}%` : "–" },
              { label: "Threats (7d)", value: num(total.threats), tone: (total.threats > 0 ? "warn" : "ok") as Tone },
            ]
          : []),
      ],
      actions: [
        { id: "purge", label: "Purge all cache", confirm: `Purge everything from Cloudflare's cache for ${z.name}?` },
        devOn
          ? { id: "devMode", label: "Turn dev mode off", args: { on: false } }
          : { id: "devMode", label: "Turn dev mode on", args: { on: true } },
      ],
      links: [
        { label: "Overview", url: `https://dash.cloudflare.com/${z.account?.id}/${z.name}` },
        { label: "DNS", url: `https://dash.cloudflare.com/${z.account?.id}/${z.name}/dns/records` },
        { label: "Analytics", url: `https://dash.cloudflare.com/${z.account?.id}/${z.name}/analytics/traffic` },
      ],
    };
  },

  actions: {
    async purge(ctx) {
      const z = await zone(ctx);
      await cf(ctx, `/zones/${z.id}/purge_cache`, { method: "POST", body: { purge_everything: true } });
      return "Cache purged.";
    },
    async devMode(ctx, { on }) {
      const z = await zone(ctx);
      await cf(ctx, `/zones/${z.id}/settings/development_mode`, { method: "PATCH", body: { value: on ? "on" : "off" } });
      return on ? "Development mode on." : "Development mode off.";
    },
  },
};
