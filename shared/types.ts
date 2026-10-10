// Types shared by the server and the web page.

export type ToolCategory = "link" | "plugin" | "module";

export interface Project {
  id: number;
  name: string;
  /** Width of the main grid, in squares. */
  gridWidth: number;
  sort: number;
  /** The spaces left and right of the main grid. */
  sides: Sides;
}

// ---- Zones: the main grid plus a space on each side of it. A side is either
// another grid of tools (with its own width) or a scratchpad to type and draw on.

export type SideZone = "left" | "right";
export type Zone = "main" | SideZone;
export const ZONES: Zone[] = ["main", "left", "right"];
export const SIDE_ZONES: SideZone[] = ["left", "right"];
export type SideMode = "grid" | "scratchpad";
export interface SideSettings {
  mode: SideMode;
  /** Width of the side's grid, in squares (used when mode is "grid"). */
  gridWidth: number;
}
export type Sides = Record<SideZone, SideSettings>;
export const SIDE_GRID_WIDTH = { min: 1, max: 6, default: 2 } as const;

const clamp = (n: unknown, r: { min: number; max: number; default: number }) =>
  Math.min(r.max, Math.max(r.min, Math.round(Number(n)) || r.default));

/** Fills in and corrects side settings (from the database or a request). */
export function normalizeSides(v: unknown, base?: Sides): Sides {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, any>;
  const side = (k: SideZone): SideSettings => {
    const s = o[k] && typeof o[k] === "object" ? o[k] : {};
    const b = base?.[k] ?? { mode: "scratchpad", gridWidth: SIDE_GRID_WIDTH.default };
    return {
      mode: s.mode === "grid" || s.mode === "scratchpad" ? s.mode : b.mode,
      gridWidth: s.gridWidth === undefined ? b.gridWidth : clamp(s.gridWidth, SIDE_GRID_WIDTH),
    };
  };
  return { left: side("left"), right: side("right") };
}

/** What's typed and drawn on a scratchpad. Positions are in pixels from its top-left corner. */
export interface Scratch {
  texts: { id: string; x: number; y: number; text: string }[];
  /** Each stroke is a list of points, flattened: [x1, y1, x2, y2, ...]. */
  strokes: { id: string; points: number[] }[];
}

export interface Tool {
  id: string;
  projectId: number;
  category: ToolCategory;
  /** Which tool this is, e.g. "link", "notes", or a plugin id like "github". */
  type: string;
  /** Which grid the tool is on. */
  zone: Zone;
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
  /** Record when the value was last changed, in `config[key + "At"]` (for numbers typed in by hand). */
  timestamped?: boolean;
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
