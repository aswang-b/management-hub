// One grid of tools (the main grid, or a side set to "grid"). The tools and
// what happens to them live in Workspace; this draws them and reports drags
// and drops. A tool dragged out to another grid is handled by Workspace: this
// grid then stops making room for it (`draggingOut`), and the grid it's over
// shows where it will land (`ghost`).
import { useMemo, useRef, type ReactNode } from "react";
import ReactGridLayout, { useContainerWidth, type Compactor, type Layout, type LayoutItem } from "react-grid-layout";
import { makeRoom, type Rect, type Tool, type Zone } from "../../../shared/types.ts";
import { dragging } from "./Palette.tsx";

export const GAP = 8;
// The grid library's id for a tool being dragged in from the palette.
const DROPPING_ID = "__dropping-elem__";

export function ZoneGrid({
  zone,
  tools,
  cols,
  building,
  tile,
  onDragStart,
  onDrag,
  onDragStop,
  onDrop,
  draggingOut = false,
  ghost,
}: {
  zone: Zone;
  /** The tools on this grid. */
  tools: Tool[];
  cols: number;
  building: boolean;
  tile: (t: Tool) => ReactNode;
  onDragStart?: (id: string) => void;
  /** Every pointer move during a drag, with the dragged tile's element. */
  onDrag?: (e: Event, el: HTMLElement | null) => void;
  /** Positions after a tool was dragged. */
  onDragStop: (layout: Layout) => void;
  /** A tool from the palette was dropped at `item`; `layout` has where the others moved to. */
  onDrop: (layout: Layout, item: LayoutItem) => void;
  /** The tool being dragged from this grid is over another grid. */
  draggingOut?: boolean;
  /** Where a tool dragged in from another grid will land. */
  ghost?: Rect;
}) {
  const { width, containerRef, mounted } = useContainerWidth();
  const cell = Math.max(20, (width - GAP * (cols - 1)) / cols);

  // While a tool is dragged, the others make room for it (see makeRoom in
  // shared/types.ts): each starts from its saved spot, so tools pushed aside
  // slide back when the dragged tool moves on. Outside a drag, every tool
  // sits at its saved spot.
  const latest = useRef(tools);
  latest.current = tools;
  const dragId = useRef<string>(undefined);
  const out = useRef(draggingOut);
  out.current = draggingOut;
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
        return moving && !out.current ? makeRoom(home, { ...moving }, gridCols) : home;
      },
    }),
    [],
  );

  const rows = Math.max([...tools, ...(ghost ? [ghost] : [])].reduce((m, t) => Math.max(m, t.y + t.h), 0) + (building ? 3 : 0), building ? 6 : 0);
  const at = (n: number) => n * (cell + GAP);
  const span = (n: number) => n * cell + (n - 1) * GAP;
  const gridHeight = rows * (cell + GAP) - GAP;

  return (
    <div
      className={`grid-area ${draggingOut ? "dragging-out" : ""}`}
      data-zone={zone}
      data-cols={cols}
      ref={containerRef}
      style={{ minHeight: Math.max(0, gridHeight) }}
    >
      {mounted && building && (
        <div className="grid-cells" style={{ gridTemplateColumns: `repeat(${cols}, ${cell}px)`, gridAutoRows: `${cell}px`, gap: GAP }}>
          {Array.from({ length: rows * cols }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={tools.map((t) => ({ i: t.id, x: t.x, y: t.y, w: t.w, h: t.h, static: !building }))}
          gridConfig={{ cols, rowHeight: cell, margin: [GAP, GAP], containerPadding: [0, 0] }}
          dragConfig={{ enabled: building, cancel: ".tile-controls button, .size-menu" }}
          resizeConfig={{ enabled: false }}
          dropConfig={{ enabled: building, defaultItem: { w: 1, h: 1 } }}
          compactor={compactor}
          style={{ minHeight: Math.max(0, gridHeight) }}
          onDragStart={(_layout, item) => {
            dragId.current = item?.i;
            if (item) onDragStart?.(item.i);
          }}
          onDrag={(_layout, _old, _new, _placeholder, e, el) => onDrag?.(e, el)}
          onDragStop={(layout) => {
            dragId.current = undefined;
            onDragStop(layout);
          }}
          onDropDragOver={() => (dragging ? { w: Math.min(dragging.size.w, cols), h: dragging.size.h } : false)}
          onDrop={(layout, item) => {
            if (dragging && item) onDrop(layout, item);
          }}
        >
          {tools.map(tile)}
        </ReactGridLayout>
      )}
      {mounted && ghost && (
        <div className="grid-ghost" style={{ left: at(ghost.x), top: at(ghost.y), width: span(ghost.w), height: span(ghost.h) }} />
      )}
    </div>
  );
}
