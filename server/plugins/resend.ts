// Resend: sending domains, recent emails, daily/monthly volume against your
// plan's limits, domain re-verification and a test email.
// API docs: https://resend.com/docs/api-reference
import { ago, expectShape, num, request, type Plugin, type PluginContext } from "./framework.ts";
import type { Tone } from "../../shared/types.ts";

const API = "https://api.resend.com";
// Free plan limits. Change them in the tile settings if your plan differs.
const DEFAULT_DAILY = 100;
const DEFAULT_MONTHLY = 3000;
const MAX_PAGES = 30; // 3,000 emails at 100 per page

function rs<T = any>(ctx: PluginContext, path: string, init: { method?: string; body?: unknown } = {}) {
  return request<T>(`${API}${path}`, {
    ...init,
    service: "Resend",
    tokenKey: "RESEND_API_KEY",
    headers: { Authorization: `Bearer ${ctx.secret("RESEND_API_KEY")}` },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Emails sent since the start of this month (newest first). */
async function emailsThisMonth(ctx: PluginContext) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const emails: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await rs(ctx, `/emails?limit=100${after ? `&after=${after}` : ""}`);
    expectShape(Array.isArray(res?.data), "Resend", "email list");
    for (const e of res.data) {
      if (new Date(e.created_at) < monthStart) return { emails, complete: true };
      emails.push(e);
    }
    if (!res.has_more || !res.data.length) return { emails, complete: true };
    after = res.data[res.data.length - 1].id;
    await sleep(550); // Resend allows 2 requests per second
  }
  return { emails, complete: false };
}

/** Counts used by both the tile and the hourly analytics collection. */
async function usage(ctx: PluginContext) {
  const { emails, complete } = await emailsThisMonth(ctx);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  return {
    emails,
    complete,
    today: emails.filter((e) => new Date(e.created_at) >= dayStart).length,
    month: emails.length,
    bounced: emails.filter((e) => ["bounced", "complained"].includes(e.last_event)).length,
    daily: Number(ctx.config.dailyLimit) || DEFAULT_DAILY,
    monthly: Number(ctx.config.monthlyLimit) || DEFAULT_MONTHLY,
  };
}

function eventTone(e: string | undefined): Tone {
  if (!e) return "neutral";
  if (["delivered", "opened", "clicked"].includes(e)) return "ok";
  if (["bounced", "complained", "failed"].includes(e)) return "bad";
  if (["delivery_delayed"].includes(e)) return "warn";
  return "pending";
}

export const resend: Plugin = {
  id: "resend",
  name: "Resend",
  description: "Sending domains, recent emails and usage against your daily and monthly limits.",
  portalUrl: () => "https://resend.com/emails",
  env: [{ key: "RESEND_API_KEY", help: "Full-access API key from resend.com/api-keys." }],
  configFields: [
    { key: "dailyLimit", label: "Daily limit", placeholder: String(DEFAULT_DAILY), type: "number" },
    { key: "monthlyLimit", label: "Monthly limit", placeholder: String(DEFAULT_MONTHLY), type: "number" },
    { key: "testFrom", label: "Test email from", placeholder: "hub@yourdomain.com", help: "Must be on a verified domain." },
    { key: "testTo", label: "Test email to", placeholder: "you@example.com" },
  ],

  async load(ctx) {
    const domains = await rs(ctx, "/domains");
    expectShape(Array.isArray(domains?.data), "Resend", "domain list");
    const { emails, complete, today, month, bounced, daily, monthly } = await usage(ctx);
    const usageTone = (used: number, max: number): Tone => (used >= max ? "bad" : used / max > 0.8 ? "warn" : "ok");
    const unverified = domains.data.filter((d: any) => d.status !== "verified");

    return {
      status: unverified.length
        ? { label: `${unverified.length} domain${unverified.length > 1 ? "s" : ""} not verified`, tone: "warn" }
        : { label: "All domains verified", tone: "ok" },
      stats: [
        { label: "Sent today (UTC)", value: `${num(today)} / ${num(daily)}`, tone: usageTone(today, daily), limit: { used: today, max: daily } },
        {
          label: "Sent this month",
          value: `${complete ? "" : "> "}${num(month)} / ${num(monthly)}`,
          tone: usageTone(month, monthly),
          limit: { used: month, max: monthly },
        },
        { label: "Bounced / complaints", value: num(bounced), tone: bounced ? "warn" : "ok" },
      ],
      sections: [
        {
          title: "Domains",
          items: domains.data.map((d: any) => ({
            title: d.name,
            subtitle: `${d.status} · ${d.region ?? ""}`,
            tone: (d.status === "verified" ? "ok" : d.status === "pending" ? "pending" : "bad") as Tone,
            url: `https://resend.com/domains/${d.id}`,
            actions: d.status === "verified" ? [] : [{ id: "verifyDomain", label: "Verify", args: { domainId: d.id } }],
          })),
          empty: "No domains added.",
        },
        {
          title: "Recent emails",
          items: emails.slice(0, 5).map((e: any) => ({
            title: e.subject || "(no subject)",
            subtitle: `${[].concat(e.to).join(", ")} · ${e.last_event ?? ""} · ${ago(e.created_at)}`,
            tone: eventTone(e.last_event),
            url: `https://resend.com/emails/${e.id}`,
          })),
          empty: "No emails this month.",
        },
      ],
      actions:
        ctx.config.testFrom && ctx.config.testTo
          ? [{ id: "sendTest", label: "Send test email", confirm: `Send a test email to ${ctx.config.testTo}?` }]
          : [],
      links: [
        { label: "Emails", url: "https://resend.com/emails" },
        { label: "Domains", url: "https://resend.com/domains" },
        { label: "Usage", url: "https://resend.com/settings/usage" },
      ],
    };
  },

  // Saved every hour for analytics tiles. Counts are for the whole Resend account.
  async collect(ctx) {
    const { today, month, bounced, daily, monthly } = await usage(ctx);
    return [
      { metric: "resend.emails_today", value: today },
      { metric: "resend.emails_today.limit", value: daily },
      { metric: "resend.emails_month", value: month },
      { metric: "resend.emails_month.limit", value: monthly },
      { metric: "resend.bounces_month", value: bounced },
    ];
  },

  actions: {
    async verifyDomain(ctx, { domainId }) {
      await rs(ctx, `/domains/${encodeURIComponent(String(domainId))}/verify`, { method: "POST" });
      return "Verification started. Resend re-checks the DNS records over the next few minutes.";
    },
    async sendTest(ctx) {
      const { testFrom, testTo } = ctx.config;
      if (!testFrom || !testTo) throw new Error("Set the test email addresses in this tile's settings.");
      await rs(ctx, "/emails", {
        method: "POST",
        body: {
          from: testFrom,
          to: testTo,
          subject: "Management hub test email",
          text: `This is a test email sent from your management hub at ${new Date().toISOString()}.`,
        },
      });
      return `Test email sent to ${testTo}.`;
    },
  },
};
