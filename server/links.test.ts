// Tests for opening links in the default browser (only the refusals: a valid
// address would really open a browser window).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HUB_DB = ":memory:";
const { openUrl } = await import("./links.ts");

test("only http and https addresses are opened", () => {
  assert.equal(openUrl("not a url").ok, false);
  assert.equal(openUrl("javascript:alert(1)").ok, false);
  assert.equal(openUrl("file:///C:/Windows/System32/calc.exe").ok, false);
  assert.match(openUrl("ftp://example.com").error ?? "", /http/);
});
