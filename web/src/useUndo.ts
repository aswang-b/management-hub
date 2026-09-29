// Undo, Redo and Revert for builder mode. Before each change (adding, moving,
// resizing, removing or re-configuring a tool, or changing project settings)
// the page records a snapshot of the project. Undo and Redo step through
// those snapshots; Revert returns to how the project was when Build was
// pressed. A new building session, or another project, starts fresh.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Project, Tool } from "../../shared/types.ts";
import { api } from "./api.ts";

export interface Snapshot {
  name: string;
  gridWidth: number;
  tools: Tool[];
}

export function useUndo(
  project: Project | undefined,
  building: boolean,
  /** The workspace's tools right now (undefined while they're loading). */
  tools: RefObject<Tool[] | undefined>,
  onRestored: (p: Project) => void,
) {
  const [start, setStart] = useState<Snapshot>();
  const [undos, setUndos] = useState<Snapshot[]>([]);
  const [redos, setRedos] = useState<Snapshot[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStart(undefined);
    setUndos([]);
    setRedos([]);
  }, [building, project?.id]);

  const now = useCallback((): Snapshot | undefined => {
    const t = tools.current;
    return project && t ? { name: project.name, gridWidth: project.gridWidth, tools: t } : undefined;
  }, [project, tools]);

  /** Call just before a change. */
  const checkpoint = useCallback(() => {
    const s = now();
    if (!s) return;
    setStart((x) => x ?? s);
    setUndos((u) => [...u, s]);
    setRedos([]);
  }, [now]);

  const restore = useCallback(
    async (to: Snapshot, after: (current: Snapshot) => void) => {
      const current = now();
      if (!project || !current || busy) return;
      setBusy(true);
      try {
        onRestored(await api.restoreProject(project.id, to));
        after(current);
      } catch (e) {
        alert(`Couldn't restore the project: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [now, project, busy, onRestored],
  );

  const undo = () => {
    const prev = undos.at(-1);
    if (prev) restore(prev, (current) => { setUndos((u) => u.slice(0, -1)); setRedos((r) => [...r, current]); });
  };
  const redo = () => {
    const next = redos.at(-1);
    if (next) restore(next, (current) => { setRedos((r) => r.slice(0, -1)); setUndos((u) => [...u, current]); });
  };
  const revert = () => {
    if (!start) return;
    if (!confirm("Undo every change to this project since you pressed Build?")) return;
    // Reverting can itself be undone.
    restore(start, (current) => { setUndos((u) => [...u, current]); setRedos([]); });
  };

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) in builder mode, except while typing.
  const keys = useRef({ undo, redo });
  keys.current = { undo, redo };
  useEffect(() => {
    if (!building) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true], .modal")) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) keys.current.undo();
      else if (k === "y" || (k === "z" && e.shiftKey)) keys.current.redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [building]);

  return {
    checkpoint,
    undo,
    redo,
    revert,
    canUndo: undos.length > 0 && !busy,
    canRedo: redos.length > 0 && !busy,
    canRevert: Boolean(start) && !busy,
  };
}
