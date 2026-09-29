// Calls to the hub's local server.
import type { PluginMeta, PluginResult, Project, Tool } from "../../shared/types.ts";
import type { AnalyticsResult, CollectRun, Series } from "../../shared/metrics.ts";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `Request failed (${res.status})`);
  return res.json();
}

export const api = {
  projects: () => call<Project[]>("GET", "/projects"),
  createProject: (name: string) => call<Project>("POST", "/projects", { name }),
  updateProject: (id: number, patch: Partial<Pick<Project, "name" | "gridWidth">>) => call<Project>("PATCH", `/projects/${id}`, patch),
  deleteProject: (id: number) => call("DELETE", `/projects/${id}`),
  restoreProject: (id: number, snapshot: { name: string; gridWidth: number; tools: Tool[] }) =>
    call<Project>("POST", `/projects/${id}/restore`, snapshot),

  tools: (projectId: number) => call<Tool[]>("GET", `/projects/${projectId}/tools`),
  createTool: (projectId: number, t: Omit<Tool, "id" | "projectId" | "data">) => call<Tool>("POST", `/projects/${projectId}/tools`, t),
  updateTool: (id: string, patch: Partial<Pick<Tool, "x" | "y" | "w" | "h" | "config" | "data">>) => call<Tool>("PATCH", `/tools/${id}`, patch),
  deleteTool: (id: string) => call("DELETE", `/tools/${id}`),
  saveLayout: (projectId: number, items: { id: string; x: number; y: number; w: number; h: number }[]) =>
    call("PUT", `/projects/${projectId}/layout`, items),

  plugins: () => call<PluginMeta[]>("GET", "/plugins"),
  pluginView: (toolId: string, fresh = false) => call<PluginResult>("GET", `/tools/${toolId}/plugin${fresh ? "?fresh=1" : ""}`),
  pluginAction: (toolId: string, action: string, args?: Record<string, unknown>) =>
    call<{ ok: boolean; message?: string; error?: string }>("POST", `/tools/${toolId}/plugin/actions/${action}`, { args }),

  setToken: (key: string, value: string) => call<{ ok: boolean; set: boolean }>("PUT", `/tokens/${encodeURIComponent(key)}`, { value }),

  metrics: () => call<{ series: Series[]; lastRun: CollectRun | null }>("GET", "/metrics"),
  collectMetrics: () => call<CollectRun>("POST", "/metrics/collect", {}),
  analytics: (toolId: string) => call<AnalyticsResult>("GET", `/tools/${toolId}/analytics`),

  linkInfo: (url: string) => call<{ title: string; local?: boolean; error?: string }>("GET", `/link-info?url=${encodeURIComponent(url)}`),
  openLocal: (target: string) => call<{ ok: boolean; error?: string }>("POST", "/open", { target }),
};
