import assert from "node:assert/strict";
import test from "node:test";

import {
  FileOperationError,
  copyAndVerify,
  removeOriginalFile,
  resolveDroppedHandles,
  undoStagedCopy,
  validateBeforeCommit,
} from "../js/file-system-service.js";

test("resolveDroppedHandles keeps every valid folder in a multi-item drop", async () => {
  const folders = ["과제", "렌더", "참고자료"].map((name) => ({ kind: "directory", name }));
  const items = folders.map((handle) => ({
    kind: "file",
    getAsFileSystemHandle: async () => handle,
  }));

  const result = await resolveDroppedHandles(items);

  assert.deepEqual(result.handles, folders);
  assert.equal(result.failedCount, 0);
});

test("resolveDroppedHandles does not discard good folders when one item fails", async () => {
  const first = { kind: "directory", name: "과제" };
  const second = { kind: "directory", name: "완료" };
  const items = [
    { kind: "file", getAsFileSystemHandle: async () => first },
    { kind: "file", getAsFileSystemHandle: async () => { throw new Error("blocked"); } },
    { kind: "file", getAsFileSystemHandle: async () => second },
  ];

  const result = await resolveDroppedHandles(items);

  assert.deepEqual(result.handles, [first, second]);
  assert.equal(result.failedCount, 1);
});

function domError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

class FakeFileHandle {
  constructor(name, bytes, options = {}) {
    this.kind = "file";
    this.name = name;
    this.bytes = Uint8Array.from(bytes);
    this.lastModified = options.lastModified ?? 10;
    this.corruptWrites = options.corruptWrites ?? false;
    this.removed = false;
    if (options.removeUnsupported) this.remove = undefined;
  }

  async getFile() {
    if (this.removed) throw domError("NotFoundError");
    const blob = new Blob([this.bytes], { type: "application/octet-stream" });
    return Object.assign(blob, { name: this.name, lastModified: this.lastModified });
  }

  async createWritable() {
    return {
      write: async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        this.bytes = this.corruptWrites ? bytes.slice(0, Math.max(0, bytes.length - 1)) : bytes;
        this.lastModified += 1;
      },
      close: async () => {},
      abort: async () => {},
    };
  }

  async remove() {
    this.removed = true;
  }
}

class FakeDirectoryHandle {
  constructor(name, { corruptNewFiles = false } = {}) {
    this.kind = "directory";
    this.name = name;
    this.entriesMap = new Map();
    this.corruptNewFiles = corruptNewFiles;
  }

  addFile(name, bytes, options) {
    const handle = new FakeFileHandle(name, bytes, options);
    this.entriesMap.set(name, handle);
    return handle;
  }

  async getFileHandle(name, options = {}) {
    const entry = this.entriesMap.get(name);
    if (entry) return entry;
    if (!options.create) throw domError("NotFoundError");
    const handle = new FakeFileHandle(name, [], { corruptWrites: this.corruptNewFiles });
    this.entriesMap.set(name, handle);
    return handle;
  }

  async removeEntry(name) {
    if (!this.entriesMap.has(name)) throw domError("NotFoundError");
    this.entriesMap.delete(name);
  }
}

test("copyAndVerify creates a verified copy while keeping the original", async () => {
  const source = new FakeFileHandle("render.png", [1, 2, 3, 4], { lastModified: 50 });
  const destination = new FakeDirectoryHandle("과제");
  const stages = [];

  const move = await copyAndVerify({
    sourceHandle: source,
    destinationDirectory: destination,
    onProgress: (stage) => stages.push(stage),
  });

  assert.equal(source.removed, false);
  assert.equal(destination.entriesMap.has("render.png"), true);
  assert.deepEqual(move.sourceSnapshot, { size: 4, lastModified: 50 });
  assert.deepEqual(stages, ["copying", "verifying", "staged"]);
});

test("copyAndVerify never overwrites an existing destination", async () => {
  const source = new FakeFileHandle("same.psd", [1, 2, 3]);
  const destination = new FakeDirectoryHandle("과제");
  destination.addFile("same.psd", [8, 8]);

  await assert.rejects(
    copyAndVerify({ sourceHandle: source, destinationDirectory: destination }),
    (error) => error instanceof FileOperationError && error.code === "DESTINATION_EXISTS",
  );
  assert.deepEqual([...destination.entriesMap.get("same.psd").bytes], [8, 8]);
  assert.equal(source.removed, false);
});

test("a size mismatch removes the bad copy and keeps the original", async () => {
  const source = new FakeFileHandle("large.blend", [1, 2, 3, 4]);
  const destination = new FakeDirectoryHandle("과제", { corruptNewFiles: true });

  await assert.rejects(
    copyAndVerify({ sourceHandle: source, destinationDirectory: destination }),
    (error) => error instanceof FileOperationError && error.code === "SIZE_MISMATCH",
  );
  assert.equal(destination.entriesMap.has("large.blend"), false);
  assert.equal(source.removed, false);
});

test("Undo removes only the destination copy", async () => {
  const source = new FakeFileHandle("notes.pdf", [4, 5, 6]);
  const destination = new FakeDirectoryHandle("과제");
  await copyAndVerify({ sourceHandle: source, destinationDirectory: destination });

  await undoStagedCopy(destination, "notes.pdf");

  assert.equal(destination.entriesMap.has("notes.pdf"), false);
  assert.equal(source.removed, false);
});

test("commit validation rejects a source changed after copying", async () => {
  const source = new FakeFileHandle("work.psd", [1, 2, 3], { lastModified: 20 });
  const destination = new FakeDirectoryHandle("완료");
  const staged = await copyAndVerify({ sourceHandle: source, destinationDirectory: destination });
  source.bytes = Uint8Array.from([9, 9, 9]);
  source.lastModified = 21;

  await assert.rejects(
    validateBeforeCommit({ ...staged, sourceHandle: source, fileName: source.name }),
    (error) => error instanceof FileOperationError && error.code === "SOURCE_CHANGED",
  );
  assert.equal(source.removed, false);
});

test("commit validation rejects a changed destination copy", async () => {
  const source = new FakeFileHandle("work.psd", [1, 2, 3], { lastModified: 20 });
  const destination = new FakeDirectoryHandle("완료");
  const staged = await copyAndVerify({ sourceHandle: source, destinationDirectory: destination });
  staged.destinationHandle.bytes = Uint8Array.from([9]);

  await assert.rejects(
    validateBeforeCommit({ ...staged, sourceHandle: source, fileName: source.name }),
    (error) => error instanceof FileOperationError && error.code === "DESTINATION_CHANGED",
  );
  assert.equal(source.removed, false);
});

test("removeOriginalFile uses the individual file handle", async () => {
  const source = new FakeFileHandle("done.txt", [1]);
  await removeOriginalFile(source);
  assert.equal(source.removed, true);
});

test("removeOriginalFile reports unsupported handles", async () => {
  const source = new FakeFileHandle("old.txt", [1], { removeUnsupported: true });
  await assert.rejects(
    removeOriginalFile(source),
    (error) => error instanceof FileOperationError && error.code === "REMOVE_UNSUPPORTED",
  );
});
