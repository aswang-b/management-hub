// Types shared by the server and the web page.

export type ToolCategory = "link" | "plugin" | "module";

export interface Project {
  id: number;
  name: string;
  gridWidth: number;
  sort: number;
}

export interface Tool {
  id: string;
  projectId: number;
  category: ToolCategory;
  /** Which tool this is, e.g. "link", "notes", or a plugin id like "github". */
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Settings entered in builder mode (URL, repo name, ...). */
  config: Record<string, unknown>;
  /** Content the tool saves while in use (e.g. notes text). */
  data: Record<string, unknown>;
}

export const GRID_WIDTH = { min: 4, max: 12, default: 6 } as const;

// ---- Plugins ---------------------------------------------------------------
// Every plugin returns the same "view" shape. The page draws it with one
// generic component, so adding or fixing a plugin only touches the server.

export type Tone = "ok" | "warn" | "bad" | "pending" | "neutral";

export interface PluginAction {
  /** Action id handled by the plugin on the server. */
  id: string;
  label: string;
  args?: Record<string, unknown>;
  /** When set, the page asks this question before running the action. */
  confirm?: string;
}

export interface PluginItem {
  title: string;
  subtitle?: string;
  tone?: Tone;
  url?: string;
  actions?: PluginAction[];
}

export interface PluginView {
  status?: { label: string; tone: Tone };
  stats?: { label: string; value: string; tone?: Tone; limit?: { used: number; max: number } }[];
  sections?: { title: string; items: PluginItem[]; empty?: string }[];
  actions?: PluginAction[];
  links?: { label: string; url: string }[];
  notice?: string;
}

export interface PluginResult {
  ok: boolean;
  view?: PluginView;
  /** What went wrong, in plain words, and what to do about it. */
  error?: string;
  errorKind?: "setup" | "auth" | "not-found" | "changed" | "network" | "other";
  /** Link to the service's own website, shown on every plugin tile. */
  portalUrl?: string;
  fetchedAt: string;
}

export interface PluginConfigField {
  key: string;
  label: string;
  /** Example text; for a "select", the value chosen at first. */
  placeholder?: string;
  help?: string;
  required?: boolean;
  type?: "text" | "number" | "select";
  /** Choices for a "select" field. */
  options?: { value: string; label: string }[];
}

/** A token a plugin reads from .env, with instructions for getting one. */
export interface EnvVar {
  key: string;
  /** One line: what kind of token this is. */
  help: string;
  /** The service's page where the token is created. */
  url?: string;
  /** Step-by-step instructions shown in the hub. */
  steps?: string[];
}

export interface PluginMeta {
  id: string;
  name: string;
  description: string;
  /** Tokens, and whether each is set. The values never leave the server. */
  env: (EnvVar & { set: boolean })[];
  configFields: PluginConfigField[];
}

// ---- Grid placement

export type Rect = { x: number; y: number; w: number; h: number };

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** First spot, reading left-to-right then top-to-bottom, where a w×h tool fits. */
export function firstFreeSpot(taken: Rect[], cols: number, w: number, h: number): { x: number; y: number } {
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= cols; x++) {
      if (!taken.some((t) => overlaps(t, { x, y, w, h }))) return { x, y };
    }
  }
}

/**
 * Where the other tools go while one is being dragged. Every tool starts from
 * its position before the drag (`home`): it stays there if it doesn't touch
 * the dragged tool, otherwise it moves to the nearest free spot. Because this
 * always starts from `home`, tools slide back once the dragged tool moves on.
 */
export function makeRoom<T extends Rect & { i: string }>(home: T[], moving: T, cols: number): T[] {
  const w = Math.min(moving.w, cols);
  const placed: Rect[] = [{ ...moving, w, x: Math.max(0, Math.min(moving.x, cols - w)), y: Math.max(0, moving.y) }];
  const out = new Map<string, T>([[moving.i, { ...moving, ...placed[0] }]]);
  const others = home.filter((t) => t.i !== moving.i).sort((a, b) => a.y - b.y || a.x - b.x);

  // First keep every tool that can stay at home, then find spots for the rest.
  const displaced: T[] = [];
  for (const t of others) {
    if (placed.some((p) => overlaps(p, t))) displaced.push(t);
    else {
      placed.push(t);
      out.set(t.i, t);
    }
  }
  for (const t of displaced) {
    const spot = nearestFreeSpot(placed, cols, t);
    placed.push({ ...t, ...spot });
    out.set(t.i, { ...t, ...spot });
  }
  return home.map((t) => out.get(t.i) ?? t).concat(home.some((t) => t.i === moving.i) ? [] : [out.get(moving.i)!]);
}

/** The free spot closest to where a tool is now (ties go to the higher, then left-most spot). */
export function nearestFreeSpot(taken: Rect[], cols: number, t: Rect): { x: number; y: number } {
  const w = Math.min(t.w, cols);
  const maxY = taken.reduce((m, r) => Math.max(m, r.y + r.h), 0);
  let best: { x: number; y: number; d: number } | undefined;
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const d = (x - t.x) ** 2 + (y - t.y) ** 2;
      if (best && (d > best.d || (d === best.d && (y > best.y || (y === best.y && x >= best.x))))) continue;
      if (!taken.some((r) => overlaps(r, { x, y, w, h: t.h }))) best = { x, y, d };
    }
  }
  return best ? { x: best.x, y: best.y } : { x: 0, y: maxY };
}

/** Fits tools into a narrower grid: keeps each where it is when possible, otherwise moves it to the next free spot. */
export function refit<T extends Rect>(tools: T[], cols: number): T[] {
  const placed: T[] = [];
  for (const t of [...tools].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const w = Math.min(t.w, cols);
    let rect = { x: Math.min(t.x, cols - w), y: t.y, w, h: t.h };
    if (placed.some((p) => overlaps(p, rect))) rect = { ...rect, ...firstFreeSpot(placed, cols, w, t.h) };
    placed.push({ ...t, ...rect });
  }
  return placed;
}
