// Tests for saving plugin tokens into .env from the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveToken, setEnvLine, tokenProblem } from "./secrets.ts";
import { tokenKeys } from "./plugins/index.ts";

const example = "# GitHub token\r\nGITHUB_TOKEN=\r\n\r\n# Port\r\nHUB_PORT=8787\r\n";

test("replaces a token's line and keeps comments, other settings and line endings", () => {
  const out = setEnvLine(example, "GITHUB_TOKEN", "github_pat_abc");
  assert.equal(out, "# GitHub token\r\nGITHUB_TOKEN=github_pat_abc\r\n\r\n# Port\r\nHUB_PORT=8787\r\n");
});

test("adds a token that isn't in the file yet", () => {
  assert.equal(setEnvLine("HUB_PORT=8787\n", "RESEND_API_KEY", "re_1"), "HUB_PORT=8787\nRESEND_API_KEY=re_1\n");
  assert.equal(setEnvLine("", "RESEND_API_KEY", "re_1"), "RESEND_API_KEY=re_1\n");
});

test("an empty value removes the token", () => {
  const out = setEnvLine("RESEND_API_KEY=re_1\n", "RESEND_API_KEY", "");
  assert.equal(out, "RESEND_API_KEY=\n");
});

test("pasted text with spaces or odd characters is refused", () => {
  assert.match(tokenProblem("re_1 re_2")!, /without spaces/);
  assert.match(tokenProblem("abc\nHUB_ALLOWED_HOSTS=evil.com")!, /without spaces or line breaks/);
  assert.match(tokenProblem("abc#comment")!, /doesn't look like a token/);
  assert.equal(tokenProblem("github_pat_11AB-cd.ef/gh+ij="), undefined);
});

test("saving writes .env and works without a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "hub-")), ".env");
  writeFileSync(file, example);
  saveToken("GITHUB_TOKEN", "  github_pat_xyz  ", file);
  assert.match(readFileSync(file, "utf8"), /^GITHUB_TOKEN=github_pat_xyz\r$/m);
  assert.equal(process.env.GITHUB_TOKEN, "github_pat_xyz");
  saveToken("GITHUB_TOKEN", "", file);
  assert.equal(process.env.GITHUB_TOKEN, undefined);
  assert.throws(() => saveToken("GITHUB_TOKEN", "two words", file), /without spaces/);
});

test("only the plugins' own token names can be set", () => {
  const keys = tokenKeys();
  assert.ok(keys.has("GITHUB_TOKEN") && keys.has("RESEND_API_KEY"));
  assert.ok(!keys.has("HUB_ALLOWED_HOSTS") && !keys.has("HUB_PORT") && !keys.has("NODE_OPTIONS"));
});
