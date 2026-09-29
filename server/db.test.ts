// Tests for restoring a project snapshot (builder mode's Undo, Redo and Revert).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HUB_DB = ":memory:";
const db = await import("./db.ts");

test("restoring brings back removed tools, places and settings, and drops added ones", () => {
  const p = db.createProject("Site");
  const tool = (type: string, x: number, config = {}) =>
    db.createTool({ projectId: p.id, category: "module", type, x, y: 0, w: 1, h: 1, config });
  const a = tool("notes", 0);
  const b = tool("link", 1, { url: "https://a.com" });
  const snap = { name: p.name, gridWidth: p.gridWidth, tools: db.listTools(p.id) };

  // Changes made in builder mode...
  db.updateTool(a.id, { x: 3, data: { text: "typed after the snapshot" } });
  db.updateTool(b.id, { config: { url: "https://b.com" } });
  db.deleteTool(b.id);
  const added = tool("notes", 5);
  db.updateProject(p.id, { name: "Renamed", gridWidth: 8 });

  // ...are undone.
  const back = db.restoreProject(p.id, snap)!;
  assert.equal(back.name, "Site");
  assert.equal(back.gridWidth, p.gridWidth);
  const tools = db.listTools(p.id);
  assert.deepEqual(tools.map((t) => t.id).sort(), [a.id, b.id].sort());
  assert.equal(db.getTool(added.id), undefined);
  assert.equal(db.getTool(a.id)!.x, 0);
  assert.deepEqual(db.getTool(b.id)!.config, { url: "https://a.com" });
  // Typed content is kept for tools that still exist.
  assert.deepEqual(db.getTool(a.id)!.data, { text: "typed after the snapshot" });
});

test("a snapshot can't touch another project's tools", () => {
  const p1 = db.createProject("One");
  const p2 = db.createProject("Two");
  const other = db.createTool({ projectId: p2.id, category: "module", type: "notes", x: 0, y: 0, w: 1, h: 1, config: {} });
  db.restoreProject(p1.id, { name: "One", gridWidth: 6, tools: [{ ...other, x: 4 }] });
  assert.equal(db.getTool(other.id)!.x, 0);
  assert.equal(db.getTool(other.id)!.projectId, p2.id);
  assert.equal(db.listTools(p1.id).length, 0);
});

test("restoring a missing project does nothing", () => {
  assert.equal(db.restoreProject(99999, { name: "x", gridWidth: 6, tools: [] }), undefined);
});
