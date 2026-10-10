// A side of the workspace used as a scratchpad. Modes: pointer (click text to
// edit it, drag it to move it), type (click anywhere to add text), draw (mouse,
// pen or finger; width and colour) and erase. Text has a size, bold, italic
// and colour. Saved shortly after each change. Works in and out of builder
// mode; its own ↶ undoes the last change.
import {
  useCallback, useEffect, useRef, useState,
  type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import { SCRATCH_LIMITS, type Scratch, type ScratchText, type SideZone } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { ColorPicker } from "./ColorPicker.tsx";

type Mode = "select" | "text" | "draw" | "erase";
type Pen = { color: string; width: number };
type TextStyle = Required<Pick<ScratchText, "size" | "bold" | "italic" | "color">>;
const EMPTY: Scratch = { texts: [], strokes: [] };
const newId = () => Math.random().toString(36).slice(2, 10);
const SAVE_DELAY = 600;
const FONT_SIZES = [10, 12, 14, 16, 20, 24, 32, 48, 64];
const DEFAULTS = { pen: { color: "#000000", width: 2 } as Pen, text: { size: 14, bold: false, italic: false, color: "#000000" } as TextStyle };
// Your last pen and text settings, remembered in this browser.
const PREFS_KEY = "hub.scratchpad.tools";

function loadPrefs(): typeof DEFAULTS {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return { pen: { ...DEFAULTS.pen, ...p.pen }, text: { ...DEFAULTS.text, ...p.text } };
  } catch {
    return DEFAULTS;
  }
}

const styleOf = (t: ScratchText): TextStyle => ({
  size: t.size ?? DEFAULTS.text.size,
  bold: t.bold ?? false,
  italic: t.italic ?? false,
  color: t.color ?? DEFAULTS.text.color,
});

// Mouse pointers: a circle the size of the pen, and an eraser.
const svgCursor = (svg: string, x: number, y: number, fallback: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
function penCursor({ color, width }: Pen) {
  const d = Math.max(6, Math.min(40, width)) + 4;
  const c = d / 2;
  return svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${c}" cy="${c}" r="${c - 1.5}" fill="${color}" fill-opacity="0.35" stroke="#000" stroke-width="1"/><circle cx="${c}" cy="${c}" r="${c - 2.5}" fill="none" stroke="#fff" stroke-width="1"/></svg>`,
    Math.round(c), Math.round(c), "crosshair",
  );
}
const ERASER_PATH = "M3.5 13.5 1.5 11.5a1 1 0 0 1 0-1.4L9.6 2a1 1 0 0 1 1.4 0l3.5 3.5a1 1 0 0 1 0 1.4L7.9 13.5ZM5.4 6.2l4.9 4.9";
const ERASER_CURSOR = svgCursor(
  `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="-2 -2 20 20"><path d="${ERASER_PATH}" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/><path d="M1 15.5h14" stroke="#000" stroke-width="1.4"/></svg>`,
  4, 15, "cell",
);

export const EraserIcon = () => (
  <svg viewBox="-1 -1 18 18" width="15" height="15" aria-hidden>
    <path d={ERASER_PATH} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M7.9 13.5H15" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
const PointerIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M3.5 1.5v11.5l3-3 2.2 4.6 1.8-.9-2.2-4.5h4.2Z" fill="currentColor" />
  </svg>
);

export function Scratchpad({ projectId, side }: { projectId: number; side: SideZone }) {
  const [data, setData] = useState<Scratch>();
  const [mode, setMode] = useState<Mode>("select");
  const [prefs, setPrefs] = useState(loadPrefs);
  const [focusId, setFocusId] = useState<string>(); // a new text box to focus
  const [selectedId, setSelectedId] = useState<string>(); // the text the text options change
  const [live, setLive] = useState<number[]>(); // the stroke being drawn
  const [undos, setUndos] = useState<Scratch[]>([]);
  const surface = useRef<HTMLDivElement>(null);
  const current = useRef<Scratch>(EMPTY);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const gesture = useRef<{
    kind: "draw" | "erase" | "move" | "press";
    id?: string; dx?: number; dy?: number; sx?: number; sy?: number; recorded?: boolean;
  }>(undefined);
  const typing = useRef<string>(undefined); // text whose current edit is already undoable
  const moved = useRef(false); // the click that ends a move isn't a new text box

  useEffect(() => {
    api.scratch(projectId, side).then(
      (d) => {
        current.current = d;
        setData(d);
      },
      () => setData(EMPTY),
    );
  }, [projectId, side]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* not available: settings just aren't remembered */
    }
  }, [prefs]);

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
  const updateText = (id: string, patch: Partial<ScratchText>, record = true) => {
    const d = current.current;
    change({ ...d, texts: d.texts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }, record);
  };

  const undo = () => {
    const prev = undos.at(-1);
    if (!prev) return;
    setUndos((u) => u.slice(0, -1));
    change(prev, false);
  };

  /** Where the pointer is on the scratchpad, kept inside its edges. */
  const point = (e: { clientX: number; clientY: number }) => {
    const r = surface.current!.getBoundingClientRect();
    return [Math.round(Math.min(r.width, Math.max(0, e.clientX - r.left))), Math.round(Math.min(r.height, Math.max(0, e.clientY - r.top)))];
  };

  // Removes the stroke or text under the pointer (erase mode).
  const eraseAt = (e: { clientX: number; clientY: number }) => {
    const el = document.elementsFromPoint(e.clientX, e.clientY).find((n) => (n as HTMLElement).dataset?.scratch);
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
    const note = target.closest<HTMLElement>(".scratch-note");
    if (mode === "draw") {
      e.preventDefault();
      surface.current!.setPointerCapture(e.pointerId);
      gesture.current = { kind: "draw" };
      setLive(point(e));
    } else if (mode === "erase") {
      surface.current!.setPointerCapture(e.pointerId);
      gesture.current = { kind: "erase" };
      eraseAt(e);
    } else if (mode === "select" && note && !target.closest("textarea:focus")) {
      // Pointer mode: drag a text to move it; a plain click edits it.
      e.preventDefault();
      const id = note.dataset.id!;
      const t = current.current.texts.find((t) => t.id === id)!;
      const [x, y] = point(e);
      surface.current!.setPointerCapture(e.pointerId);
      gesture.current = { kind: "press", id, dx: x - t.x, dy: y - t.y, sx: x, sy: y };
    }
  };

  // Type mode: a new text box where you clicked. (On click, not pointer-down:
  // the browser moves focus on mouse-down, which would leave the new box at once.)
  const onClick = (e: ReactMouseEvent) => {
    const onNote = (e.target as HTMLElement).closest(".scratch-note");
    if (moved.current) {
      moved.current = false;
      return;
    }
    if (!onNote && !(e.target as HTMLElement).closest(".scratch-bar")) setSelectedId(undefined);
    if (mode !== "text" || onNote) return;
    const [x, y] = point(e);
    const id = newId();
    const style = prefs.text;
    change({ ...current.current, texts: [...current.current.texts, { id, x, y: Math.max(0, y - style.size / 2 - 4), text: "", ...style }] });
    typing.current = id;
    setFocusId(id);
    setSelectedId(id);
  };

  const moveText = (g: NonNullable<typeof gesture.current>, x: number, y: number) => {
    const w = surface.current!.getBoundingClientRect().width;
    updateText(g.id!, { x: Math.min(w - 24, Math.max(0, x - g.dx!)), y: Math.max(0, y - g.dy!) }, !g.recorded);
    g.recorded = true;
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const [x, y] = point(e);
    if (g.kind === "draw") {
      setLive((pts) => {
        if (!pts) return pts;
        const [lx, ly] = pts.slice(-2);
        return Math.hypot(x - lx, y - ly) < 2 ? pts : [...pts, x, y];
      });
    } else if (g.kind === "erase") {
      eraseAt(e);
    } else if (g.kind === "press" && Math.hypot(x - g.sx!, y - g.sy!) > 3) {
      g.kind = "move";
      moveText(g, x, y);
    } else if (g.kind === "move") {
      moveText(g, x, y);
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = undefined;
    if (g?.kind === "move") moved.current = true;
    if (g?.kind === "press") {
      // A click on a text in pointer mode: edit it.
      setSelectedId(g.id);
      surface.current?.querySelector<HTMLTextAreaElement>(`[data-id="${g.id}"] textarea`)?.focus();
    }
    if (g?.kind === "draw" && live) {
      // A tap leaves a dot.
      const points = live.length === 2 ? [...live, live[0] + 1, live[1]] : live;
      change({ ...current.current, strokes: [...current.current.strokes, { id: newId(), points, ...prefs.pen }] });
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
    updateText(id, { text }, typing.current !== id);
    typing.current = id;
  };

  // An empty text box disappears when you click away.
  const leaveText = (id: string) => {
    typing.current = undefined;
    setFocusId(undefined);
    const d = current.current;
    if (d.texts.some((t) => t.id === id && !t.text.trim())) {
      change({ ...d, texts: d.texts.filter((t) => t.id !== id) }, false);
      setSelectedId((s) => (s === id ? undefined : s));
    }
  };

  const clear = () => {
    if (confirm("Clear everything on this scratchpad? (↶ brings it back.)")) change(EMPTY);
  };

  if (!data) return <div className="scratchpad muted pad">Loading…</div>;

  // Text options change the selected text (and are used for new text).
  const selected = data.texts.find((t) => t.id === selectedId);
  const textStyle = selected ? styleOf(selected) : prefs.text;
  const setTextStyle = (patch: Partial<TextStyle>) => {
    setPrefs((p) => ({ ...p, text: { ...p.text, ...patch } }));
    if (selected) updateText(selected.id, patch);
  };
  const setPen = (patch: Partial<Pen>) => setPrefs((p) => ({ ...p, pen: { ...p.pen, ...patch } }));

  // The surface grows with its content (and is at least as tall as the window).
  const bottom = Math.max(
    0,
    ...data.texts.map((t) => t.y + (t.size ?? 14) * 1.6 * (t.text.split("\n").length + 1)),
    ...data.strokes.flatMap((s) => s.points.filter((_, i) => i % 2 === 1)),
  );
  const empty = data.texts.length === 0 && data.strokes.length === 0;
  const line = (pts: number[]) => pts.reduce((s, n, i) => s + (i % 2 ? `,${n}` : ` ${n}`), "").trim();
  // Buttons that shouldn't take focus away from the text being edited.
  const keep = (e: ReactMouseEvent) => e.preventDefault();

  const modeBtn = (m: Mode, title: string, icon: ReactNode) => (
    <button className={mode === m ? "on" : ""} onMouseDown={keep} onClick={() => setMode(m)} title={title} aria-label={title} aria-pressed={mode === m}>
      {icon}
    </button>
  );

  return (
    <div className="scratchpad">
      <div className="scratch-bar" role="toolbar" aria-label="Scratchpad">
        <div className="scratch-row">
          <div className="seg">
            {modeBtn("select", "Pointer: click text to edit it, drag text to move it", <PointerIcon />)}
            {modeBtn("text", "Type: click anywhere to add text", <span className="scratch-t">T</span>)}
            {modeBtn("draw", "Draw with the mouse, a pen or your finger", "✎")}
            {modeBtn("erase", "Eraser: click or drag over lines and text to remove them", <EraserIcon />)}
          </div>
          <span className="grow" />
          <button className="icon-btn" onMouseDown={keep} onClick={undo} disabled={undos.length === 0} title="Undo the last scratchpad change" aria-label="Undo">
            ↶
          </button>
          <button className="icon-btn" onClick={clear} disabled={empty} title="Clear the scratchpad" aria-label="Clear the scratchpad">
            ✕
          </button>
        </div>
        {mode === "draw" && (
          <div className="scratch-row">
            <label className="scratch-width" title="Line width">
              <span className="sr-only">Line width</span>
              <input
                type="range"
                min={SCRATCH_LIMITS.width.min}
                max={SCRATCH_LIMITS.width.max}
                value={prefs.pen.width}
                onChange={(e) => setPen({ width: Number(e.target.value) })}
              />
              <span className="scratch-num">{prefs.pen.width}px</span>
            </label>
            <ColorPicker value={prefs.pen.color} onChange={(color) => setPen({ color })} align="right" label="Pen colour" />
          </div>
        )}
        {(mode === "text" || (mode === "select" && selected)) && (
          <div className="scratch-row">
            <select
              className="scratch-size"
              value={textStyle.size}
              title="Text size"
              aria-label="Text size"
              onChange={(e) => setTextStyle({ size: Number(e.target.value) })}
            >
              {[...new Set([...FONT_SIZES, textStyle.size])].sort((a, b) => a - b).map((s) => (
                <option key={s} value={s}>
                  {s}px
                </option>
              ))}
            </select>
            <div className="seg">
              <button className={textStyle.bold ? "on" : ""} onMouseDown={keep} onClick={() => setTextStyle({ bold: !textStyle.bold })} title="Bold" aria-label="Bold" aria-pressed={textStyle.bold}>
                <b>B</b>
              </button>
              <button className={textStyle.italic ? "on" : ""} onMouseDown={keep} onClick={() => setTextStyle({ italic: !textStyle.italic })} title="Italic" aria-label="Italic" aria-pressed={textStyle.italic}>
                <i>I</i>
              </button>
            </div>
            <span className="grow" />
            <ColorPicker value={textStyle.color} onChange={(color) => setTextStyle({ color })} align="right" label="Text colour" />
          </div>
        )}
      </div>
      <div
        ref={surface}
        className={`scratch-surface mode-${mode}`}
        style={{ minHeight: `max(calc(100vh - 170px), ${bottom + 120}px)`, cursor: mode === "draw" ? penCursor(prefs.pen) : mode === "erase" ? ERASER_CURSOR : undefined }}
        onPointerDown={onPointerDown}
        onClick={onClick}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {empty && !live && (
          <div className="scratch-hint muted">
            {mode === "draw" ? "Draw anywhere" : mode === "erase" ? "Nothing to erase" : mode === "text" ? "Click anywhere to type" : "Pick T to type or ✎ to draw"}
          </div>
        )}
        <svg className="scratch-ink">
          {data.strokes.map((s) => (
            <g key={s.id}>
              <polyline points={line(s.points)} className="ink" stroke={s.color ?? "#000000"} strokeWidth={s.width ?? 2} />
              {mode === "erase" && <polyline points={line(s.points)} className="ink-hit" strokeWidth={Math.max(14, (s.width ?? 2) + 8)} data-scratch={s.id} />}
            </g>
          ))}
          {live && <polyline points={line(live.length === 2 ? [...live, live[0] + 1, live[1]] : live)} className="ink" stroke={prefs.pen.color} strokeWidth={prefs.pen.width} />}
        </svg>
        {data.texts.map((t) => {
          const st = styleOf(t);
          return (
            <div
              key={t.id}
              data-id={t.id}
              className={`scratch-note ${t.id === selectedId ? "selected" : ""}`}
              style={{ left: t.x, top: t.y }}
              data-scratch={mode === "erase" ? t.id : undefined}
            >
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
                readOnly={mode === "draw" || mode === "erase"}
                tabIndex={mode === "draw" || mode === "erase" ? -1 : 0}
                autoFocus={t.id === focusId}
                aria-label="Scratchpad text"
                style={{ fontSize: st.size, fontWeight: st.bold ? 700 : 400, fontStyle: st.italic ? "italic" : "normal", color: st.color }}
                onFocus={() => setSelectedId(t.id)}
                onChange={(e) => setText(t.id, e.target.value)}
                onBlur={() => leaveText(t.id)}
                onKeyDown={(e) => e.key === "Escape" && (e.target as HTMLTextAreaElement).blur()}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
