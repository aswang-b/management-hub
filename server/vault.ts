// The password manager tile's passwords. Each one is encrypted (AES-256-GCM)
// before it's saved in the tile's data, so data/hub.db (which OneDrive syncs)
// never holds a readable password. The key is a file outside the project
// folder, so it isn't synced with the database: by default
// %LOCALAPPDATA%\Management Hub\vault.key (HUB_VAULT_KEY_FILE overrides it).
// It's created the first time a password is saved. Without it, saved
// passwords can't be read back: copy it along with hub.db to move the hub.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface VaultEntry {
  id: string;
  name: string;
  /** The login page. */
  url: string;
  username: string;
  /** The encrypted password ("v1:iv:tag:text", base64), or absent when none was saved. */
  secret?: string;
}

const LIMITS = { name: 200, url: 2000, username: 500, password: 1000 };

export function keyFile() {
  if (process.env.HUB_VAULT_KEY_FILE) return process.env.HUB_VAULT_KEY_FILE;
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(base, "Management Hub", "vault.key");
}

function loadKey(create: boolean): Buffer | undefined {
  const file = keyFile();
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    if (key.length !== 32) throw new Error(`The password key file is damaged: ${file}`);
    return key;
  }
  if (!create) return undefined;
  const key = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  return key;
}

export function encrypt(password: string): string {
  const key = loadKey(true)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const text = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), text].map((p) => (typeof p === "string" ? p : p.toString("base64"))).join(":");
}

export function decrypt(secret: string): string {
  const [v, iv, tag, text] = secret.split(":");
  const key = loadKey(false);
  if (v !== "v1" || !iv || !tag || text === undefined) throw new Error("This password is stored in a format the hub doesn't know.");
  if (!key) throw new Error(`The password key file is missing (${keyFile()}), so saved passwords can't be read.`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(text, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("This password was saved with a different key file, so it can't be read.");
  }
}

export const entriesOf = (data: Record<string, unknown>): VaultEntry[] => (Array.isArray(data.entries) ? (data.entries as VaultEntry[]) : []);

/**
 * Adds or changes one entry in a tile's data and returns the new data.
 * `password`: new text to encrypt, "" to remove it, undefined to keep it.
 */
export function saveEntry(data: Record<string, unknown>, id: string, fields: Record<string, unknown>, password?: string) {
  const text = (k: keyof typeof LIMITS) => String(fields[k] ?? "").trim().slice(0, LIMITS[k]);
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error("Bad entry id");
  if (password !== undefined && password.length > LIMITS.password) throw new Error("That password is too long.");
  const entries = entriesOf(data);
  const old = entries.find((e) => e.id === id);
  const entry: VaultEntry = { id, name: text("name") || "Untitled", url: text("url"), username: text("username") };
  const secret = password === undefined ? old?.secret : password ? encrypt(password) : undefined;
  if (secret) entry.secret = secret;
  return { ...data, entries: old ? entries.map((e) => (e.id === id ? entry : e)) : [...entries, entry] };
}

/** The readable password of one entry ("" if it has none). */
export function revealPassword(data: Record<string, unknown>, id: string): string {
  const entry = entriesOf(data).find((e) => e.id === id);
  if (!entry) throw new Error("That login isn't in this tile any more.");
  return entry.secret ? decrypt(entry.secret) : "";
}
