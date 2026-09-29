// Supabase: project status, service health, database size, backups,
// and pausing/restoring the project.
// API docs: https://supabase.com/docs/reference/api
import { ago, bytes, expectShape, optional, request, type Plugin, type PluginContext } from "./framework.ts";
import type { Tone } from "../../shared/types.ts";

const API = "https://api.supabase.com/v1";
const FREE_DB_LIMIT_MB = 500;

function sb<T = any>(ctx: PluginContext, path: string, init: { method?: string; body?: unknown } = {}) {
  return request<T>(`${API}${path}`, {
    ...init,
    service: "Supabase",
    tokenKey: "SUPABASE_ACCESS_TOKEN",
    headers: { Authorization: `Bearer ${ctx.secret("SUPABASE_ACCESS_TOKEN")}` },
  });
}

function ref(ctx: PluginContext) {
  const r = ctx.config.projectRef?.trim();
  if (!r) throw new Error("Set the project reference (the id in your Supabase dashboard URL).");
  return r;
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE_HEALTHY: { label: "Active and healthy", tone: "ok" },
  ACTIVE_UNHEALTHY: { label: "Active but unhealthy", tone: "bad" },
  INACTIVE: { label: "Paused", tone: "warn" },
  PAUSING: { label: "Pausing", tone: "pending" },
  RESTORING: { label: "Restoring", tone: "pending" },
  COMING_UP: { label: "Starting", tone: "pending" },
  UPGRADING: { label: "Upgrading", tone: "pending" },
  RESTARTING: { label: "Restarting", tone: "pending" },
  GOING_DOWN: { label: "Shutting down", tone: "pending" },
  INIT_FAILED: { label: "Failed to start", tone: "bad" },
  REMOVED: { label: "Removed", tone: "bad" },
};

export const supabase: Plugin = {
  id: "supabase",
  name: "Supabase",
  description: "Project status, health, database size and backups. Restore a paused free-tier project in one click.",
  portalUrl: (c) => (c.projectRef ? `https://supabase.com/dashboard/project/${c.projectRef}` : "https://supabase.com/dashboard"),
  env: [
    {
      key: "SUPABASE_ACCESS_TOKEN",
      help: "A scoped personal access token, limited to the projects you show in the hub.",
      url: "https://supabase.com/dashboard/account/tokens",
      steps: [
        "Open the Access Tokens page in your Supabase account settings and start a new token.",
        "Make it a scoped token, not a classic one: a classic token can do everything on every project you have.",
        "Name it \"Management hub\" and pick an expiration date.",
        "Choose your organization, then only the project(s) you'll add to the hub.",
        "Give it these permissions and leave the rest without access: Project Settings: Read and write (Read is enough if you don't need the Restore and Pause buttons), Database: Read (for the database size), Backups: Read (for the last backup).",
        "Create the token, copy it (it starts with sbp_) and paste it below. Supabase shows it only once.",
      ],
    },
  ],
  configFields: [
    { key: "projectRef", label: "Project reference", placeholder: "abcdefghijklmnopqrst", required: true, help: "From your dashboard URL: /project/<reference>" },
    { key: "dbLimitMb", label: "Database size limit (MB)", placeholder: String(FREE_DB_LIMIT_MB), type: "number" },
  ],

  async load(ctx) {
    const r = ref(ctx);
    const project = await sb(ctx, `/projects/${r}`);
    expectShape(project && typeof project.status === "string", "Supabase", "project details");
    const status = STATUS[project.status] ?? { label: project.status, tone: "neutral" as Tone };
    const active = project.status.startsWith("ACTIVE");
    const limitMb = Number(ctx.config.dbLimitMb) || FREE_DB_LIMIT_MB;

    const [health, size, backups] = await Promise.all([
      active ? optional(sb<any[]>(ctx, `/projects/${r}/health?services=auth&services=db&services=rest&services=storage&services=realtime`)) : undefined,
      // The read-only query endpoint only needs the token's "Database: Read" permission.
      active
        ? optional(
            sb<any>(ctx, `/projects/${r}/database/query/read-only`, {
              method: "POST",
              body: { query: "select pg_catalog.pg_database_size(pg_catalog.current_database())::bigint as bytes" },
            }),
          )
        : undefined,
      optional(sb(ctx, `/projects/${r}/database/backups`)),
    ]);

    const rows = Array.isArray(size) ? size : (size?.result ?? size?.rows);
    const dbBytes = Number(rows?.[0]?.bytes);
    const lastBackup = backups?.backups?.[0];

    return {
      status,
      notice:
        project.status === "INACTIVE"
          ? "This project is paused. Free-tier projects pause after about a week without activity. Restore it to bring the site's database back."
          : undefined,
      stats: [
        { label: "Region", value: project.region ?? "?" },
        ...(Number.isFinite(dbBytes)
          ? [
              {
                label: "Database size",
                value: `${bytes(dbBytes)} / ${limitMb} MB`,
                tone: (dbBytes / (limitMb * 1e6) > 0.8 ? "warn" : "ok") as Tone,
                limit: { used: dbBytes, max: limitMb * 1e6 },
              },
            ]
          : []),
        ...(lastBackup ? [{ label: "Last backup", value: ago(lastBackup.inserted_at) }] : []),
      ],
      sections: Array.isArray(health)
        ? [
            {
              title: "Services",
              items: health.map((h: any) => ({
                title: h.name,
                subtitle: h.status ?? (h.healthy ? "healthy" : "unhealthy"),
                tone: (h.healthy ? "ok" : "bad") as Tone,
              })),
            },
          ]
        : [],
      actions:
        project.status === "INACTIVE"
          ? [{ id: "restore", label: "Restore project" }]
          : active
            ? [{ id: "pause", label: "Pause project", confirm: "Pause this Supabase project? The site's database will be offline until you restore it." }]
            : [],
      links: [
        { label: "Table editor", url: `https://supabase.com/dashboard/project/${r}/editor` },
        { label: "Auth users", url: `https://supabase.com/dashboard/project/${r}/auth/users` },
        { label: "Usage", url: `https://supabase.com/dashboard/project/${r}/settings/billing/usage` },
      ],
    };
  },

  actions: {
    async restore(ctx) {
      await sb(ctx, `/projects/${ref(ctx)}/restore`, { method: "POST" });
      return "Restoring. This can take a few minutes.";
    },
    async pause(ctx) {
      await sb(ctx, `/projects/${ref(ctx)}/pause`, { method: "POST" });
      return "Pausing project.";
    },
  },
};
