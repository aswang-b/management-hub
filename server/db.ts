// Storage: a single SQLite file at data/hub.db. Back up the hub by copying it.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { GRID_WIDTH, refit, type Project, type Tool, type ToolCategory } from "../shared/types.ts";

const DB_PATH = process.env.HUB_DB ?? "data/hub.db";
if (DB_PATH !== ":memory:") mkdirSync("data", { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    grid_width INTEGER NOT NULL DEFAULT ${GRID_WIDTH.default},
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    type TEXT NOT NULL,
    x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value BLOB,
    type TEXT,
    updated_at INTEGER NOT NULL
  );
`);

type Row = Record<string, any>;

const toProject = (r: Row): Project => ({ id: r.id, name: r.name, gridWidth: r.grid_width, sort: r.sort });
const toTool = (r: Row): Tool => ({
  id: r.id,
  projectId: r.project_id,
  category: r.category,
  type: r.type,
  x: r.x, y: r.y, w: r.w, h: r.h,
  config: JSON.parse(r.config),
  data: JSON.parse(r.data),
});

export const clampWidth = (n: number) =>
  Math.min(GRID_WIDTH.max, Math.max(GRID_WIDTH.min, Math.round(n) || GRID_WIDTH.default));

// ---- Projects

export function listProjects(): Project[] {
  return (db.prepare("SELECT * FROM projects ORDER BY sort, id").all() as Row[]).map(toProject);
}

export function getProject(id: number): Project | undefined {
  const r = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
  return r && toProject(r);
}

export function createProject(name: string): Project {
  const sort = (db.prepare("SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM projects").get() as Row).s;
  const r = db.prepare("INSERT INTO projects (name, sort) VALUES (?, ?) RETURNING *").get(name, sort) as Row;
  return toProject(r);
}

export function updateProject(id: number, patch: { name?: string; gridWidth?: number }): Project | undefined {
  const p = getProject(id);
  if (!p) return undefined;
  const name = patch.name?.trim() || p.name;
  const gridWidth = patch.gridWidth === undefined ? p.gridWidth : clampWidth(patch.gridWidth);
  db.prepare("UPDATE projects SET name = ?, grid_width = ? WHERE id = ?").run(name, gridWidth, id);
  // Keep every tool inside the new width.
  if (gridWidth < p.gridWidth) saveLayout(id, refit(listTools(id), gridWidth));
  return getProject(id);
}

export function deleteProject(id: number) {
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

// ---- Tools

export function listTools(projectId: number): Tool[] {
  return (db.prepare("SELECT * FROM tools WHERE project_id = ? ORDER BY y, x").all(projectId) as Row[]).map(toTool);
}

/** Every plugin tile in every project (for the hourly metrics collection). */
export function listPluginTools(): Tool[] {
  return (db.prepare("SELECT * FROM tools WHERE category = 'plugin' ORDER BY project_id, y, x").all() as Row[]).map(toTool);
}

export function getTool(id: string): Tool | undefined {
  const r = db.prepare("SELECT * FROM tools WHERE id = ?").get(id) as Row | undefined;
  return r && toTool(r);
}

export function createTool(t: Omit<Tool, "id" | "data"> & { data?: Tool["data"] }): Tool {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO tools (id, project_id, category, type, x, y, w, h, config, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, t.projectId, t.category as ToolCategory, t.type, t.x, t.y, t.w, t.h, JSON.stringify(t.config ?? {}), JSON.stringify(t.data ?? {}));
  return getTool(id)!;
}

export function updateTool(id: string, patch: Partial<Pick<Tool, "x" | "y" | "w" | "h" | "config" | "data">>): Tool | undefined {
  const t = getTool(id);
  if (!t) return undefined;
  const next = { ...t, ...patch };
  db.prepare("UPDATE tools SET x = ?, y = ?, w = ?, h = ?, config = ?, data = ? WHERE id = ?").run(
    next.x, next.y, next.w, next.h, JSON.stringify(next.config), JSON.stringify(next.data), id,
  );
  return getTool(id);
}

export function saveLayout(projectId: number, items: { id: string; x: number; y: number; w: number; h: number }[]) {
  const stmt = db.prepare("UPDATE tools SET x = ?, y = ?, w = ?, h = ? WHERE id = ? AND project_id = ?");
  db.exec("BEGIN");
  try {
    for (const i of items) stmt.run(i.x, i.y, i.w, i.h, i.id, projectId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** A project and its tools at one moment, for builder mode's Undo and Revert. */
export interface Snapshot {
  name: string;
  gridWidth: number;
  tools: Tool[];
}

/**
 * Puts a project back to a snapshot: its name, grid width, and which tools
 * exist with their places, sizes and settings. Content typed into a tool
 * since then (e.g. notes) is kept for tools that still exist.
 */
export function restoreProject(id: number, snap: Snapshot): Project | undefined {
  if (!getProject(id)) return undefined;
  const keep = new Set(snap.tools.map((t) => t.id));
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE projects SET name = ?, grid_width = ? WHERE id = ?").run(snap.name.trim() || "Untitled", clampWidth(snap.gridWidth), id);
    for (const t of listTools(id)) if (!keep.has(t.id)) deleteTool(t.id);
    const update = db.prepare("UPDATE tools SET x = ?, y = ?, w = ?, h = ?, config = ? WHERE id = ? AND project_id = ?");
    const insert = db.prepare(
      "INSERT INTO tools (id, project_id, category, type, x, y, w, h, config, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const t of snap.tools) {
      const config = JSON.stringify(t.config ?? {});
      const existing = getTool(t.id);
      if (existing && existing.projectId !== id) continue; // never touch another project's tools
      if (existing) update.run(t.x, t.y, t.w, t.h, config, t.id, id);
      else insert.run(t.id, id, t.category, t.type, t.x, t.y, t.w, t.h, config, JSON.stringify(t.data ?? {}));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getProject(id);
}

export function deleteTool(id: string) {
  db.prepare("DELETE FROM tools WHERE id = ?").run(id);
}

// ---- Small key/value cache (favicons, link titles)

export function cacheGet(key: string, maxAgeMs: number): { value: Uint8Array | string; type: string } | undefined {
  const r = db.prepare("SELECT * FROM cache WHERE key = ?").get(key) as Row | undefined;
  if (!r || Date.now() - r.updated_at > maxAgeMs) return undefined;
  return { value: r.value, type: r.type };
}

export function cacheSet(key: string, value: Uint8Array | string | null, type: string) {
  db.prepare("INSERT OR REPLACE INTO cache (key, value, type, updated_at) VALUES (?, ?, ?, ?)").run(key, value, type, Date.now());
}
