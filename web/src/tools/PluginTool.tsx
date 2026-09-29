// Plugin tool: draws the "view" a server-side plugin returns. Every plugin
// uses this same component, so plugins only need server code.
import { useCallback, useEffect, useState } from "react";
import type { PluginAction, PluginMeta, PluginResult, Tone, Tool } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { TOKENS_CHANGED, TokensDialog } from "../components/Tokens.tsx";

const REFRESH_MS = 5 * 60_000;

export function ToneMark({ tone }: { tone?: Tone }) {
  const glyph = { ok: "●", warn: "▲", bad: "■", pending: "◐", neutral: "○" }[tone ?? "neutral"];
  return <span className={`tone tone-${tone ?? "neutral"}`}>{glyph}</span>;
}

export function PluginTool({ tool, name, env }: { tool: Tool; name: string; env: PluginMeta["env"] }) {
  const [result, setResult] = useState<PluginResult>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [toast, setToast] = useState<{ text: string; bad?: boolean }>();
  const [showTokens, setShowTokens] = useState(false);

  const load = useCallback(
    async (fresh = false) => {
      setLoading(true);
      try {
        setResult(await api.pluginView(tool.id, fresh));
      } catch (e) {
        setResult({ ok: false, error: (e as Error).message, errorKind: "network", fetchedAt: new Date().toISOString() });
      } finally {
        setLoading(false);
      }
    },
    [tool.id],
  );

  // Reload when the tile's settings change, and every few minutes.
  const configKey = JSON.stringify(tool.config);
  useEffect(() => {
    load();
    const t = setInterval(() => load(true), REFRESH_MS);
    const onTokens = () => load(true);
    window.addEventListener(TOKENS_CHANGED, onTokens);
    return () => {
      clearInterval(t);
      window.removeEventListener(TOKENS_CHANGED, onTokens);
    };
  }, [load, configKey]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  async function run(a: PluginAction) {
    if (a.confirm && !confirm(a.confirm)) return;
    const key = `${a.id}:${JSON.stringify(a.args ?? {})}`;
    setBusy(key);
    try {
      const r = await api.pluginAction(tool.id, a.id, a.args);
      setToast(r.ok ? { text: r.message ?? "Done." } : { text: r.error ?? "Failed.", bad: true });
      if (r.ok) setTimeout(() => load(true), 1500);
    } catch (e) {
      setToast({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(undefined);
    }
  }

  const button = (a: PluginAction, small = false) => {
    const key = `${a.id}:${JSON.stringify(a.args ?? {})}`;
    return (
      <button key={key} className={`btn ${small ? "btn-small" : ""}`} disabled={busy !== undefined} onClick={() => run(a)}>
        {busy === key ? "…" : a.label}
      </button>
    );
  };

  const view = result?.view;
  // A missing token, or one the service turned down, can be fixed right here.
  const tokenFix =
    result && !result.ok && env.length > 0
      ? result.errorKind === "auth"
        ? "Change token"
        : result.errorKind === "setup" && env.some((e) => !e.set)
          ? "Add token"
          : undefined
      : undefined;
  return (
    <div className="plugin">
      <div className="plugin-head">
        <span className="plugin-name">{name}</span>
        {view?.status && (
          <span className={`plugin-status tone-bg-${view.status.tone}`}>
            <ToneMark tone={view.status.tone} /> {view.status.label}
          </span>
        )}
        <span className="grow" />
        <button className="icon-btn" title="Refresh" onClick={() => load(true)} disabled={loading}>
          {loading ? "…" : "↻"}
        </button>
        {result?.portalUrl && (
          <a className="icon-btn" href={result.portalUrl} target="_blank" rel="noreferrer" title={`Open ${name}`}>
            ↗
          </a>
        )}
      </div>

      <div className="plugin-body">
        {!result && <div className="muted">Loading…</div>}

        {result && !result.ok && (
          <div className={`plugin-error kind-${result.errorKind}`}>
            <strong>{errorTitle(result.errorKind)}</strong>
            <p>{result.error}</p>
            {tokenFix && (
              <button className="btn btn-small" onClick={() => setShowTokens(true)}>
                {tokenFix}
              </button>
            )}
          </div>
        )}

        {view?.notice && <div className="plugin-notice">{view.notice}</div>}

        {view?.stats && view.stats.length > 0 && (
          <div className="stats">
            {view.stats.map((s) => (
              <div key={s.label} className={`stat tone-text-${s.tone ?? "neutral"}`}>
                <div className="stat-label">{s.label}</div>
                <div className="stat-value">
                  {s.tone && s.tone !== "neutral" && s.tone !== "ok" && <ToneMark tone={s.tone} />} {s.value}
                </div>
                {s.limit && (
                  <div className="meter">
                    <div style={{ width: `${Math.min(100, (s.limit.used / s.limit.max) * 100)}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {view?.actions && view.actions.length > 0 && <div className="plugin-actions">{view.actions.map((a) => button(a))}</div>}

        {view?.sections?.map((sec) => (
          <div key={sec.title} className="plugin-section">
            <div className="section-title">{sec.title}</div>
            {sec.items.length === 0 && <div className="muted">{sec.empty ?? "Nothing here."}</div>}
            {sec.items.map((it, i) => (
              <div key={i} className={`item tone-text-${it.tone ?? "neutral"}`}>
                <ToneMark tone={it.tone} />
                <div className="item-text">
                  {it.url ? (
                    <a href={it.url} target="_blank" rel="noreferrer" className="item-title">
                      {it.title}
                    </a>
                  ) : (
                    <span className="item-title">{it.title}</span>
                  )}
                  {it.subtitle && <span className="item-sub">{it.subtitle}</span>}
                </div>
                {it.actions?.map((a) => button(a, true))}
              </div>
            ))}
          </div>
        ))}

        {view?.links && view.links.length > 0 && (
          <div className="plugin-links">
            {view.links.map((l) => (
              <a key={l.label} href={l.url} target="_blank" rel="noreferrer">
                {l.label} ↗
              </a>
            ))}
          </div>
        )}
      </div>

      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`}>{toast.text}</div>}
      {showTokens && (
        <TokensDialog
          title={`${name} token`}
          plugins={[{ id: tool.type, name, description: "", env, configFields: [] }]}
          onClose={() => setShowTokens(false)}
        />
      )}
    </div>
  );
}

function errorTitle(kind: PluginResult["errorKind"]) {
  switch (kind) {
    case "setup":
      return "Needs setup";
    case "auth":
      return "Login problem";
    case "not-found":
      return "Not found";
    case "changed":
      return "Plugin needs an update";
    case "network":
      return "Can't connect";
    default:
      return "Something went wrong";
  }
}
