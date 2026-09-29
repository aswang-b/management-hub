// The setup form shown when a tool is added, or when its ⚙ is pressed in
// builder mode. Fields come from the tool's definition.
import { useCallback, useEffect, useState } from "react";
import type { PluginConfigField, Tool } from "../../../shared/types.ts";
import type { ToolDef } from "../tools/registry.tsx";
import { Modal } from "./Modal.tsx";
import { TokenList } from "./Tokens.tsx";

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
    Object.fromEntries(
      def.configFields.map((f) => [f.key, tool.config[f.key] == null ? (f.type === "select" && f.placeholder) || "" : String(tool.config[f.key])]),
    ),
  );

  // Some tools load their choices (e.g. which metrics exist) when the form opens.
  const [extra, setExtra] = useState<{ options?: Record<string, NonNullable<PluginConfigField["options"]>>; note?: string }>({});
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => def.loadSettings?.().then(setExtra).catch((e) => setExtra({ note: (e as Error).message })), [def]);
  useEffect(() => {
    reload();
  }, [reload]);

  async function runExtra() {
    if (!def.settingsAction) return;
    setBusy(true);
    try {
      const message = await def.settingsAction.run();
      await reload();
      setExtra((x) => ({ ...x, note: message }));
    } catch (e) {
      setExtra((x) => ({ ...x, note: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  const input = (f: PluginConfigField) => {
    const value = values[f.key] ?? "";
    const set = (v: string) => setValues({ ...values, [f.key]: v });
    if (f.type !== "select") {
      return (
        <input type={f.type === "number" ? "number" : "text"} value={value} placeholder={f.placeholder} required={f.required} onChange={(e) => set(e.target.value)} />
      );
    }
    const options = extra.options?.[f.key] ?? f.options ?? [];
    return (
      <select value={value} required={f.required} onChange={(e) => set(e.target.value)}>
        {(f.required || !options.length) && <option value="">{options.length ? "Choose…" : "Nothing to choose yet"}</option>}
        {value && !options.some((o) => o.value === value) && <option value={value}>{value} (no data)</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  };

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
        {def.env && <TokenList entries={def.env.map((e) => ({ ...e, plugin: def.name }))} />}
        {def.configFields.map((f) => (
          <label key={f.key} className="field">
            <span>
              {f.label}
              {f.required && " *"}
            </span>
            {input(f)}
            {f.help && <small>{f.help}</small>}
          </label>
        ))}
        {(extra.note || def.settingsAction) && (
          <div className="settings-extra">
            {extra.note && <small>{extra.note}</small>}
            {def.settingsAction && (
              <button type="button" className="btn btn-small" disabled={busy} onClick={runExtra}>
                {busy ? "Working…" : def.settingsAction.label}
              </button>
            )}
          </div>
        )}
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
