// A side of the workspace used as a scratchpad: click anywhere to type, or
// switch to the pen to draw (mouse, pen or finger). Saved shortly after each
// change. Works in and out of builder mode; its own ↶ undoes the last change.
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Scratch, SideZone } from "../../../shared/types.ts";
import { api } from "../api.ts";

type Mode = "text" | "draw" | "erase";
const EMPTY: Scratch = { texts: [], strokes: [] };
const newId = () => Math.random().toString(36).slice(2, 10);
const SAVE_DELAY = 600;

export function Scratchpad({ projectId, side }: { projectId: number; side: SideZone }) {
  const [data, setData] = useState<Scratch>();
  const [mode, setMode] = useState<Mode>("text");
  const [focusId, setFocusId] = useState<string>();
  const [live, setLive] = useState<number[]>(); // the stroke being drawn
  const [undos, setUndos] = useState<Scratch[]>([]);
  const surface = useRef<HTMLDivElement>(null);
  const current = useRef<Scratch>(EMPTY);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const gesture = useRef<{ kind: "draw" | "erase" | "move"; id?: string; dx?: number; dy?: number; recorded?: boolean }>(undefined);
  const typing = useRef<string>(undefined); // text whose current edit is already undoable

  useEffect(() => {
    api.scratch(projectId, side).then(
      (d) => {
        current.current = d;
        setData(d);
      },
      () => setData(EMPTY),
    );
  }, [projectId, side]);

  const save = useCallback(() => {
    clearTimeout(pending.current);
    pending.current = undefined;
    api.saveScratch(projectId, side, current.current).catch((e) => alert(`Couldn't save the scratchpad: ${(e as Error).message}`));
  }, [projectId, side]);
  // Save straight away when leaving (another project, or the side switched to a grid).
  useEffect(() => () => void (pending.current && save()), [save]);

  /** Changes the scratchpad; `record` makes the change undoable with ↶. */
  const change = (next: Scratch, record = true) => {
    if (record) setUndos((u) => [...u.slice(-99), current.current]);
    current.current = next;
    setData(next);
    clearTimeout(pending.current);
    pending.current = setTimeout(save, SAVE_DELAY);
  };

  const undo = () => {
    const prev = undos.at(-1);
    if (!prev) return;
    setUndos((u) => u.slice(0, -1));
    change(prev, false);
  };

  const point = (e: { clientX: number; clientY: number }) => {
    const r = surface.current!.getBoundingClientRect();
    return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)];
  };

  // Removes the stroke or text under the pointer (erase mode).
  const eraseAt = (e: ReactPointerEvent) => {
    const el = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n instanceof Element && (n as HTMLElement).dataset?.scratch);
    const id = (el as HTMLElement | undefined)?.dataset.scratch;
    if (!id) return;
    const d = current.current;
    const g = gesture.current!;
    change({ texts: d.texts.filter((t) => t.id !== id), strokes: d.strokes.filter((s) => s.id !== id) }, !g.recorded);
    g.recorded = true;
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (mode === "text" && target.closest(".scratch-text, .scratch-grip")) return;
    if (mode === "draw") {
      e.preventDefault();
      surface.current!.setPointerCapture(e.pointerId);
      gesture.current = { kind: "draw" };
      setLive(point(e));
    } else if (mode === "erase") {
      surface.current!.setPointerCapture(e.pointerId);
      gesture.current = { kind: "erase" };
      eraseAt(e);
    }
  };

  // Text: a new text box where you clicked. (On click, not pointer-down: the
  // browser moves focus on mouse-down, which would leave the new box at once.)
  const moved = useRef(false);
  const onClick = (e: ReactMouseEvent) => {
    if (mode !== "text" || moved.current || (e.target as HTMLElement).closest(".scratch-note")) {
      moved.current = false;
      return;
    }
    const [x, y] = point(e);
    const id = newId();
    change({ ...current.current, texts: [...current.current.texts, { id, x, y: Math.max(0, y - 10), text: "" }] });
    typing.current = id;
    setFocusId(id);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "draw") {
      const [x, y] = point(e);
      setLive((pts) => {
        if (!pts) return pts;
        const [lx, ly] = pts.slice(-2);
        return Math.hypot(x - lx, y - ly) < 2 ? pts : [...pts, x, y];
      });
    } else if (g.kind === "erase") {
      eraseAt(e);
    } else if (g.kind === "move") {
      const [x, y] = point(e);
      const d = current.current;
      change({ ...d, texts: d.texts.map((t) => (t.id === g.id ? { ...t, x: Math.max(0, x - g.dx!), y: Math.max(0, y - g.dy!) } : t)) }, !g.recorded);
      g.recorded = true;
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = undefined;
    if (g?.kind === "move") moved.current = true; // the click that ends a move isn't a new text box
    if (g?.kind === "draw" && live) {
      // A tap leaves a dot.
      const points = live.length === 2 ? [...live, live[0] + 1, live[1]] : live;
      change({ ...current.current, strokes: [...current.current.strokes, { id: newId(), points }] });
      setLive(undefined);
    }
  };

  const startMove = (e: ReactPointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const t = current.current.texts.find((t) => t.id === id)!;
    const [x, y] = point(e);
    surface.current!.setPointerCapture(e.pointerId);
    gesture.current = { kind: "move", id, dx: x - t.x, dy: y - t.y };
  };

  const setText = (id: string, text: string) => {
    const d = current.current;
    change({ ...d, texts: d.texts.map((t) => (t.id === id ? { ...t, text } : t)) }, typing.current !== id);
    typing.current = id;
  };

  // An empty text box disappears when you click away.
  const leaveText = (id: string) => {
    typing.current = undefined;
    setFocusId(undefined);
    const d = current.current;
    if (d.texts.some((t) => t.id === id && !t.text.trim())) change({ ...d, texts: d.texts.filter((t) => t.id !== id) }, false);
  };

  const clear = () => {
    if (confirm("Clear everything on this scratchpad? (↶ brings it back.)")) change(EMPTY);
  };

  if (!data) return <div className="scratchpad muted pad">Loading…</div>;

  // The surface grows with its content (and is at least as tall as the window).
  const bottom = Math.max(
    0,
    ...data.texts.map((t) => t.y + 40 * (t.text.split("\n").length + 1)),
    ...data.strokes.flatMap((s) => s.points.filter((_, i) => i % 2 === 1)),
  );
  const empty = data.texts.length === 0 && data.strokes.length === 0;
  const line = (pts: number[]) => pts.reduce((s, n, i) => s + (i % 2 ? `,${n}` : ` ${n}`), "").trim();

  return (
    <div className="scratchpad">
      <div className="scratch-bar" role="toolbar" aria-label="Scratchpad">
        <div className="seg">
          <button className={mode === "text" ? "on" : ""} onClick={() => setMode("text")} title="Click anywhere to type">
            T Type
          </button>
          <button className={mode === "draw" ? "on" : ""} onClick={() => setMode("draw")} title="Draw with the mouse, a pen or your finger">
            ✎ Draw
          </button>
          <button className={mode === "erase" ? "on" : ""} onClick={() => setMode("erase")} title="Click or drag over lines and text to remove them">
            ⌫ Erase
          </button>
        </div>
        <span className="grow" />
        <button className="icon-btn" onClick={undo} disabled={undos.length === 0} title="Undo the last scratchpad change" aria-label="Undo">
          ↶
        </button>
        <button className="icon-btn" onClick={clear} disabled={empty} title="Clear the scratchpad" aria-label="Clear">
          ✕
        </button>
      </div>
      <div
        ref={surface}
        className={`scratch-surface scratch-${mode}`}
        style={{ minHeight: `max(calc(100vh - 150px), ${bottom + 120}px)` }}
        onPointerDown={onPointerDown}
        onClick={onClick}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {empty && !live && (
          <div className="scratch-hint muted">{mode === "draw" ? "Draw anywhere" : mode === "text" ? "Click anywhere to type" : "Nothing to erase"}</div>
        )}
        <svg className="scratch-ink">
          {data.strokes.map((s) => (
            <g key={s.id}>
              <polyline points={line(s.points)} className="ink" />
              {mode === "erase" && <polyline points={line(s.points)} className="ink-hit" data-scratch={s.id} />}
            </g>
          ))}
          {live && <polyline points={line(live.length === 2 ? [...live, live[0] + 1, live[1]] : live)} className="ink" />}
        </svg>
        {data.texts.map((t) => (
          <div key={t.id} className="scratch-note" style={{ left: t.x, top: t.y }} data-scratch={mode === "erase" ? t.id : undefined}>
            {mode === "text" && (
              <span className="scratch-grip" title="Drag to move" onPointerDown={(e) => startMove(e, t.id)} aria-hidden>
                ⠿
              </span>
            )}
            <textarea
              className="scratch-text"
              value={t.text}
              rows={1}
              spellCheck={false}
              readOnly={mode !== "text"}
              tabIndex={mode === "text" ? 0 : -1}
              autoFocus={t.id === focusId}
              aria-label="Scratchpad text"
              onChange={(e) => setText(t.id, e.target.value)}
              onBlur={() => leaveText(t.id)}
              onKeyDown={(e) => e.key === "Escape" && (e.target as HTMLTextAreaElement).blur()}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
