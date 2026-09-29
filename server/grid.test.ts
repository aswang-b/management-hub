// Tests for grid placement (shared by the server and the page): making room
// while a tool is dragged, and fitting tools into a narrower grid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRoom, overlaps, refit, type Rect } from "../shared/types.ts";

type Item = Rect & { i: string };
const at = (items: Item[], i: string) => {
  const t = items.find((t) => t.i === i)!;
  return { x: t.x, y: t.y };
};
const noOverlaps = (items: Item[]) => {
  for (const a of items) for (const b of items) if (a !== b) assert.ok(!overlaps(a, b), `${a.i} and ${b.i} overlap`);
};

// A 6-wide grid:  A A B . . .
//                 C . . . . .
const home: Item[] = [
  { i: "A", x: 0, y: 0, w: 2, h: 1 },
  { i: "B", x: 2, y: 0, w: 1, h: 1 },
  { i: "C", x: 0, y: 1, w: 1, h: 1 },
];

test("tools not in the way stay where they are", () => {
  const out = makeRoom(home, { i: "C", x: 4, y: 0, w: 1, h: 1 }, 6);
  assert.deepEqual(at(out, "A"), { x: 0, y: 0 });
  assert.deepEqual(at(out, "B"), { x: 2, y: 0 });
  assert.deepEqual(at(out, "C"), { x: 4, y: 0 });
});

test("a tool in the way moves to the nearest free spot", () => {
  // Drag C onto B's square: B steps aside by one square, not to the end of the grid.
  const out = makeRoom(home, { i: "C", x: 2, y: 0, w: 1, h: 1 }, 6);
  assert.deepEqual(at(out, "C"), { x: 2, y: 0 });
  assert.deepEqual(at(out, "B"), { x: 3, y: 0 });
  assert.deepEqual(at(out, "A"), { x: 0, y: 0 });
  noOverlaps(out);
});

test("tools go back home once the dragged tool moves on", () => {
  // Every call starts from the saved spots, so moving C past B and then
  // further away leaves B exactly where it started.
  makeRoom(home, { i: "C", x: 2, y: 0, w: 1, h: 1 }, 6);
  const out = makeRoom(home, { i: "C", x: 5, y: 3, w: 1, h: 1 }, 6);
  assert.deepEqual(at(out, "B"), { x: 2, y: 0 });
});

test("a tool dragged in from the palette makes room too", () => {
  const out = makeRoom(home, { i: "new", x: 0, y: 0, w: 2, h: 2 }, 6);
  assert.equal(out.length, 4);
  assert.deepEqual(at(out, "new"), { x: 0, y: 0 });
  noOverlaps(out);
});

test("a big drag keeps every tool on the grid without overlaps", () => {
  const many: Item[] = Array.from({ length: 12 }, (_, n) => ({ i: `t${n}`, x: n % 6, y: Math.floor(n / 6), w: 1, h: 1 }));
  const out = makeRoom(many, { i: "t0", x: 1, y: 0, w: 4, h: 2 }, 6);
  for (const t of out) assert.ok(t.x >= 0 && t.x + t.w <= 6, `${t.i} fits`);
  noOverlaps(out);
});

test("the dragged tool is kept inside the grid", () => {
  const out = makeRoom(home, { i: "A", x: 5, y: -1, w: 2, h: 1 }, 6);
  assert.deepEqual(at(out, "A"), { x: 4, y: 0 });
});

test("refit: shrinking the grid keeps tools from overlapping", () => {
  const tools = [
    { id: "a", x: 0, y: 0, w: 3, h: 1 },
    { id: "b", x: 3, y: 0, w: 1, h: 1 },
    { id: "c", x: 0, y: 1, w: 3, h: 3 },
    { id: "d", x: 4, y: 1, w: 2, h: 2 },
    { id: "e", x: 3, y: 4, w: 2, h: 2 },
    { id: "f", x: 0, y: 8, w: 6, h: 2 },
  ];
  const out = refit(tools, 4);
  for (const t of out) assert.ok(t.x >= 0 && t.x + t.w <= 4, `${t.id} fits`);
  for (const a of out) for (const b of out) if (a !== b) assert.ok(!overlaps(a, b), `${a.id} and ${b.id} overlap`);
  assert.deepEqual(out.find((t) => t.id === "a"), tools[0]); // untouched when it already fits
});
