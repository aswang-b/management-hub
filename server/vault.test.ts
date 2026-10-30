// Tests for the password manager tile's encrypted passwords.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hub-vault-"));
process.env.HUB_VAULT_KEY_FILE = join(dir, "vault.key");
const { decrypt, encrypt, revealPassword, saveEntry } = await import("./vault.ts");

test("a password is stored encrypted and reads back", () => {
  const data = saveEntry({}, "a1", { name: " Bank ", url: "https://bank.example/login", username: "alex" }, "hunter2!");
  const [entry] = data.entries;
  assert.equal(entry.name, "Bank");
  assert.ok(entry.secret && !entry.secret.includes("hunter2"));
  assert.equal(revealPassword(data, "a1"), "hunter2!");
});

test("the same password encrypts differently each time", () => {
  assert.notEqual(encrypt("same"), encrypt("same"));
});

test("editing an entry without a new password keeps the old one; an empty one removes it", () => {
  let data = saveEntry({}, "a1", { name: "Mail" }, "pw1");
  data = saveEntry(data, "a1", { name: "Mail", username: "me@example.com" });
  assert.equal(data.entries.length, 1);
  assert.equal(revealPassword(data, "a1"), "pw1");
  data = saveEntry(data, "a1", { name: "Mail" }, "");
  assert.equal(data.entries[0].secret, undefined);
  assert.equal(revealPassword(data, "a1"), "");
});

test("a changed or foreign password is refused with a plain message", () => {
  const secret = encrypt("pw");
  const parts = secret.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decrypt(parts.join(":")), /different key file/);
  assert.throws(() => decrypt("plain text"), /format/);
  assert.throws(() => revealPassword({ entries: [] }, "gone"), /isn't in this tile/);
  assert.throws(() => saveEntry({}, "../x", {}), /Bad entry id/);
});

test("without the key file, saved passwords can't be read", () => {
  const secret = encrypt("pw");
  rmSync(process.env.HUB_VAULT_KEY_FILE!);
  assert.throws(() => decrypt(secret), /key file is missing/);
});
