import { useState } from "react";
import { GRID_WIDTH, SIDE_GRID_WIDTH, SIDE_ZONES, type Project, type Sides } from "../../../shared/types.ts";
import { Modal } from "./Modal.tsx";

export function ProjectSettings({
  project,
  onSave,
  onDelete,
  onClose,
}: {
  project: Project;
  onSave: (patch: { name: string; gridWidth: number; sides: Sides }) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [gridWidth, setGridWidth] = useState(project.gridWidth);
  const [sides, setSides] = useState(project.sides);
  return (
    <Modal title="Project settings" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ name, gridWidth, sides });
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        <label className="field">
          <span>
            Grid width: <strong>{gridWidth}</strong> squares
          </span>
          <input
            type="range"
            min={GRID_WIDTH.min}
            max={GRID_WIDTH.max}
            value={gridWidth}
            onChange={(e) => setGridWidth(Number(e.target.value))}
          />
          <small>
            More squares make every tool smaller. Between {GRID_WIDTH.min} and {GRID_WIDTH.max}. Tools that no longer fit move left.
          </small>
        </label>
        {SIDE_ZONES.map((s) => (
          <label className="field" key={s}>
            <span>
              {s === "left" ? "Left" : "Right"} side grid width: <strong>{sides[s].gridWidth}</strong> square{sides[s].gridWidth === 1 ? "" : "s"}
            </span>
            <input
              type="range"
              min={SIDE_GRID_WIDTH.min}
              max={SIDE_GRID_WIDTH.max}
              value={sides[s].gridWidth}
              onChange={(e) => setSides({ ...sides, [s]: { ...sides[s], gridWidth: Number(e.target.value) } })}
            />
            {s === "right" && (
              <small>
                Used when a side is set to Grid (the switch above it in builder mode). Between {SIDE_GRID_WIDTH.min} and{" "}
                {SIDE_GRID_WIDTH.max}. Tools that no longer fit move left.
              </small>
            )}
          </label>
        ))}
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => confirm(`Delete "${project.name}" and all its tools? This can't be undone.`) && onDelete()}
          >
            Delete project
          </button>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
