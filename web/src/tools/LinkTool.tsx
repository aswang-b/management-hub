// Link tool: shows the destination's favicon (and its name when wide) and
// opens it. Local file paths open with this computer's default app.
import { useState } from "react";
import type { Tool } from "../../../shared/types.ts";
import { api } from "../api.ts";

export function isLocal(url: string) {
  return /^file:\/\//i.test(url) || /^[a-zA-Z]:[\\/]/.test(url) || url.startsWith("/") || url.startsWith("~");
}

export function LinkTool({ tool }: { tool: Tool }) {
  const url = String(tool.config.url ?? "");
  const title = String(tool.config.title || tool.data.siteTitle || hostOf(url));
  const [iconFailed, setIconFailed] = useState(false);
  const local = isLocal(url);
  const wide = tool.w > 1;

  if (!url) return <div className="link-tool empty">Set a link in builder mode</div>;

  const icon =
    local || iconFailed ? (
      <span className="link-letter">{local ? "▤" : title.charAt(0).toUpperCase()}</span>
    ) : (
      <img className="link-icon" src={`/api/favicon?url=${encodeURIComponent(url)}`} alt="" onError={() => setIconFailed(true)} />
    );

  const content = (
    <>
      {icon}
      {wide && <span className="link-title">{title}</span>}
    </>
  );

  if (local) {
    return (
      <button
        className={`link-tool ${wide ? "wide" : ""}`}
        title={url}
        onClick={async () => {
          const r = await api.openLocal(url).catch((e) => ({ ok: false, error: e.message }));
          if (!r.ok) alert(r.error);
        }}
      >
        {content}
      </button>
    );
  }
  return (
    <a className={`link-tool ${wide ? "wide" : ""}`} href={url} target="_blank" rel="noreferrer" title={`${title}\n${url}`}>
      {content}
    </a>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.split(/[\\/]/).filter(Boolean).pop() ?? url;
  }
}
