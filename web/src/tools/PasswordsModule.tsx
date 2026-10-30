// Password manager module: logins with a name, login link, username and a
// password. Passwords are encrypted by the server (server/vault.ts); the page
// only gets one back when you press Show or Copy, and hides it again after
// 30 seconds.
import { useEffect, useState, type FormEvent } from "react";
import type { Tool } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { Modal } from "../components/Modal.tsx";

interface Entry {
  id: string;
  name: string;
  url: string;
  username: string;
  /** Encrypted; only its presence matters here. */
  secret?: string;
}

const HIDE_AFTER = 30_000;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// The clipboard API needs a secure page (localhost or https); the old way
// works on a phone opening the hub over plain http.
async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const box = Object.assign(document.createElement("textarea"), { value: text });
  box.style.position = "fixed";
  box.style.opacity = "0";
  document.body.append(box);
  box.select();
  document.execCommand("copy");
  box.remove();
}

export function PasswordsModule({ tool, onData }: { tool: Tool; onData: (data: Tool["data"]) => void }) {
  const entries = (Array.isArray(tool.data.entries) ? tool.data.entries : []) as Entry[];
  const [shown, setShown] = useState<{ id: string; password: string }>();
  const [editing, setEditing] = useState<Entry | "new">();
  const [filter, setFilter] = useState("");
  const [note, setNote] = useState<string>();
  const label = String(tool.config.label ?? "").trim() || "Passwords";

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(undefined), HIDE_AFTER);
    return () => clearTimeout(t);
  }, [shown]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(undefined), 2500);
    return () => clearTimeout(t);
  }, [note]);

  const reveal = async (e: Entry) => (await api.revealPassword(tool.id, e.id)).password;
  const toggle = async (e: Entry) => {
    if (shown?.id === e.id) return setShown(undefined);
    try {
      setShown({ id: e.id, password: await reveal(e) });
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  const copy = async (what: string, get: () => Promise<string> | string) => {
    try {
      await copyText(await get());
      setNote(`${what} copied`);
    } catch (err) {
      setNote((err as Error).message || "Couldn't copy");
    }
  };
  const remove = (e: Entry) => {
    if (!confirm(`Delete the login "${e.name}"? Its password can't be brought back.`)) return;
    if (shown?.id === e.id) setShown(undefined);
    onData({ ...tool.data, entries: entries.filter((x) => x.id !== e.id) });
  };

  const q = filter.trim().toLowerCase();
  const visible = q ? entries.filter((e) => `${e.name} ${e.username} ${e.url}`.toLowerCase().includes(q)) : entries;

  return (
    <div className="vault">
      <div className="vault-head">
        <span className="vault-label" title={label}>
          {label}
        </span>
        <button className="icon-btn" onClick={() => setEditing("new")} title="Add a login" aria-label="Add a login">
          +
        </button>
      </div>
      {entries.length > 4 && (
        <input className="vault-search" placeholder="Search logins" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search logins" />
      )}
      <div className="vault-list">
        {entries.length === 0 && (
          <button className="vault-empty muted" onClick={() => setEditing("new")}>
            No logins yet. Press + to add one.
          </button>
        )}
        {visible.map((e) => (
          <div className="vault-row" key={e.id}>
            <div className="vault-line">
              {e.url ? (
                <a className="vault-name" href={e.url} target="_blank" rel="noreferrer" title={`Open ${e.url}`}>
                  {e.name} ↗
                </a>
              ) : (
                <span className="vault-name">{e.name}</span>
              )}
              <span className="grow" />
              <button className="icon-btn" onClick={() => setEditing(e)} title="Edit" aria-label={`Edit ${e.name}`}>
                ✎
              </button>
              <button className="icon-btn" onClick={() => remove(e)} title="Delete" aria-label={`Delete ${e.name}`}>
                ✕
              </button>
            </div>
            {e.username && (
              <div className="vault-line">
                <span className="vault-value" title={e.username}>
                  {e.username}
                </span>
                <button className="btn btn-small" onClick={() => copy("Username", () => e.username)}>
                  Copy
                </button>
              </div>
            )}
            {e.secret && (
              <div className="vault-line">
                <span className={`vault-value ${shown?.id === e.id ? "vault-shown" : ""}`}>{shown?.id === e.id ? shown.password : "••••••••"}</span>
                <button className="btn btn-small" onClick={() => toggle(e)} aria-pressed={shown?.id === e.id}>
                  {shown?.id === e.id ? "Hide" : "Show"}
                </button>
                <button className="btn btn-small" onClick={() => copy("Password", () => reveal(e))}>
                  Copy
                </button>
              </div>
            )}
          </div>
        ))}
        {q && visible.length === 0 && <div className="pad muted">No logins match.</div>}
      </div>
      {note && (
        <div className="vault-note" role="status">
          {note}
        </div>
      )}
      {editing && (
        <EntryForm
          entry={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSave={async (fields) => {
            const id = editing === "new" ? newId() : editing.id;
            const saved = await api.savePassword(tool.id, id, fields);
            if (shown?.id === id) setShown(undefined);
            onData(saved.data);
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

function EntryForm({
  entry,
  onClose,
  onSave,
}: {
  entry?: Entry;
  onClose: () => void;
  onSave: (fields: { name: string; url: string; username: string; password?: string }) => Promise<void>;
}) {
  const [name, setName] = useState(entry?.name ?? "");
  const [url, setUrl] = useState(entry?.url ?? "");
  const [username, setUsername] = useState(entry?.username ?? "");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const keeps = Boolean(entry?.secret);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let link = url.trim();
    if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
    setBusy(true);
    try {
      // An empty password box keeps the saved password.
      await onSave({ name, url: link, username, password: password || undefined });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={entry ? `Edit ${entry.name}` : "Add a login"} onClose={onClose}>
      {/* autoComplete="off" so the browser doesn't offer to save these as the hub's own login. */}
      <form onSubmit={submit} autoComplete="off">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bank, Hosting, Email" autoFocus required />
        </label>
        <label className="field">
          <span>Login link</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/login" />
        </label>
        <label className="field">
          <span>Username or email</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>Password</span>
          <span className="vault-pw">
            <input
              type={visible ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={keeps ? "Leave empty to keep the saved password" : ""}
              autoComplete="new-password"
            />
            <button type="button" className="btn btn-small" onClick={() => setVisible((v) => !v)} aria-pressed={visible}>
              {visible ? "Hide" : "Show"}
            </button>
          </span>
          <small>Saved encrypted. Only shown when you press Show or Copy.</small>
        </label>
        {error && <p className="env-missing">{error}</p>}
        <div className="form-actions">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Save
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
