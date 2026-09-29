// Adding plugin tokens from the page, with the steps for getting each one.
// Tokens are saved into .env by the server and are never shown again: the
// page only knows whether each one is set.
import { useState } from "react";
import type { PluginMeta } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { Modal } from "./Modal.tsx";

/** Fired after a token is saved or removed, so tiles and plugin lists reload. */
export const TOKENS_CHANGED = "hub:tokens-changed";

export type Entry = PluginMeta["env"][number] & { plugin: string };

/** One entry per token, from a list of plugins (a token two plugins share appears once). */
export function tokenEntries(plugins: PluginMeta[]): Entry[] {
  const seen = new Map<string, Entry>();
  for (const p of plugins) for (const e of p.env) if (!seen.has(e.key)) seen.set(e.key, { ...e, plugin: p.name });
  return [...seen.values()];
}

function TokenRow({ entry }: { entry: Entry }) {
  const [value, setValue] = useState("");
  const [saved, setSet] = useState<boolean>();
  const set = saved ?? entry.set;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean }>();

  async function save(v: string) {
    setBusy(true);
    setMessage(undefined);
    try {
      const r = await api.setToken(entry.key, v);
      setSet(r.set);
      setValue("");
      setMessage({ text: r.set ? "Saved. Plugin tiles are reloading with it." : "Removed." });
      window.dispatchEvent(new Event(TOKENS_CHANGED));
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const site = entry.url ? new URL(entry.url).hostname.replace(/^www\./, "") : undefined;
  return (
    <div className={`token ${set ? "" : "token-missing"}`}>
      <div className="token-head">
        <strong>{entry.plugin}</strong>
        <code>{entry.key}</code>
        <span className="grow" />
        <span className="token-state">{set ? "● Saved" : "○ Not set"}</span>
      </div>
      <p className="token-help">{entry.help}</p>
      {entry.steps && (
        <details open={!set}>
          <summary>How to get {set ? "a new" : "this"} token</summary>
          <ol>
            {entry.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {entry.url && (
            <a className="btn btn-small" href={entry.url} target="_blank" rel="noreferrer">
              Open {site} ↗
            </a>
          )}
        </details>
      )}
      <div className="token-input">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={set ? "Paste a new token to replace it" : "Paste the token here"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Inside another form (tile settings), Enter saves the token, not the form.
            if (e.key === "Enter") {
              e.preventDefault();
              if (value.trim()) save(value);
            }
          }}
        />
        <button type="button" className="btn btn-primary" disabled={busy || !value.trim()} onClick={() => save(value)}>
          {busy ? "…" : "Save"}
        </button>
        {set && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => confirm(`Remove the ${entry.plugin} token? Its tiles stop working until you add one again.`) && save("")}
          >
            Remove
          </button>
        )}
      </div>
      {message && <div className={`token-msg ${message.bad ? "bad" : ""}`}>{message.text}</div>}
    </div>
  );
}

export function TokenList({ entries }: { entries: Entry[] }) {
  if (!entries.length) return null;
  return (
    <div className="token-list">
      {entries.map((e) => (
        <TokenRow key={e.key} entry={e} />
      ))}
    </div>
  );
}

export function TokensDialog({ plugins, title = "Tokens", onClose }: { plugins: PluginMeta[]; title?: string; onClose: () => void }) {
  const entries = tokenEntries(plugins);
  return (
    <Modal title={title} onClose={onClose} wide>
      <p className="muted">
        Tokens let the hub read and manage your services for you. Each one is saved in the <code>.env</code> file on this
        computer, is only ever sent to its own service, and isn't shown again after you save it.
      </p>
      <TokenList entries={entries} />
      {!entries.length && <p>No plugin needs a token.</p>}
    </Modal>
  );
}
