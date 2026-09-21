import test from "node:test";
import assert from "node:assert/strict";
import { BoxPlacementState, fitsOn, overlaps, rotateBox, rotatedSize, supportsBox, validateBoxPlacement } from "../js/three/box-placement.js";

const bounds = { minX: -8, maxX: 8, minZ: -5, maxZ: 5 };
const pose = (x, z) => ({ x, z, y: 0, width: 2, depth: 1 });
const context = { bounds, obstacles: [{ x: -5, z: 0, width: 2, depth: 4 }], boxes: [{ folderId: "b", ...pose(3, 0) }] };

test("box footprint, not just its center, must fit inside walls", () => {
  assert.equal(validateBoxPlacement(pose(0, 0), context), null);
  assert.match(validateBoxPlacement(pose(7.5, 0), context), /벽/);
  assert.match(validateBoxPlacement(pose(0, -4.8), context), /벽/);
  assert.match(validateBoxPlacement(null, context), /바닥/);
});
test("furniture and other boxes block placement, the picked box does not", () => {
  assert.match(validateBoxPlacement(pose(-5, 1), context), /가구/);
  assert.match(validateBoxPlacement(pose(2, 0), context), /다른 상자/);
  assert.equal(validateBoxPlacement(pose(3, 0), { ...context, folderId: "b" }), null);
});
test("invalid commit preserves pose and history; cancellation requires no commit", () => {
  const state = new BoxPlacementState();
  assert.ok(state.commit("a", pose(0, -3), pose(-5, 0), context));
  assert.equal(state.get("a"), null);
  assert.equal(state.lastMove, null);
});
test("positions keyed by folder identity survive reordering and undo in reverse", () => {
  const state = new BoxPlacementState();
  const from = pose(0, -3), first = pose(0, 0), second = pose(0, 2);
  assert.equal(state.commit("a", from, first, context), null);
  assert.equal(state.commit("a", first, second, context), null);
  assert.deepEqual(state.get("a"), second);
  const copy = state.get("a"); copy.x = 99;
  assert.deepEqual(state.get("a"), second);
  assert.equal(state.undo(context), null);
  assert.deepEqual(state.get("a"), first);
  assert.equal(state.undo(context), null);
  assert.deepEqual(state.get("a"), from);
  assert.equal(state.lastMove, null);
});
test("undo refuses an occupied old position without losing its history", () => {
  const state = new BoxPlacementState();
  state.commit("a", pose(0, 0), pose(0, 2), context);
  assert.match(state.undo({ ...context, boxes: [{ folderId: "b", ...pose(0, 0) }] }), /상자/);
  assert.deepEqual(state.get("a"), pose(0, 2));
  assert.ok(state.lastMove);
});

test("wheel rotation uses 15 degree steps and wraps in either direction", () => {
  assert.ok(Math.abs(rotateBox(0, 1) - Math.PI / 12) < 1e-10);
  assert.ok(Math.abs(rotateBox(0, -1) - Math.PI * 23 / 12) < 1e-10);
  assert.ok(Math.abs(rotateBox(0, 24)) < 1e-10);
  assert.ok(Math.abs(rotateBox(rotateBox(0, 7), -7)) < 1e-10);
});

test("rotation changes footprint and wall clearance", () => {
  const quarter = { ...pose(7.3, 0), yaw: Math.PI / 2 };
  const size = rotatedSize(quarter);
  assert.ok(Math.abs(size.width - 1) < 1e-10);
  assert.ok(Math.abs(size.depth - 2) < 1e-10);
  assert.equal(validateBoxPlacement(quarter, { bounds }), null);
  assert.match(validateBoxPlacement(pose(7.3, 0), { bounds }), /벽/);
  assert.match(validateBoxPlacement({ ...pose(0, 4.4), yaw: Math.PI / 2 }, { bounds }), /벽/);
});

test("rotated rectangle collision uses separating axes, not oversized bounding boxes", () => {
  const a = { ...pose(0, 0), width: 4, depth: 0.4, yaw: Math.PI / 4 };
  const b = { ...a, x: 0.8, z: 0.8 };
  assert.equal(overlaps(a, b), false);
  assert.equal(overlaps(b, a), false);
  assert.equal(overlaps(a, { ...b, x: 0.1, z: 0.1 }), true);
  assert.match(validateBoxPlacement(a, { bounds, obstacles: [{ ...b, x: 0.1, z: 0.1 }] }), /가구/);
});

test("a shelf rejects a rotated footprint which extends outside its slot", () => {
  const slot = { width: 2, depth: 1 };
  assert.equal(validateBoxPlacement(pose(0, 0), { bounds, support: slot }), null);
  assert.match(validateBoxPlacement({ ...pose(0, 0), yaw: Math.PI / 4 }, { bounds, support: slot }), /수납칸/);
  assert.equal(validateBoxPlacement({ ...pose(0, 0), yaw: Math.PI }, { bounds, support: slot }), null);
});

test("committed orientation survives reads and undo restores the previous orientation", () => {
  const state = new BoxPlacementState();
  const from = { ...pose(0, 0), yaw: Math.PI / 12 };
  const to = { ...pose(0, 2), yaw: Math.PI / 2 };
  assert.equal(state.commit("a", from, to, context), null);
  assert.deepEqual(state.get("a"), to);
  assert.equal(state.undo(context), null);
  assert.deepEqual(state.get("a"), from);
});

test("stacking accepts a supported top and rejects an overhang or missing support", () => {
  const base = { ...pose(0, 0), folderId: "base", height: 1.08 };
  const top = { ...pose(0, 0), y: 1.08, supportId: "base" };
  assert.equal(validateBoxPlacement(top, { bounds, boxes: [base] }), null);
  assert.match(validateBoxPlacement({ ...top, x: 0.5 }, { bounds, boxes: [base] }), /튀어나/);
  assert.match(validateBoxPlacement(top, { bounds, boxes: [] }), /받쳐/);
  assert.match(validateBoxPlacement({ ...top, supportId: undefined }, { bounds }), /공중/);
  assert.match(validateBoxPlacement({ ...top, supportId: "self" }, { bounds, folderId: "self", boxes: [{ ...base, folderId: "self" }] }), /받쳐/);
});

test("rotated stacking checks all corners relative to the base", () => {
  const base = { ...pose(0, 0), yaw: Math.PI / 4 };
  assert.equal(fitsOn({ ...base }, base), true);
  assert.equal(fitsOn({ ...base, yaw: 0 }, base), false);
  assert.equal(fitsOn({ ...base, width: 0.5, depth: 0.5, yaw: 0 }, base), true);
});

test("stacking respects other boxes, the ceiling, and shelf tops", () => {
  const base = { ...pose(0, 0), folderId: "base" };
  const top = { ...pose(0, 0), y: 1.08, supportId: "base" };
  assert.match(validateBoxPlacement(top, { bounds, boxes: [base, { ...top, folderId: "occupied" }] }), /다른 상자/);
  assert.match(validateBoxPlacement(top, { bounds, boxes: [base], maxHeight: 2 }), /높이/);
  assert.match(validateBoxPlacement(top, { bounds, boxes: [base], obstacles: [{ ...pose(0, 0), y: 1.2, height: 0.15 }] }), /가구/);
});

test("a supporting box cannot move until the top is removed, including a hidden top", () => {
  const state = new BoxPlacementState();
  const base = { ...pose(0, 0), folderId: "base" };
  const top = { ...pose(0, 0), y: 1.08, supportId: "base" };
  assert.equal(state.commit("top", pose(0, 3), top, { bounds, boxes: [base] }), null);
  assert.equal(state.supports("base"), true);
  assert.equal(supportsBox("base", [{ ...top, folderId: "top" }]), true);
  assert.match(state.commit("base", base, pose(3, 0), { bounds, boxes: [] }), /먼저/);
  assert.equal(state.undo({ bounds, boxes: [base] }), null);
  assert.equal(state.supports("base"), false);
  assert.equal(state.commit("base", base, pose(3, 0), { bounds, boxes: [] }), null);
});

test("multi-level stack undo retains history when its old support moved", () => {
  const state = new BoxPlacementState();
  const base = { ...pose(0, 0), folderId: "base" };
  const middle = { ...pose(0, 0), folderId: "middle", y: 1.08, supportId: "base" };
  const top = { ...pose(0, 0), y: 2.16, supportId: "middle" };
  assert.equal(state.commit("top", top, pose(0, 3), { bounds, boxes: [base, middle] }), null);
  assert.match(state.undo({ bounds, boxes: [base] }), /받쳐/);
  assert.ok(state.lastMove);
  assert.equal(state.undo({ bounds, boxes: [base, middle] }), null);
  assert.deepEqual(state.get("top"), top);
});
