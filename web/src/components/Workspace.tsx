// A project's workspace: the grid of tools. In builder mode tools can be
// added, moved, resized (to their allowed sizes), configured and removed.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import ReactGridLayout, { useContainerWidth, type Compactor, type Layout } from "react-grid-layout";
import { firstFreeSpot, makeRoom, overlaps, refit, type Project, type Tool } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { defKey, type Size, type ToolDef } from "../tools/registry.tsx";
import { Palette, SizeShape, dragging } from "./Palette.tsx";
import { ToolSettings } from "./ToolSettings.tsx";
import { isLocal } from "../tools/LinkTool.tsx";

const GAP = 8;
const PHONE_WIDTH = 640;
// On a phone, links sit in a 4-column row; everything else is full width.
const PHONE_COLS = 4;
// The grid library's id for a tool being dragged in from the palette.
const DROPPING_ID = "__dropping-elem__";

export function Workspace({
  project,
  registry,
  building,
  toolsRef: shared,
  onBeforeChange = () => {},
}: {
  project: Project;
  registry: ToolDef[];
  building: boolean;
  /** Filled with the current tools (undefined while loading), for Undo snapshots. */
  toolsRef?: RefObject<Tool[] | undefined>;
  /** Called just before a builder-mode change, so it can be undone. */
  onBeforeChange?: () => void;
}) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Tool>();
  const [sizeMenu, setSizeMenu] = useState<string>();
  const { width, containerRef, mounted } = useContainerWidth();

  const cols = project.gridWidth;
  const phone = mounted && width < PHONE_WIDTH;
  const cell = Math.max(20, (width - GAP * (cols - 1)) / cols);
  const defs = useMemo(() => new Map(registry.map((d) => [d.key, d])), [registry]);

  // While a tool is dragged, the others make room for it (see makeRoom in
  // shared/types.ts): each starts from its saved spot, so tools pushed aside
  // slide back when the dragged tool moves on. Outside a drag, every tool
  // sits at its saved spot.
  const latest = useRef(tools);
  latest.current = tools;
  if (shared) shared.current = loaded ? tools : undefined;
  useEffect(() => () => void (shared && (shared.current = undefined)), [shared]);
  const dragId = useRef<string>(undefined);
  const compactor = useMemo<Compactor>(
    () => ({
      type: null,
      allowOverlap: false,
      compact(layout, gridCols) {
        const home = layout.map((l) => {
          const t = latest.current.find((t) => t.id === l.i);
          return t ? { ...l, x: t.x, y: t.y } : { ...l };
        });
        const moving = layout.find((l) => l.i === dragId.current || l.i === DROPPING_ID);
        return moving ? makeRoom(home, { ...moving }, gridCols) : home;
      },
    }),
    [],
  );

  useEffect(() => {
    setLoaded(false);
    api.tools(project.id).then((t) => {
      // Repair layouts saved with overlapping tools (older versions allowed it).
      const overlapping = t.some((a) => t.some((b) => a !== b && overlaps(a, b)));
      const fixed = overlapping ? refit(t, cols) : t;
      if (overlapping) api.saveLayout(project.id, fixed.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })));
      setTools(fixed);
      setLoaded(true);
    });
  }, [project.id, project.gridWidth]);

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

  async function add(def: ToolDef, size: Size, at?: { x: number; y: number }, current = tools, record = true) {
    if (record) onBeforeChange();
    const w = Math.min(size.w, cols);
    let pos = at ?? firstFreeSpot(current, cols, w, size.h);
    if (at && current.some((t) => overlaps(t, { ...at, w, h: size.h }))) pos = firstFreeSpot(current, cols, w, size.h);
    const tool = await api.createTool(project.id, { category: def.category, type: def.type, ...pos, w, h: size.h, config: {} });
    setTools((ts) => [...ts, tool]);
    if (def.configFields.some((f) => f.required)) setEditing(tool);
  }

  async function resize(tool: Tool, size: Size) {
    setSizeMenu(undefined);
    if (size.w === tool.w && size.h === tool.h) return;
    onBeforeChange();
    const w = Math.min(size.w, cols);
    let rect = { x: Math.min(tool.x, cols - w), y: tool.y, w, h: size.h };
    const others = tools.filter((t) => t.id !== tool.id);
    if (others.some((t) => overlaps(t, rect))) rect = { ...rect, ...firstFreeSpot(others, cols, w, size.h) };
    const next = tools.map((t) => (t.id === tool.id ? { ...t, ...rect } : t));
    setTools(next);
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

  const tile = (tool: Tool) => {
    const def = defs.get(defKey(tool));
    return (
      <div key={tool.id} className={`tile tile-${tool.category} ${building ? "tile-building" : ""}`}>
        {def ? def.render(tool, (data) => saveData(tool.id, data)) : <div className="muted pad">Unknown tool "{tool.type}"</div>}
        {building && (
          <div className="tile-overlay">
            <div className="tile-controls">
              <span className="tile-label">{def?.name ?? tool.type}</span>
              <span className="grow" />
              {def && def.sizes.length > 1 && (
                <button className="icon-btn" title="Change size" onClick={() => setSizeMenu(sizeMenu === tool.id ? undefined : tool.id)}>
                  ⇲
                </button>
              )}
              {def && def.configFields.length > 0 && (
                <button className="icon-btn" title="Settings" onClick={() => setEditing(tool)}>
                  ⚙
                </button>
              )}
              <button className="icon-btn" title="Remove" onClick={() => remove(tool)}>
                ✕
              </button>
            </div>
            {sizeMenu === tool.id && def && (
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
          </div>
        )}
      </div>
    );
  };

  const rows = Math.max(tools.reduce((m, t) => Math.max(m, t.y + t.h), 0) + (building ? 3 : 0), building ? 6 : 0);
  const gridHeight = rows * (cell + GAP) - GAP;
  const editingDef = editing && defs.get(defKey(editing));

  return (
    <div className={`workspace-wrap ${building && !phone ? "with-palette" : ""}`}>
      {building && !phone && <Palette registry={registry} onAdd={(d, s) => add(d, s)} />}
      <div className="workspace" ref={containerRef}>
        {loaded && tools.length === 0 && !building && (
          <div className="empty-state">
            This project is empty. Press <strong>Build</strong> to add tools.
          </div>
        )}
        {mounted && loaded && phone && (
          <div className="phone-stack">
            {building && <div className="muted pad" style={{ gridColumn: `span ${PHONE_COLS}` }}>
                Builder mode works on a larger screen. You can still use the tools here.
              </div>}
            {[...tools]
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
              ))}
          </div>
        )}
        {mounted && loaded && !phone && (
          <div className="grid-area" style={{ minHeight: gridHeight }}>
            {building && (
              <div className="grid-cells" style={{ gridTemplateColumns: `repeat(${cols}, ${cell}px)`, gridAutoRows: `${cell}px`, gap: GAP }}>
                {Array.from({ length: rows * cols }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
            )}
            <ReactGridLayout
              width={width}
              layout={tools.map((t) => ({ i: t.id, x: t.x, y: t.y, w: t.w, h: t.h, static: !building }))}
              gridConfig={{ cols, rowHeight: cell, margin: [GAP, GAP], containerPadding: [0, 0] }}
              dragConfig={{ enabled: building, cancel: ".tile-controls button, .size-menu" }}
              resizeConfig={{ enabled: false }}
              dropConfig={{ enabled: building, defaultItem: { w: 1, h: 1 } }}
              compactor={compactor}
              style={{ minHeight: gridHeight }}
              onDragStart={(_layout, item) => (dragId.current = item?.i)}
              onDragStop={(layout) => {
                dragId.current = undefined;
                saveDragResult(layout);
              }}
              onDropDragOver={() => (dragging ? { w: Math.min(dragging.size.w, cols), h: dragging.size.h } : false)}
              onDrop={(layout, item) => {
                if (!dragging || !item) return;
                // Keep the spots the other tools moved to while making room.
                const next = tools.map((t) => {
                  const l = layout.find((l) => l.i === t.id);
                  return l ? { ...t, x: l.x, y: l.y } : t;
                });
                onBeforeChange();
                setTools(next);
                persistLayout(next);
                add(dragging.def, dragging.size, { x: item.x, y: item.y }, next, false);
              }}
            >
              {tools.map(tile)}
            </ReactGridLayout>
          </div>
        )}
      </div>
      {editing && editingDef && (
        <ToolSettings def={editingDef} tool={editing} onSave={(c) => saveConfig(editing, c)} onClose={() => setEditing(undefined)} />
      )}
    </div>
  );
}
