// A project's workspace: the grid of tools. In builder mode tools can be
// added, moved, resized (to their allowed sizes), configured and removed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactGridLayout, { noCompactor, useContainerWidth, type Layout } from "react-grid-layout";
import { firstFreeSpot, overlaps, type Project, type Tool } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { defKey, type Size, type ToolDef } from "../tools/registry.tsx";
import { Palette, SizeShape, dragging } from "./Palette.tsx";
import { ToolSettings } from "./ToolSettings.tsx";
import { isLocal } from "../tools/LinkTool.tsx";

const GAP = 8;
const PHONE_WIDTH = 640;
// On a phone, links sit in a 4-column row; everything else is full width.
const PHONE_COLS = 4;

export function Workspace({ project, registry, building }: { project: Project; registry: ToolDef[]; building: boolean }) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Tool>();
  const [sizeMenu, setSizeMenu] = useState<string>();
  const { width, containerRef, mounted } = useContainerWidth();
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const cols = project.gridWidth;
  const phone = mounted && width < PHONE_WIDTH;
  const cell = Math.max(20, (width - GAP * (cols - 1)) / cols);
  const defs = useMemo(() => new Map(registry.map((d) => [d.key, d])), [registry]);

  useEffect(() => {
    setLoaded(false);
    api.tools(project.id).then((t) => {
      setTools(t);
      setLoaded(true);
    });
  }, [project.id, project.gridWidth]);

  const persistLayout = useCallback(
    (next: Tool[]) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => api.saveLayout(project.id, next.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))), 300);
    },
    [project.id],
  );

  const onLayoutChange = (layout: Layout) => {
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
      setTools(next);
      persistLayout(next);
    }
  };

  async function add(def: ToolDef, size: Size, at?: { x: number; y: number }) {
    const w = Math.min(size.w, cols);
    let pos = at ?? firstFreeSpot(tools, cols, w, size.h);
    if (at && tools.some((t) => overlaps(t, { ...at, w, h: size.h }))) pos = firstFreeSpot(tools, cols, w, size.h);
    const tool = await api.createTool(project.id, { category: def.category, type: def.type, ...pos, w, h: size.h, config: {} });
    setTools((ts) => [...ts, tool]);
    if (def.configFields.some((f) => f.required)) setEditing(tool);
  }

  async function resize(tool: Tool, size: Size) {
    const w = Math.min(size.w, cols);
    let rect = { x: Math.min(tool.x, cols - w), y: tool.y, w, h: size.h };
    const others = tools.filter((t) => t.id !== tool.id);
    if (others.some((t) => overlaps(t, rect))) rect = { ...rect, ...firstFreeSpot(others, cols, w, size.h) };
    const next = tools.map((t) => (t.id === tool.id ? { ...t, ...rect } : t));
    setTools(next);
    setSizeMenu(undefined);
    await api.updateTool(tool.id, rect);
  }

  async function remove(tool: Tool) {
    if (!confirm(`Remove this ${defs.get(defKey(tool))?.name ?? "tool"}?`)) return;
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
              compactor={noCompactor}
              style={{ minHeight: gridHeight }}
              onLayoutChange={onLayoutChange}
              onDropDragOver={() => (dragging ? { w: Math.min(dragging.size.w, cols), h: dragging.size.h } : false)}
              onDrop={(_layout, item) => {
                if (dragging && item) add(dragging.def, dragging.size, { x: item.x, y: item.y });
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
