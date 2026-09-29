// The plugin framework. Each service (GitHub, Netlify, ...) is one file in
// this folder that exports a `Plugin`. The server calls `load` to draw the
// tile and `actions[...]` when a button is pressed.
//
// When a service changes its API, only that service's file needs updating.
// `npm run check-plugins` runs every configured plugin and reports which
// ones fail, so a broken plugin is easy to find.

import type { EnvVar, PluginConfigField, PluginResult, PluginView } from "../../shared/types.ts";
import type { MetricPoint } from "../../shared/metrics.ts";

export interface PluginContext {
  /** Settings entered in builder mode for this tile. */
  config: Record<string, string>;
  /** Reads a token from .env. Throws a setup error if it is missing. */
  secret(key: string): string;
}

export interface Plugin {
  id: string;
  name: string;
  description: string;
  /** Link to the service's own website for this tile. */
  portalUrl(config: Record<string, string>): string;
  /** Tokens this plugin needs from .env, with steps shown in the hub for getting them. */
  env: EnvVar[];
  configFields: PluginConfigField[];
  load(ctx: PluginContext): Promise<PluginView>;
  actions: Record<string, (ctx: PluginContext, args: Record<string, unknown>) => Promise<string>>;
  /**
   * Optional: numbers to save for the analytics module. The hub calls this
   * every hour for each tile of this plugin. Give a limit as a second metric
   * named `<metric>.limit` and analytics tiles show a gauge by themselves.
   */
  collect?(ctx: PluginContext): Promise<MetricPoint[]>;
}

// ---- Errors that plugins raise, turned into plain-language messages.

export class PluginError extends Error {
  constructor(public kind: NonNullable<PluginResult["errorKind"]>, message: string) {
    super(message);
  }
}

/** Throw when a response doesn't look the way the plugin expects. */
export function expectShape(ok: unknown, service: string, what: string): asserts ok {
  if (!ok) {
    throw new PluginError(
      "changed",
      `${service} sent back an unexpected response (${what}). The service may have changed its API, so this plugin needs an update.`,
    );
  }
}

// ---- HTTP helper

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Service name used in error messages. */
  service: string;
  /** .env key of the token, used in error messages. */
  tokenKey?: string;
  /** Status codes that should return null instead of throwing. */
  allow?: number[];
  /** Return the response body as text instead of parsing it as JSON (e.g. JSON Lines). */
  text?: boolean;
}

export async function request<T = any>(url: string, opts: RequestOptions): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        "User-Agent": "management-hub",
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new PluginError("network", `Couldn't reach ${opts.service}. Check your internet connection. (${(e as Error).message})`);
  }

  if (opts.allow?.includes(res.status)) return null as T;

  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }

  if (!res.ok) {
    const detail = String(json?.message ?? json?.errors?.[0]?.message ?? json?.error ?? text).slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new PluginError(
        "auth",
        `${opts.service} refused the request (${res.status}).` +
          (opts.tokenKey ? ` The token (${opts.tokenKey}) may be wrong, expired or missing a permission: press "Change token" to replace it.` : "") +
          (detail ? ` ${opts.service} said: ${detail}` : ""),
      );
    }
    if (res.status === 404) {
      throw new PluginError("not-found", `${opts.service} couldn't find that (404). Check this tile's settings. ${detail}`.trim());
    }
    throw new PluginError("other", `${opts.service} returned an error (${res.status}). ${detail}`.trim());
  }

  if (opts.text) return text as T;
  if (text && json === undefined) {
    throw new PluginError("changed", `${opts.service} sent back something that isn't JSON. This plugin may need an update.`);
  }
  return json as T;
}

// ---- Small formatting helpers shared by plugins

export function ago(iso: string | number | undefined): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function bytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  // Decimal units (1 GB = 1000 MB), as the services' own dashboards use.
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function num(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** Runs a loader that is allowed to fail, returning undefined instead. */
export async function optional<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}
