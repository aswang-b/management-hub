// The hub's local server: stores projects and tools, talks to external
// services for plugins, and serves the web page.
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

// Settings and tokens live in .env (HUB_ENV_FILE points elsewhere, e.g. for a test run).
const ENV_FILE = process.env.HUB_ENV_FILE || ".env";
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const db = await import("./db.ts");
const { plugins, getPlugin, pluginMeta, runLoad, runAction, clearCache, tokenKeys } = await import("./plugins/index.ts");
const { saveToken } = await import("./secrets.ts");
const { linkInfo, favicon, isLocalPath, openLocal } = await import("./links.ts");
const { analytics, listSeries } = await import("./metrics.ts");
const { collectAll, lastRun, startCollector } = await import("./collector.ts");

const app = new Hono();
const api = new Hono();

// Only this computer (and your own devices through Tailscale) may use the
// API. Other websites open in your browser can't: requests from another
// origin, from an unexpected host name, or that change data without a JSON
// body are refused.
const allowedHosts = ["localhost", "127.0.0.1", "[::1]", ...(process.env.HUB_ALLOWED_HOSTS ?? "").split(",").filter(Boolean)];
api.use("*", async (c, next) => {
  const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
  if (!allowedHosts.includes(host) && !host.endsWith(".ts.net")) return c.json({ error: "Host not allowed" }, 403);
  const origin = c.req.header("origin");
  if (origin && new URL(origin).host !== c.req.header("host")) return c.json({ error: "Cross-site request refused" }, 403);
  if (c.req.method !== "GET" && c.req.method !== "DELETE" && !(c.req.header("content-type") ?? "").startsWith("application/json")) {
    return c.json({ error: "Expected a JSON request" }, 415);
  }
  await next();
});

// ---- Projects
api.get("/projects", (c) => c.json(db.listProjects()));
api.post("/projects", async (c) => {
  const { name } = await c.req.json();
  return c.json(db.createProject(String(name ?? "").trim() || "Untitled"));
});
api.patch("/projects/:id", async (c) => {
  const p = db.updateProject(Number(c.req.param("id")), await c.req.json());
  return p ? c.json(p) : c.json({ error: "Project not found" }, 404);
});
api.delete("/projects/:id", (c) => {
  db.deleteProject(Number(c.req.param("id")));
  return c.json({ ok: true });
});

// ---- Tools
api.get("/projects/:id/tools", (c) => c.json(db.listTools(Number(c.req.param("id")))));
api.post("/projects/:id/tools", async (c) => {
  const b = await c.req.json();
  const projectId = Number(c.req.param("id"));
  if (!db.getProject(projectId)) return c.json({ error: "Project not found" }, 404);
  if (!["link", "plugin", "module"].includes(b.category)) return c.json({ error: "Unknown tool category" }, 400);
  return c.json(
    db.createTool({ projectId, category: b.category, type: String(b.type), x: b.x, y: b.y, w: b.w, h: b.h, config: b.config ?? {}, data: b.data ?? {} }),
  );
});
// Builder mode's Undo and Revert send back an earlier snapshot of the project.
api.post("/projects/:id/restore", async (c) => {
  const b = await c.req.json();
  if (!Array.isArray(b?.tools) || typeof b.gridWidth !== "number") return c.json({ error: "Expected a project snapshot" }, 400);
  if (b.tools.some((t: any) => !["link", "plugin", "module"].includes(t?.category) || typeof t.id !== "string")) {
    return c.json({ error: "Unknown tool in the snapshot" }, 400);
  }
  const p = db.restoreProject(Number(c.req.param("id")), { name: String(b.name ?? ""), gridWidth: b.gridWidth, tools: b.tools });
  return p ? c.json(p) : c.json({ error: "Project not found" }, 404);
});
api.put("/projects/:id/layout", async (c) => {
  db.saveLayout(Number(c.req.param("id")), await c.req.json());
  return c.json({ ok: true });
});
api.patch("/tools/:id", async (c) => {
  const b = await c.req.json();
  const t = db.updateTool(c.req.param("id"), b);
  return t ? c.json(t) : c.json({ error: "Tool not found" }, 404);
});
api.delete("/tools/:id", (c) => {
  db.deleteTool(c.req.param("id"));
  return c.json({ ok: true });
});

// ---- Plugins
api.get("/plugins", (c) => c.json(plugins.map(pluginMeta)));
api.get("/tools/:id/plugin", async (c) => {
  const t = db.getTool(c.req.param("id"));
  const p = t && getPlugin(t.type);
  if (!t || !p) return c.json({ error: "Plugin not found" }, 404);
  return c.json(await runLoad(p, t.id, t.config, c.req.query("fresh") === "1"));
});
api.post("/tools/:id/plugin/actions/:action", async (c) => {
  const t = db.getTool(c.req.param("id"));
  const p = t && getPlugin(t.type);
  if (!t || !p) return c.json({ error: "Plugin not found" }, 404);
  const { args } = await c.req.json().catch(() => ({ args: {} }));
  return c.json(await runAction(p, t.id, t.config, c.req.param("action"), args));
});

// ---- Tokens: saved into .env. The page can set a plugin's token but never read one.
api.put("/tokens/:key", async (c) => {
  const key = c.req.param("key");
  if (!tokenKeys().has(key)) return c.json({ ok: false, error: `${key} isn't a plugin token.` }, 400);
  const { value } = await c.req.json().catch(() => ({ value: undefined }));
  if (typeof value !== "string") return c.json({ ok: false, error: "Expected the token as text." }, 400);
  try {
    saveToken(key, value, ENV_FILE);
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400);
  }
  clearCache();
  return c.json({ ok: true, set: Boolean(value.trim()) });
});

// ---- Analytics
api.get("/metrics", (c) => c.json({ series: listSeries(), lastRun: lastRun() ?? null }));
api.post("/metrics/collect", async (c) => c.json(await collectAll()));
api.get("/tools/:id/analytics", (c) => {
  const t = db.getTool(c.req.param("id"));
  if (!t || t.type !== "analytics") return c.json({ ok: false, error: "Analytics tile not found" }, 404);
  return c.json(analytics(t.config));
});

// ---- Links
api.get("/link-info", async (c) => {
  const url = c.req.query("url") ?? "";
  if (isLocalPath(url)) return c.json({ title: url.split(/[\\/]/).filter(Boolean).pop() ?? url, local: true });
  try {
    return c.json(await linkInfo(new URL(url).toString()));
  } catch {
    return c.json({ error: "Not a valid link" }, 400);
  }
});
api.get("/favicon", async (c) => {
  try {
    const icon = await favicon(new URL(c.req.query("url") ?? "").toString());
    if (!icon) return c.body(null, 404);
    return c.body(icon.body as Uint8Array<ArrayBuffer>, 200, { "Content-Type": icon.type, "Cache-Control": "max-age=86400" });
  } catch {
    return c.body(null, 404);
  }
});
api.post("/open", async (c) => {
  const { target } = await c.req.json();
  if (!isLocalPath(String(target))) return c.json({ ok: false, error: "Not a local file path" }, 400);
  return c.json(openLocal(String(target)));
});

app.route("/api", api);

// ---- Web page (built by `npm run build` into web/dist)
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

const port = Number(process.env.HUB_PORT) || 8787;
const hostname = process.env.HUB_HOST || "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Management hub running at http://localhost:${port}`);
});
startCollector();
