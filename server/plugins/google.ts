// Google Cloud: the OAuth "Audience" page (publishing status, test users)
// and related pages have no public API, so this plugin is a set of deep
// links to the right console pages for your project, plus Google Cloud's
// public incident feed.
import { optional, request, type Plugin } from "./framework.ts";
import type { Tone } from "../../shared/types.ts";

const consoleUrl = (page: string, project: string) =>
  `https://console.cloud.google.com/${page}${project ? `?project=${encodeURIComponent(project)}` : ""}`;

export const google: Plugin = {
  id: "google",
  name: "Google Cloud",
  description: "Shortcuts to your project's sign-in (OAuth) audience, clients, billing and API quotas, plus Google Cloud incidents.",
  portalUrl: (c) => consoleUrl("auth/overview", c.projectId ?? ""),
  env: [],
  configFields: [{ key: "projectId", label: "Project ID", placeholder: "my-project-123456", required: true }],

  async load(ctx) {
    const p = ctx.config.projectId?.trim() ?? "";
    if (!p) throw new Error("Set the Google Cloud project ID.");

    // Public, no login needed.
    const incidents = await optional(request<any[]>("https://status.cloud.google.com/incidents.json", { service: "Google Cloud status" }));
    const open = Array.isArray(incidents) ? incidents.filter((i) => !i.end) : undefined;

    return {
      status: open
        ? open.length
          ? { label: `${open.length} open Google Cloud incident${open.length > 1 ? "s" : ""}`, tone: "warn" as Tone }
          : { label: "No open Google Cloud incidents", tone: "ok" as Tone }
        : undefined,
      notice:
        "Google has no API for the sign-in Audience page, so these open the console. Check the Audience page if Google sign-in stops working for new users (publishing status or test-user limits).",
      sections: open?.length
        ? [
            {
              title: "Open incidents",
              items: open.slice(0, 5).map((i) => ({
                title: i.external_desc ?? "Incident",
                subtitle: (i.affected_products ?? []).map((x: any) => x.title).join(", "),
                tone: "warn" as Tone,
                url: i.uri ? `https://status.cloud.google.com/${i.uri}` : "https://status.cloud.google.com",
              })),
            },
          ]
        : [],
      links: [
        { label: "Audience", url: consoleUrl("auth/audience", p) },
        { label: "OAuth clients", url: consoleUrl("auth/clients", p) },
        { label: "Branding", url: consoleUrl("auth/branding", p) },
        { label: "Billing", url: consoleUrl("billing/linkedaccount", p) },
        { label: "APIs & quotas", url: consoleUrl("apis/dashboard", p) },
      ],
    };
  },
  actions: {},
};
