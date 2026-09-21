import assert from "node:assert/strict";
import test from "node:test";
import { WebDropProvider } from "../js/providers/web-drop-provider.js";
import { SessionStore } from "../js/state/session-store.js";
import { FakeDirectoryHandle } from "./helpers/fake-handles.js";

async function setup() {
  const handle = new FakeDirectoryHandle("실제 폴더");
  const file = handle.addFile("photo.png", [1, 2, 3]);
  const child = handle.addDirectory("하위 폴더");
  child.addFile("nested.txt", [4]);
  let childReads = 0;
  const entries = child.entries.bind(child);
  child.entries = () => { childReads++; return entries(); };
  for (const entry of [handle, child, file]) {
    for (const method of ["remove", "removeEntry", "createWritable", "requestPermission"])
      entry[method] = () => { throw new Error(`Unexpected write: ${method}`); };
  }
  const provider = new WebDropProvider();
  const imported = await provider.importHandles([handle]);
  const folder = imported.folders[0];
  const store = new SessionStore();
  store.setFolders(provider.folders);
  const open = async (id = folder.id) => {
    const contents = await provider.listContents(id);
    store.addFolders(contents.folders);
    store.addContainedFiles(contents.files, id);
    return contents;
  };
  return { provider, store, folder, handle, file, open, childReads: () => childReads };
}

test("web interior reads only the opened level, preserves IDs and supplies thumbnails", async () => {
  const { provider, store, folder, open, childReads } = await setup();
  assert.equal(provider.files.length, 0);
  const contents = await open();
  assert.equal(contents.files[0].name, "photo.png");
  assert.equal(contents.folders.length, 1);
  assert.equal(childReads(), 0);
  assert.deepEqual(await open(), contents);
  assert.deepEqual(store.progress, { done: 0, total: 0 });
  assert.equal(store.boardEntries.length, 0);
  assert.equal((await provider.readThumbnail(contents.files[0].id)).size, 3);
  assert.equal((await open(contents.folders[0].id)).files[0].name, "nested.txt");
  const empty = await provider.createFolder(folder.id, "빈 폴더");
  assert.deepEqual(await provider.listContents(empty.id), { folders: [], files: [] });
});

test("web take-out, deposit and two undos keep disk unchanged and restore session progress", async () => {
  const { provider, store, folder, handle, file, open } = await setup();
  const id = (await open()).files[0].id;
  const taken = await provider.takeOut([id], folder.id);
  store.applyTakeOutResult(taken);
  assert.deepEqual(store.selection, [id]);
  assert.equal((await open()).files.length, 0);
  store.beginBatch([id], folder.id);
  const moved = await provider.moveBatch([id], folder.id);
  store.applyMoveResult(moved);
  assert.equal(moved.moved.length, 1);
  store.applyUndoResult(await provider.undoBatch(moved.batchId));
  assert.equal(store.entry(id).status, "idle");
  store.applyUndoResult(await provider.undoBatch(taken.batchId));
  assert.equal(store.entry(id).folderId, folder.id);
  assert.deepEqual(store.progress, { done: 0, total: 0 });
  assert.equal((await open()).files.length, 1);
  assert.equal(handle.entriesMap.get("photo.png"), file);
  assert.deepEqual([...file.bytes], [1, 2, 3]);
});

test("web interior surfaces read failures and allows retry without duplicating files", async () => {
  const { provider, folder, file, open } = await setup();
  const getFile = file.getFile.bind(file);
  file.getFile = async () => { throw new Error("read denied"); };
  await assert.rejects(open, /read denied/);
  file.getFile = getFile;
  assert.equal((await open()).files.length, 1);
  assert.equal((await provider.listContents(folder.id)).files.length, 1);
});
