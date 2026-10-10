// A colour picker: a button showing the colour, opening a gradient square
// (lighter/darker, more/less colourful) and a rainbow bar for the hue, plus a
// hex box and black/white shortcuts.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Hsv = { h: number; s: number; v: number };

export function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return "#" + [f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, "0")).join("");
}

export function ColorPicker({
  value,
  onChange,
  align = "left",
  label = "Colour",
}: {
  value: string;
  onChange: (hex: string) => void;
  /** Which edge of the button the panel lines up with. */
  align?: "left" | "right";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  // Hue is kept separately so it survives picking black, white or grey.
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hex, setHex] = useState(value);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHex(value);
    if (hsvToHex(hsv) !== value.toLowerCase()) setHsv((old) => ({ ...hexToHsv(value), h: hexToHsv(value).s ? hexToHsv(value).h : old.h }));
  }, [value]);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const set = (next: Hsv) => {
    setHsv(next);
    onChange(hsvToHex(next));
  };

  // Dragging on the square or the bar.
  const drag = (pick: (fx: number, fy: number) => void) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      pick(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <div className="color-picker" ref={box}>
      <button
        type="button"
        className="color-swatch"
        style={{ background: value }}
        title={label}
        aria-label={`${label}: ${value}`}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div className={`color-panel color-panel-${align}`} role="dialog" aria-label={label}>
          <div
            className="color-sv"
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex({ h: hsv.h, s: 1, v: 1 })})` }}
            onPointerDown={drag((fx, fy) => set({ h: hsv.h, s: fx, v: 1 - fy }))}
          >
            <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
          </div>
          <div className="color-hue" onPointerDown={drag((fx) => set({ ...hsv, h: fx * 359.9 }))}>
            <i style={{ left: `${(hsv.h / 360) * 100}%` }} />
          </div>
          <div className="color-row">
            <button type="button" className="color-swatch small" style={{ background: "#000000" }} aria-label="Black" onClick={() => set({ ...hsv, s: 0, v: 0 })} />
            <button type="button" className="color-swatch small" style={{ background: "#ffffff" }} aria-label="White" onClick={() => set({ ...hsv, s: 0, v: 1 })} />
            <input
              className="color-hex"
              value={hex}
              aria-label="Hex colour"
              spellCheck={false}
              onChange={(e) => {
                setHex(e.target.value);
                if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value.toLowerCase());
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
