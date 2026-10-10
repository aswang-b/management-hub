// A project's workspace: the main grid of tools, with a space on each side
// that is either another grid or a scratchpad. In builder mode tools can be
// added, moved (within a grid, or to another grid), resized (to their allowed
// sizes), configured and removed, and each side can be switched between grid
// and scratchpad.
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { useContainerWidth, type Layout } from "react-grid-layout";
import {
  SIDE_GRID_WIDTH, SIDE_ZONES, firstFreeSpot, overlaps, refit,
  type Project, type SideZone, type Sides, type Tool, type Zone,
} from "../../../shared/types.ts";
import { api } from "../api.ts";
import { defKey, type Size, type ToolDef } from "../tools/registry.tsx";
import { Palette, SizeShape, dragging } from "./Palette.tsx";
import { ToolSettings } from "./ToolSettings.tsx";
import { ZoneGrid } from "./ZoneGrid.tsx";
import { Scratchpad } from "./Scratchpad.tsx";
import { isLocal } from "../tools/LinkTool.tsx";

const PHONE_WIDTH = 640;
// On a phone, links sit in a 4-column row; everything else is full width.
const PHONE_COLS = 4;
// The main grid is at most this wide; the sides share what's left.
const MAIN_MAX = 1200;
const ZONE_GAP = 16;
// Sides narrower than this aren't shown (their contents are kept).
const SIDE_MIN = 160;
const ZONE_NAMES: Record<Zone, string> = { main: "Main grid", left: "Left side", right: "Right side" };

export function Workspace({
  project,
  registry,
  building,
  toolsRef: shared,
  onBeforeChange = () => {},
  onSidesChange,
}: {
  project: Project;
  registry: ToolDef[];
  building: boolean;
  /** Filled with the current tools (undefined while loading), for Undo snapshots. */
  toolsRef?: RefObject<Tool[] | undefined>;
  /** Called just before a builder-mode change, so it can be undone. */
  onBeforeChange?: () => void;
  /** Saves new side settings (grid or scratchpad, side grid width). */
  onSidesChange: (sides: Sides) => void;
}) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Tool>();
  const [menu, setMenu] = useState<{ id: string; kind: "size" | "move" }>();
  const { width, containerRef, mounted } = useContainerWidth();

  const { sides } = project;
  // Measured without builder mode's palette, so the sides don't disappear
  // while building: the main grid gets a little narrower instead.
  const phone = mounted && width < PHONE_WIDTH;
  const sideWidth = (width - MAIN_MAX - 2 * ZONE_GAP) / 2;
  const showSides = mounted && !phone && sideWidth >= SIDE_MIN;
  const colsOf = useCallback((zone: Zone) => (zone === "main" ? project.gridWidth : sides[zone].gridWidth), [project.gridWidth, sides]);
  /** Zones that are grids and on screen: where tools can go. */
  const gridZones: Zone[] = ["main", ...(showSides ? SIDE_ZONES.filter((s) => sides[s].mode === "grid") : [])];
  const defs = useMemo(() => new Map(registry.map((d) => [d.key, d])), [registry]);
  const inZone = (zone: Zone, list = tools) => list.filter((t) => t.zone === zone);

  if (shared) shared.current = loaded ? tools : undefined;
  useEffect(() => () => void (shared && (shared.current = undefined)), [shared]);

  useEffect(() => {
    setLoaded(false);
    api.tools(project.id).then((all) => {
      // Repair layouts saved with overlapping tools (older versions allowed it).
      let fixed = all;
      for (const zone of ["main", ...SIDE_ZONES] as Zone[]) {
        const ts = inZone(zone, all);
        if (ts.some((a) => ts.some((b) => a !== b && overlaps(a, b)))) {
          const refitted = refit(ts, colsOf(zone));
          fixed = fixed.map((t) => refitted.find((r) => r.id === t.id) ?? t);
          api.saveLayout(project.id, refitted.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })));
        }
      }
      setTools(fixed);
      setLoaded(true);
    });
  }, [project.id, project.gridWidth, sides.left.gridWidth, sides.right.gridWidth]);

  const persistLayout = useCallback(
    (next: Tool[]) => api.saveLayout(project.id, next.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))),
    [project.id],
  );

  // Saves where tools ended up after a drag. (Only drag stops and drops save
  // positions; the grid's general "layout changed" event also fires with
  // stale positions around a drop.)
  const saveDragResult = (layout: Layout) => {
    if (!building) return;
    let changed = false;
    const next = tools.map((t) => {
      const l = layout.find((i) => i.i === t.id);
      if (l && (l.x !== t.x || l.y !== t.y || l.w !== t.w || l.h !== t.h)) {
        changed = true;
        return { ...t, x: l.x, y: l.y, w: l.w, h: l.h };
      }
      return t;
    });
    if (changed) {
      onBeforeChange();
      setTools(next);
      persistLayout(next);
    }
  };

  async function add(def: ToolDef, size: Size, zone: Zone, at?: { x: number; y: number }, current = tools, record = true) {
    if (record) onBeforeChange();
    const cols = colsOf(zone);
    const w = Math.min(size.w, cols);
    const taken = inZone(zone, current);
    let pos = at ?? firstFreeSpot(taken, cols, w, size.h);
    if (at && taken.some((t) => overlaps(t, { ...at, w, h: size.h }))) pos = firstFreeSpot(taken, cols, w, size.h);
    const tool = await api.createTool(project.id, { category: def.category, type: def.type, zone, ...pos, w, h: size.h, config: {} });
    setTools((ts) => [...ts, tool]);
    if (def.configFields.some((f) => f.required)) setEditing(tool);
  }

  const drop = (zone: Zone) => (layout: Layout, item: { x: number; y: number }) => {
    if (!dragging) return;
    // Keep the spots the other tools moved to while making room.
    const next = tools.map((t) => {
      const l = t.zone === zone && layout.find((l) => l.i === t.id);
      return l ? { ...t, x: l.x, y: l.y } : t;
    });
    onBeforeChange();
    setTools(next);
    persistLayout(next);
    add(dragging.def, dragging.size, zone, { x: item.x, y: item.y }, next, false);
  };

  async function resize(tool: Tool, size: Size) {
    setMenu(undefined);
    if (size.w === tool.w && size.h === tool.h) return;
    onBeforeChange();
    const cols = colsOf(tool.zone);
    const w = Math.min(size.w, cols);
    let rect = { x: Math.min(tool.x, cols - w), y: tool.y, w, h: size.h };
    const others = inZone(tool.zone).filter((t) => t.id !== tool.id);
    if (others.some((t) => overlaps(t, rect))) rect = { ...rect, ...firstFreeSpot(others, cols, w, size.h) };
    setTools(tools.map((t) => (t.id === tool.id ? { ...t, ...rect } : t)));
    await api.updateTool(tool.id, rect);
  }

  /** Moves a tool to the first free spot of another grid. */
  async function move(tool: Tool, zone: Zone) {
    setMenu(undefined);
    if (zone === tool.zone) return;
    onBeforeChange();
    const cols = colsOf(zone);
    const w = Math.min(tool.w, cols);
    const rect = { zone, ...firstFreeSpot(inZone(zone), cols, w, tool.h), w, h: tool.h };
    setTools(tools.map((t) => (t.id === tool.id ? { ...t, ...rect } : t)));
    await api.updateTool(tool.id, rect);
  }

  async function remove(tool: Tool) {
    if (!confirm(`Remove this ${defs.get(defKey(tool))?.name ?? "tool"}?`)) return;
    onBeforeChange();
    setTools((ts) => ts.filter((t) => t.id !== tool.id));
    await api.deleteTool(tool.id);
  }

  async function saveConfig(tool: Tool, config: Tool["config"]) {
    let data = tool.data;
    // For links, look up the site's name once so the tile can show it.
    if (tool.category === "link" && config.url && config.url !== tool.config.url) {
      const info = await api.linkInfo(String(config.url)).catch(() => undefined);
      data = { ...data, siteTitle: info?.title };
      if (!isLocal(String(config.url)) && !/^https?:\/\//i.test(String(config.url))) {
        config.url = `https://${config.url}`;
      }
    }
    try {
      // A new tool's first setup counts as part of adding it (one Undo removes both).
      const firstSetup = Object.keys(tool.config).length === 0;
      if (!firstSetup && JSON.stringify(config) !== JSON.stringify(tool.config)) onBeforeChange();
      const updated = await api.updateTool(tool.id, { config, data });
      setTools((ts) => ts.map((t) => (t.id === tool.id ? updated : t)));
      setEditing(undefined);
    } catch (e) {
      alert(`Couldn't save the settings: ${(e as Error).message}`);
    }
  }

  const saveData = useCallback((id: string, data: Tool["data"]) => {
    setTools((ts) => ts.map((t) => (t.id === id ? { ...t, data } : t)));
    api.updateTool(id, { data });
  }, []);

  const setSide = (side: SideZone, patch: Partial<Sides[SideZone]>) => onSidesChange({ ...sides, [side]: { ...sides[side], ...patch } });

  const tile = (tool: Tool) => {
    const def = defs.get(defKey(tool));
    const cols = colsOf(tool.zone);
    const moveTo = gridZones.filter((z) => z !== tool.zone);
    return (
      <div key={tool.id} className={`tile tile-${tool.category} ${building ? "tile-building" : ""}`}>
        {def ? def.render(tool, (data) => saveData(tool.id, data)) : <div className="muted pad">Unknown tool "{tool.type}"</div>}
        {building && (
          <div className="tile-overlay">
            <div className="tile-controls">
              <span className="tile-label">{def?.name ?? tool.type}</span>
              <span className="grow" />
              {moveTo.length > 0 && (
                <button className="icon-btn" title="Move to another grid" aria-label="Move to another grid" onClick={() => setMenu(menu?.id === tool.id && menu.kind === "move" ? undefined : { id: tool.id, kind: "move" })}>
                  ⇄
                </button>
              )}
              {def && def.sizes.length > 1 && (
                <button className="icon-btn" title="Change size" aria-label="Change size" onClick={() => setMenu(menu?.id === tool.id && menu.kind === "size" ? undefined : { id: tool.id, kind: "size" })}>
                  ⇲
                </button>
              )}
              {def && def.configFields.length > 0 && (
                <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => setEditing(tool)}>
                  ⚙
                </button>
              )}
              <button className="icon-btn" title="Remove" aria-label="Remove" onClick={() => remove(tool)}>
                ✕
              </button>
            </div>
            {menu?.id === tool.id && menu.kind === "size" && def && (
              <div className="size-menu">
                {def.sizes.map((s) => (
                  <button
                    key={`${s.w}x${s.h}`}
                    className={`size-btn ${s.w === tool.w && s.h === tool.h ? "on" : ""}`}
                    title={s.label}
                    disabled={s.w > cols}
                    onClick={() => resize(tool, s)}
                  >
                    <SizeShape size={s} />
                  </button>
                ))}
              </div>
            )}
            {menu?.id === tool.id && menu.kind === "move" && (
              <div className="size-menu">
                {moveTo.map((z) => (
                  <button key={z} className="btn" onClick={() => move(tool, z)}>
                    {ZONE_NAMES[z]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const grid = (zone: Zone) => (
    <ZoneGrid
      key={`${zone}:${colsOf(zone)}`}
      tools={inZone(zone)}
      cols={colsOf(zone)}
      building={building}
      tile={tile}
      onDragStop={saveDragResult}
      onDrop={drop(zone)}
    />
  );

  const side = (s: SideZone) => {
    const { mode, gridWidth } = sides[s];
    const kept = inZone(s).length;
    return (
      <div className={`side side-${s}`} key={s}>
        {building && (
          <div className="side-bar">
            <div className="seg" role="group" aria-label={`${ZONE_NAMES[s]}: grid or scratchpad`}>
              <button className={mode === "grid" ? "on" : ""} onClick={() => mode !== "grid" && setSide(s, { mode: "grid" })}>
                Grid
              </button>
              <button className={mode === "scratchpad" ? "on" : ""} onClick={() => mode !== "scratchpad" && setSide(s, { mode: "scratchpad" })}>
                Scratchpad
              </button>
            </div>
            {mode === "grid" && (
              <div className="side-width" title="Width of this grid, in squares">
                <button className="icon-btn" aria-label="Narrower" disabled={gridWidth <= SIDE_GRID_WIDTH.min} onClick={() => setSide(s, { gridWidth: gridWidth - 1 })}>
                  −
                </button>
                <span>{gridWidth}</span>
                <button className="icon-btn" aria-label="Wider" disabled={gridWidth >= SIDE_GRID_WIDTH.max} onClick={() => setSide(s, { gridWidth: gridWidth + 1 })}>
                  +
                </button>
              </div>
            )}
          </div>
        )}
        {mode === "grid" ? grid(s) : <Scratchpad projectId={project.id} side={s} />}
        {building && mode === "scratchpad" && kept > 0 && (
          <div className="muted pad side-note">
            {kept} tool{kept === 1 ? " is" : "s are"} kept on this side's grid. Switch to Grid to see {kept === 1 ? "it" : "them"}.
          </div>
        )}
      </div>
    );
  };

  const mainEmpty = loaded && tools.length === 0 && !building;
  const editingDef = editing && defs.get(defKey(editing));

  return (
    <div className={`workspace-wrap ${building && !phone ? "with-palette" : ""}`} ref={containerRef}>
      {building && !phone && <Palette registry={registry} onAdd={(d, s) => add(d, s, "main")} />}
      <div
        className="zones"
        style={{
          gridTemplateColumns: showSides
            ? `minmax(${SIDE_MIN}px, 1fr) minmax(0, ${MAIN_MAX}px) minmax(${SIDE_MIN}px, 1fr)`
            : `minmax(0, ${MAIN_MAX}px)`,
        }}
      >
        {loaded && showSides && side("left")}
        <div className="workspace">
          {mainEmpty && (
            <div className="empty-state">
              This project is empty. Press <strong>Build</strong> to add tools.
            </div>
          )}
          {mounted && loaded && phone && (
            <div className="phone-stack">
              {building && (
                <div className="muted pad" style={{ gridColumn: `span ${PHONE_COLS}` }}>
                  Builder mode works on a larger screen. You can still use the tools here.
                </div>
              )}
              {(["main", ...SIDE_ZONES.filter((s) => sides[s].mode === "grid")] as Zone[]).flatMap((zone) =>
                [...inZone(zone)]
                  .sort((a, b) => a.y - b.y || a.x - b.x)
                  .map((t) => (
                    <div
                      key={t.id}
                      className={`phone-item phone-${t.category}`}
                      style={{
                        gridColumn: `span ${t.category === "link" ? Math.min(t.w, PHONE_COLS) : PHONE_COLS}`,
                        height: t.category === "link" ? 64 : t.h === 1 ? 120 : Math.max(240, t.h * 120),
                      }}
                    >
                      {tile(t)}
                    </div>
                  )),
              )}
            </div>
          )}
          {mounted && loaded && !phone && grid("main")}
        </div>
        {loaded && showSides && side("right")}
      </div>
      {editing && editingDef && (
        <ToolSettings def={editingDef} tool={editing} onSave={(c) => saveConfig(editing, c)} onClose={() => setEditing(undefined)} />
      )}
    </div>
  );
}
