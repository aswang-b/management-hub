// Service status: public status pages for the services the site depends on.
// All of these use Atlassian Statuspage, which serves /api/v2/summary.json.
// No login needed.
import { request, type Plugin } from "./framework.ts";
import type { PluginItem, Tone } from "../../shared/types.ts";

export const STATUS_PAGES: Record<string, { name: string; url: string }> = {
  github: { name: "GitHub", url: "https://www.githubstatus.com" },
  supabase: { name: "Supabase", url: "https://status.supabase.com" },
  cloudflare: { name: "Cloudflare", url: "https://www.cloudflarestatus.com" },
  netlify: { name: "Netlify", url: "https://www.netlifystatus.com" },
  resend: { name: "Resend", url: "https://resend-status.com" },
};

const TONE: Record<string, Tone> = { none: "ok", minor: "warn", major: "bad", critical: "bad", maintenance: "pending" };

export const status: Plugin = {
  id: "status",
  name: "Service status",
  description: "Live status of GitHub, Supabase, Cloudflare, Netlify and Resend from their public status pages.",
  portalUrl: () => "https://www.githubstatus.com",
  env: [],
  configFields: [
    {
      key: "services",
      label: "Services",
      placeholder: Object.keys(STATUS_PAGES).join(", "),
      help: `Comma-separated. Leave empty for all. Options: ${Object.keys(STATUS_PAGES).join(", ")}`,
    },
  ],

  async load(ctx) {
    const wanted = (ctx.config.services || Object.keys(STATUS_PAGES).join(","))
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => STATUS_PAGES[s]);

    const items: PluginItem[] = await Promise.all(
      wanted.map(async (key) => {
        const page = STATUS_PAGES[key];
        try {
          const s = await request(`${page.url}/api/v2/summary.json`, { service: page.name });
          const indicator: string = s?.status?.indicator ?? "unknown";
          const incident = s?.incidents?.[0]?.name;
          return {
            title: page.name,
            subtitle: incident ? `${s.status.description} · ${incident}` : s?.status?.description ?? "Unknown",
            tone: TONE[indicator] ?? "neutral",
            url: page.url,
          };
        } catch {
          return { title: page.name, subtitle: "Status page unreachable", tone: "neutral" as Tone, url: page.url };
        }
      }),
    );

    const worst: Tone = items.some((i) => i.tone === "bad")
      ? "bad"
      : items.some((i) => i.tone === "warn")
        ? "warn"
        : items.every((i) => i.tone === "ok")
          ? "ok"
          : "neutral";
    const label = { ok: "All systems operational", bad: "Some services are down", warn: "Some services have issues" }[worst as string];
    return {
      status: { label: label ?? "Some status pages unreachable", tone: worst },
      sections: [{ title: "Services", items }],
    };
  },
  actions: {},
};
