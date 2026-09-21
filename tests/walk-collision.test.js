import test from "node:test";
import assert from "node:assert/strict";
import { moveWalker, safeWalkPosition, walkBlocked, movementKey } from "../js/three/walk-collision.js";
import { folderShelfSlots } from "../js/three/folder-shelves.js";

const furniture = [
  { x: -7.12, z: -0.9, width: 2.65, depth: 4.25 },
  { x: 7.48, z: -0.3, width: 1.95, depth: 3.6 },
  { x: 6.58, z: 0.65, width: 0.95, depth: 1.1 },
  { x: -7.07, z: -4.35, width: 1.2, depth: 1.2 },
  { x: 7.45, z: -3.7, width: 1.4, depth: 1.4 },
];
const bounds = { minX: -7.5, maxX: 7.5, minZ: -4.7, maxZ: 4.7 };
const shelves = folderShelfSlots({ x: 8.6, z: 5.8 }, furniture).slice(0, 30)
  .map(slot => ({ ...slot, width: slot.width + 0.2, depth: slot.depth + 0.32 }));
const context = { bounds, radius: 0.7, obstacles: [...furniture, ...shelves] };

test("30-folder rear shelves trap the old spawn; recovery makes WASD movement possible", () => {
  const oldSpawn = { x: 0, z: 4.7 };
  assert.equal(walkBlocked(oldSpawn, context), true);
  for (const delta of [{ x: 0.01, z: 0 }, { x: -0.01, z: 0 }, { x: 0, z: 0.01 }, { x: 0, z: -0.01 }]) {
    assert.equal(walkBlocked({ x: oldSpawn.x + delta.x, z: oldSpawn.z + delta.z }, context), true);
  }
  const safe = safeWalkPosition(oldSpawn, context);
  assert.ok(safe);
  assert.equal(walkBlocked(safe, context), false);
  assert.ok(moveWalker(oldSpawn, { x: 0, z: -0.1 }, context).z < safe.z);
});

test("normal positions do not jump and newly placed boxes allow recovery", () => {
  const point = { x: 0, z: 0 };
  assert.deepEqual(safeWalkPosition(point, context), point);
  const changed = { ...context, obstacles: [...context.obstacles, { ...point, width: 1.7, depth: 1.12, yaw: Math.PI / 4 }] };
  const safe = safeWalkPosition(point, changed);
  assert.equal(walkBlocked(safe, changed), false);
  assert.deepEqual(safeWalkPosition(safe, changed), safe);
});

test("walking slides along obstacles without crossing them or room bounds", () => {
  const wall = { bounds, radius: 0.3, obstacles: [{ x: 0, z: 0, width: 0.1, depth: 8 }] };
  const moved = moveWalker({ x: -1, z: 0 }, { x: 3, z: 1 }, wall);
  assert.ok(moved.x < 0);
  assert.ok(moved.z > 0.9);
  assert.equal(walkBlocked(moved, wall), false);
  assert.equal(walkBlocked(moveWalker({ x: -1, z: 0 }, { x: -20, z: 0 }, wall), wall), false);
});

test("no free position returns null instead of moving into furniture", () => {
  assert.equal(safeWalkPosition({ x: 0, z: 0 }, { ...context, obstacles: [{ x: 0, z: 0, width: 30, depth: 30 }] }), null);
});

test("physical WASD handles Korean IME and key release after language changes", () => {
  assert.equal(movementKey({ code: "KeyW", key: "ㅈ" }), "w");
  assert.equal(movementKey({ code: "KeyA", key: "ㅁ" }), "a");
  assert.equal(movementKey({ code: "KeyS", key: "ㄴ" }), "s");
  assert.equal(movementKey({ code: "KeyD", key: "ㅇ" }), "d");
  assert.equal(movementKey({ code: "KeyW", key: "w" }), "w");
  assert.equal(movementKey({ code: "ArrowUp", key: "ArrowUp" }), "arrowup");
});
