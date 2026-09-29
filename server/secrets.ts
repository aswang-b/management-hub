// Saving plugin tokens from the page. A token is written into the .env file
// (so it survives restarts) and into the running hub (so it works at once).
// Only the plugins' own token names can be set, and a token's value is never
// sent back to the page: the page only learns whether each one is set.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Tokens are one "word": letters, digits and the symbols tokens use.
const TOKEN = /^[A-Za-z0-9_\-.~+/=:]{1,2000}$/;

/**
 * Returns .env text with `key` set to `value` (or blanked when value is
 * empty). Keeps every other line, comments included, and the file's line
 * endings. Adds the line at the end when the key isn't there yet.
 */
export function setEnvLine(text: string, key: string, value: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.split(/\r?\n/) : [];
  const line = `${key}=${value}`;
  const at = lines.findIndex((l) => l.replace(/^\s*export\s+/, "").startsWith(`${key}=`));
  if (at >= 0) lines[at] = line;
  else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  }
  return lines.join(eol);
}

/** Checks a pasted token. Returns a plain-language problem, or undefined if it looks fine. */
export function tokenProblem(value: string): string | undefined {
  if (!value) return undefined; // empty removes the token
  if (/\s/.test(value)) return "A token is one piece of text without spaces or line breaks. Check that you copied only the token.";
  if (!TOKEN.test(value)) return "That doesn't look like a token: it has characters tokens don't use. Check that you copied only the token.";
  return undefined;
}

/** Saves a token to .env and the running hub. */
export function saveToken(key: string, rawValue: string, file = ".env") {
  const value = rawValue.trim();
  const problem = tokenProblem(value);
  if (problem) throw new Error(problem);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, setEnvLine(text, key, value));
  if (value) process.env[key] = value;
  else delete process.env[key];
}
