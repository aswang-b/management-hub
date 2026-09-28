// The setup form shown when a tool is added, or when its ⚙ is pressed in
// builder mode. Fields come from the tool's definition.
import { useState } from "react";
import type { Tool } from "../../../shared/types.ts";
import type { ToolDef } from "../tools/registry.tsx";
import { Modal } from "./Modal.tsx";

export function ToolSettings({
  def,
  tool,
  onSave,
  onClose,
}: {
  def: ToolDef;
  tool: Tool;
  onSave: (config: Tool["config"]) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(def.configFields.map((f) => [f.key, tool.config[f.key] == null ? "" : String(tool.config[f.key])])),
  );
  const missing = def.env?.filter((e) => !e.set) ?? [];

  return (
    <Modal title={`${def.name} settings`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const config: Tool["config"] = {};
          for (const f of def.configFields) {
            const v = values[f.key]?.trim();
            if (v) config[f.key] = f.type === "number" ? Number(v) : v;
          }
          onSave(config);
        }}
      >
        <p className="muted">{def.description}</p>
        {def.env && def.env.length > 0 && (
          <div className="env-list">
            {def.env.map((e) => (
              <div key={e.key} className={e.set ? "" : "env-missing"}>
                {e.set ? "✓" : "✕"} <code>{e.key}</code> {e.set ? "is set" : "is missing from .env"}
                {!e.set && <small>{e.help}</small>}
              </div>
            ))}
            {missing.length > 0 && <small>Add tokens to the .env file in the hub's folder, then restart the hub.</small>}
          </div>
        )}
        {def.configFields.map((f) => (
          <label key={f.key} className="field">
            <span>
              {f.label}
              {f.required && " *"}
            </span>
            <input
              type={f.type === "number" ? "number" : "text"}
              value={values[f.key] ?? ""}
              placeholder={f.placeholder}
              required={f.required}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
            {f.help && <small>{f.help}</small>}
          </label>
        ))}
        <div className="form-actions">
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
