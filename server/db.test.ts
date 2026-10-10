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

test("sides start as scratchpads and keep their settings within limits", () => {
  const p = db.createProject("Sides");
  assert.deepEqual(p.sides, { left: { mode: "scratchpad", gridWidth: 2 }, right: { mode: "scratchpad", gridWidth: 2 } });
  const q = db.updateProject(p.id, { sides: { left: { mode: "grid", gridWidth: 99 }, right: { mode: "nonsense" } } })!;
  assert.deepEqual(q.sides, { left: { mode: "grid", gridWidth: 6 }, right: { mode: "scratchpad", gridWidth: 2 } });
});

test("narrowing a grid only moves the tools on that grid", () => {
  const p = db.createProject("Zones");
  db.updateProject(p.id, { sides: { left: { mode: "grid", gridWidth: 3 } } });
  const main = db.createTool({ projectId: p.id, category: "module", type: "notes", x: 2, y: 0, w: 1, h: 1, config: {} });
  const left = db.createTool({ projectId: p.id, category: "module", type: "notes", zone: "left", x: 2, y: 0, w: 1, h: 1, config: {} });
  assert.equal(left.zone, "left");
  assert.equal(main.zone, "main");
  db.updateProject(p.id, { sides: { left: { gridWidth: 1 } } });
  assert.equal(db.getTool(left.id)!.x, 0);
  assert.equal(db.getTool(main.id)!.x, 2);
});

test("restoring a snapshot brings back sides and which grid each tool was on", () => {
  const p = db.createProject("Undo sides");
  const t = db.createTool({ projectId: p.id, category: "module", type: "notes", x: 0, y: 0, w: 1, h: 1, config: {} });
  const snap = { name: p.name, gridWidth: p.gridWidth, sides: p.sides, tools: db.listTools(p.id) };
  db.updateProject(p.id, { sides: { right: { mode: "grid" } } });
  db.updateTool(t.id, { zone: "right" });
  const back = db.restoreProject(p.id, snap)!;
  assert.equal(back.sides.right.mode, "scratchpad");
  assert.equal(db.getTool(t.id)!.zone, "main");
});

test("scratchpads are saved per side and kept by Undo", () => {
  const p = db.createProject("Scratch");
  assert.deepEqual(db.getScratch(p.id, "left"), { texts: [], strokes: [] });
  const data = { texts: [{ id: "a", x: 10, y: 20, text: "hello" }], strokes: [{ id: "b", points: [0, 0, 5, 5] }] };
  db.saveScratch(p.id, "left", data);
  db.restoreProject(p.id, { name: p.name, gridWidth: p.gridWidth, sides: p.sides, tools: [] });
  assert.deepEqual(db.getScratch(p.id, "left"), data);
  assert.deepEqual(db.getScratch(p.id, "right"), { texts: [], strokes: [] });
});
