import assert from "node:assert/strict";
import test from "node:test";

import { validateFolderName } from "../js/providers/file-system-provider.js";
import { MemoryProvider } from "../js/providers/memory-provider.js";
import { NativeHelperProvider } from "../js/providers/native-helper-provider.js";
import { SAMPLE_FILES, SAMPLE_FOLDERS } from "../js/providers/sample-desktop.js";
import { WebDropProvider } from "../js/providers/web-drop-provider.js";
import { FakeDirectoryHandle, FakeFileHandle } from "./helpers/fake-handles.js";

// 가짜 핸들 위에서 Provider의 규칙을 확인한다. 실기기 검증이 아니다.

function fakeDesktop() {
  const desktop = new FakeDirectoryHandle("Desktop");
  const tasks = desktop.addDirectory("과제");
  tasks.addDirectory("3D모델링").addDirectory("과제3");
  tasks.addDirectory("인터랙션");
  tasks.addFile("수업계획서.pdf", [1]);
  const render = desktop.addDirectory("렌더");
  render.addFile("렌더_0412.png", [9, 9]);
  const files = [
    new FakeFileHandle("렌더_0412.png", [1, 2, 3]),
    new FakeFileHandle("렌더_0413.png", [4]),
    new FakeFileHandle("노트.txt", [5, 5]),
  ];
  return { desktop, tasks, render, files };
}

// ───────────────────────── WebDropProvider ─────────────────────────

test("WebDropProvider imports dropped files and folders read-only and sorts files", async () => {
  const { tasks, render, files } = fakeDesktop();
  const provider = new WebDropProvider();
  const items = [...files, tasks, render, new FakeFileHandle("노트.txt", [5, 5])].map((handle) => ({ kind: "file", getAsFileSystemHandle: async () => handle }));
  items.push({ kind: "file", getAsFileSystemHandle: async () => null }); // 휴지통 같은 가상 항목

  const result = await provider.importDropped(items);

  assert.deepEqual(result.files.map((file) => file.name), ["노트.txt", "노트.txt", "렌더_0412.png", "렌더_0413.png"], "다른 핸들이면 같은 이름도 들어온다 (출처를 알 수 없다, §8-3)");
  assert.deepEqual(result.folders.map((folder) => folder.name), ["과제", "렌더"]);
  assert.equal(result.unresolved, 1);
  assert.match(result.notes[0], /가상 항목/);
  assert.equal(result.files[2].size, 3);
  assert.ok(result.files[2].file instanceof Blob, "썸네일용 Blob");
  assert.equal(provider.capabilities.realFiles, false);
});

test("WebDropProvider opens subfolders one level and judges conflicts against real names without writing", async () => {
  const { tasks, render, files } = fakeDesktop();
  const provider = new WebDropProvider();
  const { files: imported, folders } = await provider.importHandles([...files, tasks, render]);
  const tasksId = folders[0].id;
  const renderId = folders[1].id;

  const children = await provider.listSubfolders(tasksId);
  assert.deepEqual(children.map((folder) => folder.name), ["3D모델링", "인터랙션"]);
  assert.deepEqual(children[0].path, ["과제", "3D모델링"]);
  const grand = await provider.listSubfolders(children[0].id);
  assert.deepEqual(grand.map((folder) => folder.name), ["과제3"]);

  const stages = [];
  const result = await provider.moveBatch(
    imported.map((file) => file.id),
    renderId,
    { onItem: (_, stage) => stages.push(stage) },
  );
  assert.deepEqual(result.moved.map((move) => move.fileName), ["노트.txt", "렌더_0413.png"]);
  assert.deepEqual(result.failed.map((failure) => [failure.fileName, failure.code]), [["렌더_0412.png", "DESTINATION_EXISTS"]]);
  assert.equal(result.moved[0].folderName, "렌더");
  assert.deepEqual(stages.sort(), ["failed", "moving", "moving", "placed", "placed"]);

  // 두 번째 배치: 가상으로 넣은 이름도 충돌한다
  const again = await provider.moveBatch([imported.find((file) => file.name === "노트.txt").id], renderId);
  assert.equal(again.failed[0].code, "ALREADY_THERE");

  const undo = await provider.undoBatch(result.batchId);
  assert.deepEqual(undo.restored.map((move) => move.fileName).sort(), ["노트.txt", "렌더_0413.png"]);
  assert.equal(provider.placements.filter((entry) => imported.some((file) => file.id === entry.fileId)).length, 0);
  assert.deepEqual((await provider.listContents(renderId)).files.map((file) => file.name), ["렌더_0412.png"],
    "원래 폴더 안에 있던 파일은 Undo 후에도 그대로다");

  assert.deepEqual(render.removeEntryCalls, [], "쓰기 API는 부르지 않는다");
  assert.equal(render.entriesMap.size, 1, "실제 폴더는 그대로");
  assert.ok(files.every((handle) => !handle.removed));
});

test("WebDropProvider creates virtual folders with the same name rules as the helper", async () => {
  const { tasks } = fakeDesktop();
  const provider = new WebDropProvider();
  const { folders } = await provider.importHandles([tasks]);

  const created = await provider.createFolder(null, " 새 상자 ");
  assert.equal(created.name, "새 상자");
  assert.equal(created.virtual, true);
  assert.equal(created.hasChildren, false);
  const nested = await provider.createFolder(folders[0].id, "주차별");
  assert.deepEqual(nested.path, ["과제", "주차별"]);
  await assert.rejects(provider.createFolder(null, "새 상자"), (error) => error.code === "DESTINATION_EXISTS");
  await assert.rejects(provider.createFolder(null, "a/b"), (error) => error.code === "BAD_NAME");
  assert.equal(validateFolderName("con"), "Windows 예약어는 쓸 수 없습니다.");
  assert.equal(tasks.entriesMap.has("주차별"), false, "가상이다. 디스크에 만들지 않는다");
});

// ───────────────────────── MemoryProvider ─────────────────────────

test("MemoryProvider scans the sample desktop with nested folders and deliberate conflicts", async () => {
  const provider = new MemoryProvider({ delay: false });
  const result = await provider.scan();
  assert.equal(result.files.length, SAMPLE_FILES.length);
  assert.equal(result.folders.length, SAMPLE_FOLDERS.length);

  const tasks = result.folders.find((folder) => folder.name === "과제");
  const children = await provider.listSubfolders(tasks.id);
  assert.deepEqual(children.map((folder) => folder.name), ["3D모델링", "인터랙션디자인", "졸업연구"]);

  const render = result.folders.find((folder) => folder.name === "렌더");
  const dup = result.files.find((file) => file.name === "렌더_0412.png");
  const ok = result.files.find((file) => file.name === "렌더_0413.png");
  const moved = await provider.moveBatch([dup.id, ok.id], render.id);
  assert.equal(moved.moved.length, 1);
  assert.equal(moved.failed[0].code, "DESTINATION_EXISTS");
});

// ───────────────────────── NativeHelperProvider ─────────────────────────

function fakeHelper() {
  const calls = [];
  const state = {
    files: [
      { id: "f_1", name: "노트.txt", size: 5, type: "text/plain", lastModified: 1 },
      { id: "f_2", name: "렌더_0412.png", size: 9, type: "image/png", lastModified: 2 },
    ],
    folders: [
      { id: "d_1", name: "과제", parentId: null, hasChildren: null },
      { id: "d_2", name: "렌더", parentId: null, hasChildren: null },
    ],
  };
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method ?? "GET", pathname, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const respond = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
    if (init.headers?.Authorization !== "Bearer tok") return respond(401, { error: { code: "HELPER_UNAUTHORIZED", message: "토큰이 맞지 않습니다." } });
    if (pathname === "/v1/hello") return respond(200, { name: "jeongridae-desktop-helper", version: "0.1.0", desktopName: "Desktop" });
    if (pathname === "/v1/scan") return respond(200, { desktop: { name: "Desktop" }, ...state, skipped: 0, skippedReparsePoints: 2 });
    if (pathname === "/v1/folders/d_1/children") return respond(200, { folders: [{ id: "d_3", name: "3D모델링", parentId: "d_1" }] });
    if (pathname === "/v1/move") {
      const { fileIds, folderId } = init.headers ? JSON.parse(init.body) : {};
      return respond(200, {
        batchId: "b_1",
        folderId,
        moved: fileIds.filter((id) => id === "f_1").map((id) => ({ moveId: "m_1", fileId: id, fileName: "노트.txt", folderId, movedAt: 10 })),
        failed: fileIds.filter((id) => id === "f_2").map((id) => ({ fileId: id, fileName: "렌더_0412.png", code: "DESTINATION_EXISTS", message: "같은 이름" })),
      });
    }
    if (pathname === "/v1/undo") return respond(200, { batchId: "b_1", restored: [{ moveId: "m_2", fileId: "f_1", fileName: "노트.txt", folderId: null, movedAt: 11 }], failed: [] });
    if (pathname === "/v1/folders") return respond(200, { folder: { id: "d_9", name: JSON.parse(init.body).name, parentId: JSON.parse(init.body).parentId, hasChildren: null } });
    if (pathname === "/v1/bye") return respond(200, { ok: true });
    return respond(404, { error: { code: "NOT_FOUND", message: "없음" } });
  };
  return { fetchImpl, calls };
}

test("NativeHelperProvider talks to the helper with ids and a bearer token only", async () => {
  const { fetchImpl, calls } = fakeHelper();
  const provider = new NativeHelperProvider({ port: 4321, token: "tok", fetchImpl });

  const hello = await provider.connect();
  assert.equal(hello.desktopName, "Desktop");
  assert.equal(provider.capabilities.realFiles, true);

  const scanned = await provider.scan();
  assert.deepEqual(scanned.files.map((file) => file.name), ["노트.txt", "렌더_0412.png"]);
  assert.equal(scanned.files[0].extension, "txt");
  assert.match(scanned.notes[0], /정션 2개/);

  const children = await provider.listSubfolders("d_1");
  assert.deepEqual(children[0].path, ["과제", "3D모델링"]);
  assert.equal(provider.folders.find((folder) => folder.id === "d_1").hasChildren, true);

  const stages = [];
  const moved = await provider.moveBatch(["f_1", "f_2"], "d_3", { onItem: (id, stage) => stages.push(`${id}:${stage}`) });
  assert.equal(moved.moved[0].folderName, "과제 › 3D모델링");
  assert.equal(moved.failed[0].code, "DESTINATION_EXISTS");
  assert.deepEqual(stages, ["f_1:moving", "f_2:moving", "f_1:placed", "f_2:failed"]);

  const undone = await provider.undoBatch("b_1");
  assert.equal(undone.restored[0].fileName, "노트.txt");

  const created = await provider.createFolder("d_1", "주차별");
  assert.deepEqual(created.path, ["과제", "주차별"]);

  await provider.disconnect();
  assert.ok(calls.every((call) => call.auth === "Bearer tok"));
  assert.ok(calls.every((call) => !JSON.stringify(call.body ?? {}).includes("C:\\")), "절대경로는 오가지 않는다");
  assert.equal(calls.at(-1).pathname, "/v1/bye");
});

test("NativeHelperProvider surfaces helper errors as ProviderError codes", async () => {
  const { fetchImpl } = fakeHelper();
  const wrong = new NativeHelperProvider({ port: 4321, token: "nope", fetchImpl });
  await assert.rejects(wrong.connect(), (error) => error.code === "HELPER_UNAUTHORIZED");

  const unreachable = new NativeHelperProvider({ port: 1, token: "tok", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(unreachable.connect(), (error) => error.code === "HELPER_UNREACHABLE");
});
