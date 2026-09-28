// Builder mode's tool list. Drag a size onto the grid, or click it to drop
// the tool in the first free space.
import type { ToolDef, Size } from "../tools/registry.tsx";

export let dragging: { def: ToolDef; size: Size } | undefined;

const GROUPS: { category: ToolDef["category"]; title: string }[] = [
  { category: "link", title: "Links" },
  { category: "module", title: "Modules" },
  { category: "plugin", title: "Plugins" },
];

export function SizeShape({ size }: { size: Size }) {
  return (
    <span className="size-shape" style={{ gridTemplateColumns: `repeat(${size.w}, 7px)`, gridTemplateRows: `repeat(${size.h}, 7px)` }}>
      {Array.from({ length: size.w * size.h }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

export function Palette({ registry, onAdd }: { registry: ToolDef[]; onAdd: (def: ToolDef, size: Size) => void }) {
  return (
    <aside className="palette">
      <div className="palette-hint">Drag a size onto the grid, or click it to add.</div>
      {GROUPS.map((g) => (
        <section key={g.category}>
          <h3>{g.title}</h3>
          {registry
            .filter((d) => d.category === g.category)
            .map((def) => (
              <div key={def.key} className="palette-item">
                <div className="palette-name" title={def.description}>
                  {def.name}
                  {def.env?.some((e) => !e.set) && (
                    <span className="palette-flag" title="Token missing from .env">
                      needs token
                    </span>
                  )}
                </div>
                <div className="palette-sizes">
                  {def.sizes.map((size) => (
                    <button
                      key={`${size.w}x${size.h}`}
                      className="size-btn droppable-element"
                      title={`Add ${def.name}, ${size.label}`}
                      draggable
                      unselectable="on"
                      onDragStart={(e) => {
                        dragging = { def, size };
                        e.dataTransfer.setData("text/plain", def.key);
                      }}
                      onDragEnd={() => (dragging = undefined)}
                      onClick={() => onAdd(def, size)}
                    >
                      <SizeShape size={size} />
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </section>
      ))}
    </aside>
  );
}
