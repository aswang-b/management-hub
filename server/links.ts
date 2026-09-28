// Link tool helpers: look up a site's name and favicon, and open local files.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cacheGet, cacheSet } from "./db.ts";

const DAY = 86400_000;

export function isLocalPath(target: string) {
  return /^file:\/\//i.test(target) || /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("/") || target.startsWith("~");
}

export function toLocalPath(target: string) {
  if (/^file:\/\//i.test(target)) return fileURLToPath(target);
  if (target.startsWith("~")) return (process.env.HOME ?? process.env.USERPROFILE ?? "") + target.slice(1);
  return target;
}

/** Opens a file or folder on this computer with its default app. */
export function openLocal(target: string): { ok: boolean; error?: string } {
  const path = toLocalPath(target);
  if (!existsSync(path)) return { ok: false, error: `Not found on this computer: ${path}` };
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [path]] : process.platform === "win32" ? ["explorer.exe", [path]] : ["xdg-open", [path]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  return { ok: true };
}

async function fetchPage(url: string): Promise<{ html: string; finalUrl: string } | undefined> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (management-hub link preview)", Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return { html: "", finalUrl: res.url || url };
    const html = (await res.text()).slice(0, 300_000);
    return { html, finalUrl: res.url || url };
  } catch {
    return undefined;
  }
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/** The site's display name: og:site_name, else the page title, else the hostname. */
export async function linkInfo(url: string): Promise<{ title: string; iconUrl?: string }> {
  const cached = cacheGet(`info:${url}`, 7 * DAY);
  if (cached) return JSON.parse(String(cached.value));

  const host = new URL(url).hostname.replace(/^www\./, "");
  const page = await fetchPage(url);
  let title = host;
  let iconUrl: string | undefined;
  if (page?.html) {
    const metas = page.html.match(/<meta[^>]+>/gi) ?? [];
    const site = metas.find((m) => /property\s*=\s*["']og:site_name["']/i.test(m));
    const pageTitle = page.html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
    title = decode((site && attr(site, "content")) || pageTitle || host) || host;

    const icons = (page.html.match(/<link[^>]+>/gi) ?? []).filter((l) => /rel\s*=\s*["'][^"']*icon[^"']*["']/i.test(l));
    // Prefer apple-touch-icon (larger), then any icon.
    const best = icons.find((l) => /apple-touch-icon/i.test(l)) ?? icons[0];
    const href = best && attr(best, "href");
    if (href) iconUrl = new URL(decode(href), page.finalUrl).toString();
  }
  if (!iconUrl) iconUrl = new URL("/favicon.ico", page?.finalUrl ?? url).toString();

  const info = { title, iconUrl };
  cacheSet(`info:${url}`, JSON.stringify(info), "json");
  return info;
}

/** The favicon image bytes, cached for a week. */
export async function favicon(url: string): Promise<{ body: Uint8Array; type: string } | undefined> {
  const key = `icon:${url}`;
  const cached = cacheGet(key, 7 * DAY);
  if (cached) return cached.value ? { body: cached.value as Uint8Array, type: cached.type } : undefined;

  const { iconUrl } = await linkInfo(url);
  const candidates = [iconUrl, new URL("/favicon.ico", url).toString()].filter((u, i, a) => u && a.indexOf(u) === i) as string[];
  for (const c of candidates) {
    try {
      const res = await fetch(c, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 (management-hub)" } });
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && (type.startsWith("image/") || /\.(ico|png|svg)$/i.test(c))) {
        const body = new Uint8Array(await res.arrayBuffer());
        if (body.length > 0 && body.length < 1_000_000) {
          const t = type.startsWith("image/") ? type : "image/x-icon";
          cacheSet(key, body, t);
          return { body, type: t };
        }
      }
    } catch {
      /* try next */
    }
  }
  cacheSet(key, null, ""); // remember that there is no icon
  return undefined;
}
