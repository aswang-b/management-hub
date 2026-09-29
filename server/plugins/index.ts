// The list of plugins the hub offers. To add a service, create a file next
// to this one that exports a `Plugin` and add it here.
import type { PluginMeta, PluginResult } from "../../shared/types.ts";
import type { MetricPoint } from "../../shared/metrics.ts";
import { PluginError, type Plugin, type PluginContext } from "./framework.ts";
import { github } from "./github.ts";
import { supabase } from "./supabase.ts";
import { netlify } from "./netlify.ts";
import { cloudflare } from "./cloudflare.ts";
import { vercel } from "./vercel.ts";
import { resend } from "./resend.ts";
import { google } from "./google.ts";
import { status } from "./status.ts";

export const plugins: Plugin[] = [github, supabase, netlify, vercel, cloudflare, resend, google, status];

export const getPlugin = (id: string) => plugins.find((p) => p.id === id);

export function pluginMeta(p: Plugin): PluginMeta {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    env: p.env.map((e) => ({ ...e, set: Boolean(process.env[e.key]?.trim()) })),
    configFields: p.configFields,
  };
}

function context(config: Record<string, unknown>): PluginContext {
  const cfg: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) if (v !== undefined && v !== null) cfg[k] = String(v);
  return {
    config: cfg,
    secret(key) {
      const v = process.env[key]?.trim();
      if (!v) throw new PluginError("setup", `This plugin needs ${key}. Press "Add token" to add it; the steps to get one are shown there.`);
      return v;
    },
  };
}

function describe(e: unknown): Pick<PluginResult, "error" | "errorKind"> {
  if (e instanceof PluginError) return { error: e.message, errorKind: e.kind };
  // Plain errors thrown by plugins are setup problems ("Set the repository...").
  return { error: (e as Error)?.message ?? String(e), errorKind: "setup" };
}

// Results are cached briefly so reloading the page doesn't hit rate limits.
const cache = new Map<string, { at: number; result: PluginResult }>();
const CACHE_MS = 60_000;

/** Forgets cached tiles, e.g. after a token changes. */
export const clearCache = () => cache.clear();

/** Every token name any plugin uses: the only .env keys the page may set. */
export const tokenKeys = () => new Set(plugins.flatMap((p) => p.env.map((e) => e.key)));

export async function runLoad(p: Plugin, toolId: string, config: Record<string, unknown>, fresh = false): Promise<PluginResult> {
  const key = `${toolId}:${JSON.stringify(config)}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const portalUrl = p.portalUrl(context(config).config);
  let result: PluginResult;
  try {
    result = { ok: true, view: await p.load(context(config)), portalUrl, fetchedAt: new Date().toISOString() };
  } catch (e) {
    result = { ok: false, ...describe(e), portalUrl, fetchedAt: new Date().toISOString() };
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** Runs a plugin's `collect` for one tile. Never throws: failures come back as `error`. */
export async function runCollect(p: Plugin, config: Record<string, unknown>): Promise<{ ok: boolean; points: MetricPoint[]; error?: string }> {
  if (!p.collect) return { ok: true, points: [] };
  try {
    return { ok: true, points: await p.collect(context(config)) };
  } catch (e) {
    return { ok: false, points: [], error: describe(e).error };
  }
}

export async function runAction(p: Plugin, toolId: string, config: Record<string, unknown>, action: string, args: Record<string, unknown>) {
  const fn = p.actions[action];
  if (!fn) return { ok: false, error: `${p.name} has no action "${action}".` };
  try {
    const message = await fn(context(config), args ?? {});
    for (const k of cache.keys()) if (k.startsWith(`${toolId}:`)) cache.delete(k);
    return { ok: true, message };
  } catch (e) {
    return { ok: false, ...describe(e) };
  }
}
