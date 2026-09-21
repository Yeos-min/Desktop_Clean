import test from "node:test";
import assert from "node:assert/strict";
import { PointerLockState } from "../js/three/pointer-lock-state.js";

test("Escape release allows another gesture to resume mouse look", () => {
  const state = new PointerLockState();
  let requests = 0;
  const canvas = { requestPointerLock: () => { requests++; } };
  state.request(canvas);
  state.changed(true);
  state.changed(false);
  assert.equal(state.hasLocked, true);
  state.request(canvas);
  assert.equal(requests, 2);
  state.changed(true);
  assert.equal(state.locked, true);
  assert.equal(state.denied, false);
});

test("one failed request never permanently disables retries", async () => {
  const state = new PointerLockState();
  state.request({ requestPointerLock: () => Promise.reject(new Error("denied")) });
  await Promise.resolve();
  assert.equal(state.denied, true);
  assert.equal(state.pending, false);
  let requested = false;
  state.request({ requestPointerLock: () => { requested = true; } });
  assert.equal(requested, true);
  state.changed(true);
  assert.equal(state.denied, false);
});

test("rapid repeated clicks cannot start overlapping requests", () => {
  const state = new PointerLockState();
  let requests = 0;
  const canvas = { requestPointerLock: () => { requests++; } };
  state.request(canvas); state.request(canvas);
  assert.equal(requests, 1);
  state.failed(); state.request(canvas);
  assert.equal(requests, 2);
});

test("an old rejection cannot disable a newer request or an acquired lock", async () => {
  const state = new PointerLockState();
  let reject;
  state.request({ requestPointerLock: () => new Promise((_, no) => { reject = no; }) });
  state.failed();
  state.request({ requestPointerLock: () => {} });
  reject(new Error("late failure"));
  await Promise.resolve();
  assert.equal(state.pending, true);
  state.changed(true);
  state.failed();
  assert.equal(state.locked, true);
  assert.equal(state.denied, false);
});

test("missing API and synchronous errors keep fallback and retries available", () => {
  const state = new PointerLockState();
  state.request({});
  assert.equal(state.denied, true);
  state.request({ requestPointerLock: () => { throw new Error("unsupported"); } });
  assert.equal(state.pending, false);
  state.request({ requestPointerLock: () => {} });
  assert.equal(state.pending, true);
});
