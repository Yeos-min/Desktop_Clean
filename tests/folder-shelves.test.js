import test from "node:test";
import assert from "node:assert/strict";
import { FolderShelfAssignments, folderShelfSlots, SHELF_BOX } from "../js/three/folder-shelves.js";
import { overlaps, rotatedSize } from "../js/three/box-placement.js";

const half = { x: 8.6, z: 5.8 };
const obstacles = [
  { x: -7.12, z: -0.9, width: 2.65, depth: 4.25 },
  { x: 7.48, z: -0.3, width: 1.95, depth: 3.6 },
  { x: 6.58, z: 0.65, width: 0.95, depth: 1.1 },
  { x: -7.07, z: -4.35, width: 1.2, depth: 1.2 },
  { x: 7.45, z: -3.7, width: 1.4, depth: 1.4 },
];
const slots = folderShelfSlots(half, obstacles);
const ids = n => Array.from({ length: n }, (_, i) => `folder-${i}`);

test("10 and 30 folders have fixed-size non-overlapping shelf slots inside the room", () => {
  assert.ok(slots.length >= 30);
  assert.equal(new Set(slots.map(slot => slot.y)).size, 2);
  for (const count of [10, 30]) for (const [i, slot] of slots.slice(0, count).entries()) {
    assert.equal(slot.width, SHELF_BOX.width);
    assert.equal(slot.depth, SHELF_BOX.depth);
    const size = rotatedSize(slot);
    assert.ok(Math.abs(slot.x) + size.width / 2 < half.x - 0.3);
    assert.ok(Math.abs(slot.z) + size.depth / 2 < half.z - 0.3);
    assert.equal(obstacles.some(obstacle => overlaps(slot, obstacle)), false);
    assert.equal(slots.slice(0, i).some(other => other.y === slot.y && overlaps(slot, other)), false);
  }
});

test("default assignment stays stable after adding and reordering folders", () => {
  const state = new FolderShelfAssignments();
  const initial = state.assign(ids(4), slots);
  const expanded = state.assign(ids(30).reverse(), slots);
  for (const [id, index] of initial) assert.equal(expanded.get(id), index);
  assert.equal(new Set(expanded.values()).size, 30);
});

test("new folders skip slots occupied by manually moved boxes", () => {
  const state = new FolderShelfAssignments();
  state.assign(ids(4), slots);
  const moved = { ...slots[4] };
  const assigned = state.assign(ids(5), slots, new Map([["folder-0", moved]]));
  assert.equal(assigned.get("folder-0"), 0);
  assert.equal(assigned.get("folder-4"), 5);
  assert.deepEqual(moved, slots[4]);
});

test("overflow uses another area rather than shrinking or placing boxes outside the room", () => {
  const assigned = new FolderShelfAssignments().assign(ids(70), slots);
  assert.equal(assigned.size, 70);
  assert.equal(new Set(assigned.values()).size, 70);
  assert.equal(Math.floor(assigned.get("folder-69") / slots.length), 2);
  assert.ok(slots[assigned.get("folder-69") % slots.length]);
});
