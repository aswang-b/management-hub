import { useState } from "react";
import { GRID_WIDTH, type Project } from "../../../shared/types.ts";
import { Modal } from "./Modal.tsx";

export function ProjectSettings({
  project,
  onSave,
  onDelete,
  onClose,
}: {
  project: Project;
  onSave: (patch: { name: string; gridWidth: number }) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [gridWidth, setGridWidth] = useState(project.gridWidth);
  return (
    <Modal title="Project settings" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ name, gridWidth });
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
