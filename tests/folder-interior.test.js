import assert from "node:assert/strict";
import test from "node:test";
import { MemoryProvider } from "../js/providers/memory-provider.js";
import { SessionStore } from "../js/state/session-store.js";

async function setup() {
  const provider = new MemoryProvider({ delay: false, files: [{ name: "root.png" }], folders: [
    { name: "A", existing: ["inside.png", "note.pdf"], children: [{ name: "nested", existing: ["deep.png"] }] },
    { name: "B", existing: ["inside.png"] }, { name: "empty" },
  ] });
  await provider.scan();
  const store = new SessionStore();
  store.setFolders(provider.folders);
  store.addFiles(provider.files);
  const [a, b, empty] = provider.folders;
  const open = async (id) => {
    const result = await provider.listContents(id);
    store.addFolders(result.folders);
    store.addContainedFiles(result.files, id);
    return result;
  };
  const undo = async () => store.applyUndoResult(await provider.undoBatch(store.lastBatch.batchId));
  return { provider, store, a, b, empty, open, undo };
}

test("interior reads files/children lazily without supplying cards or changing progress", async () => {
  const { provider, store, a, empty, open } = await setup();
  const before = store.progress;
  const first = await open(a.id);
  assert.equal(first.files.length, 2);
  assert.equal(first.folders.length, 1);
  assert.deepEqual(store.progress, before);
  assert.equal(store.boardEntries.length, 1);
  assert.deepEqual((await open(a.id)).files.map((file) => file.id), first.files.map((file) => file.id));
  assert.equal((await open(first.folders[0].id)).files[0].name, "deep.png");
  assert.deepEqual(await provider.listContents(empty.id), { folders: [], files: [] });
});

test("take multiple, drop on floor, deposit, undo deposit and undo extraction restore both models", async () => {
  const { provider, store, a, empty, open, undo } = await setup();
  const { files } = await open(a.id);
  const ids = files.map((file) => file.id);
  store.applyTakeOutResult(await provider.takeOut(ids, a.id));
  assert.deepEqual(store.selection, ids);
  assert.equal((await open(a.id)).files.length, 0);
  store.setPositions(ids.map((id, i) => ({ id, x: 200 + i * 150, y: 200 })));
  store.clearSelection();
  store.beginBatch(ids, empty.id);
  store.applyMoveResult(await provider.moveBatch(ids, empty.id));
  assert.equal((await open(empty.id)).files.length, 2);
  await undo();
  for (const id of ids) { assert.equal(store.entry(id).status, "idle"); assert.equal(provider.placements.some((p) => p.fileId === id), false); }
  await undo();
  assert.equal((await open(a.id)).files.length, 2);
  assert.equal(store.selection.length, 0);
  assert.deepEqual(store.progress, { done: 0, total: 1 });
});

test("returning to same box frees/reclaims names; another box still rejects duplicates", async () => {
  const { provider, store, a, b, open } = await setup();
  const id = (await open(a.id)).files[0].id;
  store.applyTakeOutResult(await provider.takeOut([id], a.id));
  const collision = await provider.moveBatch([id], b.id);
  assert.equal(collision.failed[0].code, "DESTINATION_EXISTS");
  assert.equal((await provider.moveBatch([id], a.id)).moved.length, 1);
  assert.equal((await open(a.id)).files.length, 2);
});

test("a room card deposited then extracted can undo back through both operations", async () => {
  const { provider, store, a, open, undo } = await setup();
  const id = store.files[0].id;
  store.beginBatch([id], a.id);
  store.applyMoveResult(await provider.moveBatch([id], a.id));
  assert.ok((await open(a.id)).files.some((file) => file.id === id));
  store.applyTakeOutResult(await provider.takeOut([id], a.id));
  await undo();
  assert.equal(store.entry(id).folderId, a.id);
  assert.equal(store.selection.length, 0);
  await undo();
  assert.equal(store.entry(id).status, "idle");
  assert.equal(provider.placements.some((p) => p.fileId === id), false);
});

test("unknown or stale take-out requests do not change the folder", async () => {
  const { provider, a, open } = await setup();
  await open(a.id);
  assert.equal((await provider.takeOut(["missing"], a.id)).failed.length, 1);
  assert.equal((await open(a.id)).files.length, 2);
});
