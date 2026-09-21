import assert from "node:assert/strict";
import test from "node:test";

import { SAMPLE_FILES } from "../js/providers/sample-desktop.js";
import { SessionStore } from "../js/state/session-store.js";
import { extensionOf, rectsOverlap } from "../js/ui/layout.js";

function sampleItems(count) {
  return SAMPLE_FILES.slice(0, count).map((file, index) => ({
    id: `f${index}`,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    extension: extensionOf(file.name),
    file: null,
  }));
}

const FOLDERS = [
  { id: "A", name: "과제", parentId: null, path: ["과제"], hasChildren: null },
  { id: "B", name: "렌더", parentId: null, path: ["렌더"], hasChildren: null },
];

function movedResult(store, ids, folderId, batchId) {
  return {
    batchId,
    folderId,
    moved: ids.map((fileId, index) => ({
      moveId: `${batchId}-${index}`,
      batchId,
      fileId,
      folderId,
      fileName: store.entry(fileId).item.name,
      folderName: store.folderLabel(folderId),
      movedAt: 1000 + index,
    })),
    failed: [],
  };
}

function boardRects(store) {
  const { width, height } = store.card;
  return store.boardEntries.map((entry) => ({ id: entry.id, ...entry.position, width, height }));
}

function assertNoOverlap(rects) {
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) assert.equal(rectsOverlap(rects[i], rects[j]), false);
  }
}

test("addFiles fills the board to capacity and queues the rest with valid positions", () => {
  const store = new SessionStore({ capacity: 16, refillBelow: 6 });
  store.setFolders(FOLDERS);
  store.addFiles(sampleItems(30));

  assert.equal(store.unprocessedCount, 16);
  assert.equal(store.queuedCount, 14);
  const rects = boardRects(store);
  const bounds = store.bounds;
  for (const rect of rects) {
    assert.ok(rect.x >= bounds.x && rect.x + rect.width <= bounds.x + bounds.width);
    assert.ok(rect.y >= bounds.y && rect.y + rect.height <= bounds.y + bounds.height);
  }
  assertNoOverlap(rects);
});

test("a batch that empties most of the board triggers the next wave", () => {
  const store = new SessionStore({ capacity: 16, refillBelow: 6 });
  store.setFolders(FOLDERS);
  store.addFiles(sampleItems(30));

  const ids = store.boardEntries.slice(0, 12).map((entry) => entry.id);
  store.beginBatch(ids, "A");
  assert.ok(ids.every((id) => store.entry(id).status === "moving"));
  store.applyMoveResult(movedResult(store, ids, "A", "b1"));

  assert.equal(store.placedCount, 12);
  assert.equal(store.unprocessedCount, 16, "4장 남았으니 12장이 새로 들어온다");
  assert.equal(store.queuedCount, 2);
  assert.equal(store.lastBatch.batchId, "b1");
  assertNoOverlap(boardRects(store));
});

test("no refill while enough cards remain, but a manual pull always brings at least one", () => {
  const store = new SessionStore({ capacity: 16, refillBelow: 6 });
  store.setFolders(FOLDERS);
  store.addFiles(sampleItems(30));
  const ids = store.boardEntries.slice(0, 4).map((entry) => entry.id);
  store.beginBatch(ids, "A");
  store.applyMoveResult(movedResult(store, ids, "A", "b1"));
  assert.equal(store.unprocessedCount, 12);

  assert.equal(store.supply({ force: true }).length, 4, "force는 capacity까지 채운다");
  assert.equal(store.supply({ force: true }).length, 1, "꽉 차 있어도 수동이면 최소 1장");
});

test("conflicts stay on the board, keep their spot, and can be picked again", () => {
  const store = new SessionStore({ capacity: 16, refillBelow: 6 });
  store.setFolders(FOLDERS);
  store.addFiles(sampleItems(10));
  const [ok, dup] = store.boardEntries.slice(0, 2).map((entry) => entry.id);
  const before = { ...store.entry(dup).position };
  store.beginBatch([ok, dup], "B");

  const result = movedResult(store, [ok], "B", "b1");
  result.failed.push({ fileId: dup, fileName: store.entry(dup).item.name, code: "DESTINATION_EXISTS", message: "동명" });
  store.applyMoveResult(result);

  assert.equal(store.entry(dup).status, "conflict");
  assert.deepEqual(store.entry(dup).position, before);
  store.select(dup);
  assert.deepEqual(store.selection, [dup]);
  store.select(ok);
  assert.deepEqual(store.selection, [dup], "옮겨진 카드는 선택되지 않는다");
});

test("undo returns cards to their previous positions and pops the batch", () => {
  const store = new SessionStore({ capacity: 16, refillBelow: 6 });
  store.setFolders(FOLDERS);
  store.addFiles(sampleItems(10));
  const ids = store.boardEntries.slice(0, 3).map((entry) => entry.id);
  const positions = ids.map((id) => ({ ...store.entry(id).position }));
  store.beginBatch(ids, "A");
  store.applyMoveResult(movedResult(store, ids, "A", "b1"));

  store.applyUndoResult({ batchId: "b1", restored: ids.map((fileId) => ({ fileId, batchId: "b1" })), failed: [] });

  ids.forEach((id, index) => {
    assert.equal(store.entry(id).status, "idle");
    assert.deepEqual(store.entry(id).position, positions[index]);
  });
  assert.equal(store.lastBatch, null);
});

test("a partial undo keeps the failed item placed and the batch alive", () => {
  const store = new SessionStore({ capacity: 16, refillBelow: 6 });
  store.setFolders(FOLDERS);
  store.addFiles(sampleItems(6));
  const [a, b] = store.boardEntries.slice(0, 2).map((entry) => entry.id);
  store.beginBatch([a, b], "A");
  store.applyMoveResult(movedResult(store, [a, b], "A", "b1"));

  store.applyUndoResult({
    batchId: "b1",
    restored: [{ fileId: a, batchId: "b1" }],
    failed: [{ fileId: b, fileName: "x", code: "DESTINATION_EXISTS", message: "원래 자리에 뭔가 생김" }],
  });

  assert.equal(store.entry(a).status, "idle");
  assert.equal(store.entry(b).status, "placed");
  assert.equal(store.entry(b).message, "원래 자리에 뭔가 생김");
  assert.deepEqual(store.lastBatch.fileIds, [b]);
});

test("destination tree: entering a folder shows [self, ...children] and number keys follow the visible row", () => {
  const store = new SessionStore({ capacity: 16, refillBelow: 6 });
  store.setFolders(FOLDERS);
  assert.deepEqual(store.visibleTargets.map((target) => target.id), ["A", "B"]);
  assert.equal(store.folderAt(2).id, "B");

  store.addFolders([
    { id: "A1", name: "3D모델링", parentId: "A", path: ["과제", "3D모델링"], hasChildren: null },
    { id: "A2", name: "인터랙션", parentId: "A", path: ["과제", "인터랙션"], hasChildren: null },
  ]);
  assert.deepEqual(store.visibleTargets.map((target) => target.id), ["A", "B"], "열기 전에는 루트 줄 그대로");

  assert.equal(store.enterFolder("A"), true);
  const row = store.visibleTargets;
  assert.deepEqual(row.map((target) => [target.id, target.isSelf]), [["A", true], ["A1", false], ["A2", false]]);
  assert.equal(store.folderAt(1).id, "A", "1번은 '여기에'");
  assert.equal(store.folderAt(3).id, "A2");
  assert.equal(store.folderAt(4), null);
  assert.equal(store.folderLabel("A2"), "과제 › 인터랙션");

  store.addFolders([{ id: "A1a", name: "과제3", parentId: "A1", path: ["과제", "3D모델링", "과제3"], hasChildren: null }]);
  store.enterFolder("A1");
  assert.deepEqual(store.visibleTargets.map((target) => target.id), ["A1", "A1a"]);
  assert.equal(store.isDescendant("A1a", "A"), true);
  assert.equal(store.isDescendant("B", "A"), false);

  assert.equal(store.leaveFolder(), true);
  assert.equal(store.level, "A");
  store.leaveToRoot();
  assert.equal(store.level, null);
  assert.equal(store.leaveFolder(), false);
});

test("placedInTree counts moves into subfolders toward the root box, and summary groups by folder", () => {
  const store = new SessionStore({ capacity: 16, refillBelow: 6 });
  store.setFolders(FOLDERS);
  store.addFolders([{ id: "A1", name: "3D모델링", parentId: "A", path: ["과제", "3D모델링"], hasChildren: null }]);
  store.addFiles(sampleItems(4));
  const [a, b, c] = store.boardEntries.map((entry) => entry.id);
  store.beginBatch([a], "A");
  store.applyMoveResult(movedResult(store, [a], "A", "b1"));
  store.beginBatch([b, c], "A1");
  store.applyMoveResult(movedResult(store, [b, c], "A1", "b2"));

  assert.equal(store.placedIn("A").length, 1);
  assert.equal(store.placedInTree("A").length, 3);
  assert.equal(store.placedInTree("A1").length, 2);
  assert.equal(store.placedInTree("B").length, 0);
  assert.deepEqual(store.summary.map((row) => [row.folder, row.names.length]), [["과제", 1], ["과제 › 3D모델링", 2]]);
});

test("marquee-style selectMany ignores placed cards and supports additive selection", () => {
  const store = new SessionStore({ capacity: 16, refillBelow: 6 });
  store.setFolders(FOLDERS);
  store.addFiles(sampleItems(6));
  const ids = store.boardEntries.map((entry) => entry.id);
  store.beginBatch([ids[0]], "A");
  store.applyMoveResult(movedResult(store, [ids[0]], "A", "b1"));

  store.selectMany(ids.slice(0, 3));
  assert.deepEqual(store.selection.sort(), [ids[1], ids[2]].sort());
  store.selectMany([ids[4]], { additive: true });
  assert.equal(store.selection.length, 3);
  store.select(ids[1], { toggle: true });
  assert.equal(store.selection.includes(ids[1]), false);
  store.clearSelection();
  assert.deepEqual(store.selection, []);
});
