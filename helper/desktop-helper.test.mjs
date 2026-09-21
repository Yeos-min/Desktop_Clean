import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HelperError, createDesktopSession, createHelperServer, identityOf, isInside, moveNoOverwrite, parseArgs, validateName } from "./desktop-helper.mjs";

// 진짜 파일 시스템 위에서 돌지만, 임시 폴더를 바탕화면인 척 쓴다. 실제 바탕화면은 건드리지 않는다.

async function makeDesktop() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeongridae-desktop-"));
  await fs.writeFile(path.join(dir, "렌더_0412.png"), "png-bytes");
  await fs.writeFile(path.join(dir, "노트.txt"), "hello");
  await fs.writeFile(path.join(dir, "desktop.ini"), "[.ShellClassInfo]");
  await fs.mkdir(path.join(dir, "과제"));
  await fs.mkdir(path.join(dir, "과제", "3D모델링"));
  await fs.mkdir(path.join(dir, "과제", "3D모델링", "과제3"));
  await fs.writeFile(path.join(dir, "과제", "수업계획서.pdf"), "pdf");
  await fs.mkdir(path.join(dir, "렌더"));
  await fs.writeFile(path.join(dir, "렌더", "렌더_0412.png"), "existing");
  return dir;
}

async function makeOutside() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeongridae-outside-"));
  await fs.writeFile(path.join(dir, "secret.txt"), "secret");
  return dir;
}

test("isInside and validateName enforce the desktop sandbox rules", () => {
  assert.equal(isInside("C:\\Users\\u\\Desktop\\a.txt", "C:\\Users\\u\\Desktop"), true);
  assert.equal(isInside("C:\\Users\\u\\Desktop", "C:\\Users\\u\\Desktop"), true);
  assert.equal(isInside("C:\\Users\\u\\Desktop2\\a.txt", "C:\\Users\\u\\Desktop"), false, "접두어만 같은 형제 폴더");
  assert.equal(isInside("C:\\Users\\u\\Desktop\\..\\Documents\\a.txt", "C:\\Users\\u\\Desktop"), false, "path traversal");
  assert.equal(isInside("C:\\Windows", "C:\\Users\\u\\Desktop"), false);
  assert.equal(validateName("  새 폴더 "), "새 폴더");
  for (const bad of ["", "..", "a/b", "a\\b", "con", "COM1.txt", "x.", "a:b"]) {
    assert.throws(() => validateName(bad), (error) => error instanceof HelperError && error.code === "BAD_NAME", bad);
  }
});

test("scan lists direct files and folders, skips desktop.ini and reparse points, and never recurses", async () => {
  const desktop = await makeDesktop();
  const outside = await makeOutside();
  await fs.symlink(outside, path.join(desktop, "정션"), "junction");
  const session = await createDesktopSession({ desktopPath: desktop });

  const result = await session.scan();

  assert.deepEqual(result.files.map((file) => file.name), ["노트.txt", "렌더_0412.png"]);
  assert.deepEqual(result.folders.map((folder) => folder.name), ["과제", "렌더"]);
  assert.equal(result.skippedReparsePoints, 1);
  assert.equal(result.desktop.name, path.basename(desktop));
  assert.ok(result.files.every((file) => !("path" in file)), "절대경로는 응답에 없다");
  assert.equal(result.files[1].size, 9);
  assert.equal(result.files[1].type, "image/png");
});

test("children opens one level lazily and refuses unknown ids", async () => {
  const desktop = await makeDesktop();
  const session = await createDesktopSession({ desktopPath: desktop });
  const { folders } = await session.scan();
  const tasks = folders.find((folder) => folder.name === "과제");

  const level1 = await session.children(tasks.id);
  assert.deepEqual(level1.folders.map((folder) => folder.name), ["3D모델링"], "파일(수업계획서.pdf)은 빠진다");
  assert.equal(level1.folders[0].parentId, tasks.id);
  const level2 = await session.children(level1.folders[0].id);
  assert.deepEqual(level2.folders.map((folder) => folder.name), ["과제3"]);

  await assert.rejects(session.children("d_nope"), (error) => error.code === "FOLDER_UNKNOWN");
});

test("move renames within the desktop, refuses same-name collisions, and undo renames back", async () => {
  const desktop = await makeDesktop();
  const session = await createDesktopSession({ desktopPath: desktop });
  const scanned = await session.scan();
  const png = scanned.files.find((file) => file.name === "렌더_0412.png");
  const txt = scanned.files.find((file) => file.name === "노트.txt");
  const render = scanned.folders.find((folder) => folder.name === "렌더");
  const tasks = scanned.folders.find((folder) => folder.name === "과제");

  const result = await session.move([png.id, txt.id], render.id);

  assert.deepEqual(result.moved.map((move) => move.fileName), ["노트.txt"]);
  assert.equal(result.moved[0].folderName, "렌더");
  assert.deepEqual(result.failed.map((failure) => [failure.fileName, failure.code]), [["렌더_0412.png", "DESTINATION_EXISTS"]]);
  assert.equal(await fs.readFile(path.join(desktop, "렌더", "노트.txt"), "utf8"), "hello");
  assert.equal(await fs.readFile(path.join(desktop, "렌더", "렌더_0412.png"), "utf8"), "existing", "덮어쓰지 않았다");
  assert.ok(await fs.stat(path.join(desktop, "렌더_0412.png")), "충돌한 원본은 그대로");

  // 같은 id로 한 번 더 옮길 수 있다 (id는 세션 동안 안정)
  const again = await session.move([txt.id], tasks.id);
  assert.equal(again.moved.length, 1);
  assert.equal(await fs.readFile(path.join(desktop, "과제", "노트.txt"), "utf8"), "hello");

  const undo2 = await session.undo(again.batchId);
  assert.deepEqual(undo2.restored.map((move) => move.fileName), ["노트.txt"]);
  assert.equal(undo2.restored[0].folderId, render.id, "되돌리면 직전 폴더(렌더)로");
  const undo1 = await session.undo(result.batchId);
  assert.equal(undo1.restored.length, 1);
  assert.equal(await fs.readFile(path.join(desktop, "노트.txt"), "utf8"), "hello", "바탕화면으로 돌아왔다");
  assert.equal(undo1.restored[0].folderId, null);
  assert.deepEqual(await session.undo(result.batchId), { batchId: result.batchId, restored: [], failed: [] }, "두 번 되돌리기는 아무것도 안 한다");
});

test("undo leaves a file alone when something new took its old place", async () => {
  const desktop = await makeDesktop();
  const session = await createDesktopSession({ desktopPath: desktop });
  const scanned = await session.scan();
  const txt = scanned.files.find((file) => file.name === "노트.txt");
  const tasks = scanned.folders.find((folder) => folder.name === "과제");
  const moved = await session.move([txt.id], tasks.id);
  await fs.writeFile(path.join(desktop, "노트.txt"), "새 파일");

  const undo = await session.undo(moved.batchId);

  assert.equal(undo.restored.length, 0);
  assert.equal(undo.failed[0].code, "DESTINATION_EXISTS");
  assert.equal(await fs.readFile(path.join(desktop, "과제", "노트.txt"), "utf8"), "hello");
  assert.equal(await fs.readFile(path.join(desktop, "노트.txt"), "utf8"), "새 파일");
});

test("moveNoOverwrite never replaces a file, even when many movers race for the same name", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeongridae-race-"));

  // 이미 자리를 차지한 파일은 건드리지 않는다
  await fs.writeFile(path.join(dir, "src.txt"), "mine");
  await fs.writeFile(path.join(dir, "dest.txt"), "남의 파일");
  await assert.rejects(moveNoOverwrite(path.join(dir, "src.txt"), path.join(dir, "dest.txt")), (error) => error.code === "EEXIST");
  assert.equal(await fs.readFile(path.join(dir, "dest.txt"), "utf8"), "남의 파일", "덮어쓰지 않았다");
  assert.equal(await fs.readFile(path.join(dir, "src.txt"), "utf8"), "mine", "원본도 그대로");

  // 진짜 경쟁: 같은 이름을 동시에 노려도 하나만 성공한다.
  // 확인과 이동이 나뉘어 있으면 여기서 여럿이 성공하고 내용이 섞인다.
  const target = path.join(dir, "경쟁.txt");
  const sources = [];
  for (let i = 0; i < 12; i += 1) {
    const src = path.join(dir, `경쟁_${i}.txt`);
    await fs.writeFile(src, `내용 ${i}`);
    sources.push(src);
  }
  // 한 틱 안에서 전부 출발시킨다 (사이에 await를 두면 경쟁이 아니라 순서대로 도는 것이 된다)
  const results = await Promise.allSettled(sources.map((src) => moveNoOverwrite(src, target)));
  const won = results.filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 1, "정확히 하나만 성공한다");
  assert.ok(results.every((r) => r.status === "fulfilled" || r.reason.code === "EEXIST"), "나머지는 전부 EEXIST");
  const landed = await fs.readFile(target, "utf8");
  assert.match(landed, /^내용 \d+$/, "내용이 섞이거나 잘리지 않았다");
  const survivors = (await fs.readdir(dir)).filter((name) => name.startsWith("경쟁_"));
  assert.equal(survivors.length, 11, "실패한 원본 11개는 제자리에 남는다");
});

test("moveNoOverwrite refuses when the file at the source is not the one we recorded", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeongridae-identity-"));
  const src = path.join(dir, "a.txt");
  await fs.writeFile(src, "원래 파일");
  const identity = await identityOf(src);

  // 밖에서 그 파일을 치우고 같은 이름의 다른 파일을 놓았다
  await fs.rename(src, path.join(dir, "다른곳.txt"));
  await fs.writeFile(src, "남의 파일");

  await assert.rejects(moveNoOverwrite(src, path.join(dir, "b.txt"), identity), (error) => error.code === "WRONG_FILE");
  assert.equal(await fs.readFile(src, "utf8"), "남의 파일", "남의 파일은 그대로");
  assert.equal(await fs.readFile(path.join(dir, "다른곳.txt"), "utf8"), "원래 파일");
  assert.equal((await fs.readdir(dir)).includes("b.txt"), false, "대상 자리에 아무것도 안 만들었다");

  // 진짜 그 파일이면 옮긴다
  const moved = await moveNoOverwrite(path.join(dir, "다른곳.txt"), path.join(dir, "b.txt"), identity);
  assert.ok(["link", "reserve"].includes(moved));
  assert.equal(await fs.readFile(path.join(dir, "b.txt"), "utf8"), "원래 파일");
});

test("undo refuses when a different file took the moved file's place", async () => {
  const desktop = await makeDesktop();
  const session = await createDesktopSession({ desktopPath: desktop });
  const scanned = await session.scan();
  const txt = scanned.files.find((file) => file.name === "노트.txt");
  const tasks = scanned.folders.find((folder) => folder.name === "과제");
  const moved = await session.move([txt.id], tasks.id);

  // 밖에서: 옮긴 파일을 다른 데로 빼고, 그 자리에 같은 이름의 다른 파일을 만든다
  await fs.rename(path.join(desktop, "과제", "노트.txt"), path.join(desktop, "과제", "옮겨둠.txt"));
  await fs.writeFile(path.join(desktop, "과제", "노트.txt"), "남의 파일");

  const undo = await session.undo(moved.batchId);

  assert.equal(undo.restored.length, 0);
  assert.equal(undo.failed[0].code, "WRONG_FILE");
  assert.equal(await fs.readFile(path.join(desktop, "과제", "노트.txt"), "utf8"), "남의 파일", "남의 파일은 자리에 그대로");
  assert.equal((await fs.readdir(desktop)).includes("노트.txt"), false, "바탕화면으로 끌고 오지 않았다");
  assert.equal(await fs.readFile(path.join(desktop, "과제", "옮겨둠.txt"), "utf8"), "hello");
});

test("undo restores the same file even when it was renamed back into place by hand", async () => {
  const desktop = await makeDesktop();
  const session = await createDesktopSession({ desktopPath: desktop });
  const scanned = await session.scan();
  const txt = scanned.files.find((file) => file.name === "노트.txt");
  const tasks = scanned.folders.find((folder) => folder.name === "과제");
  const moved = await session.move([txt.id], tasks.id);

  const undo = await session.undo(moved.batchId);

  assert.equal(undo.failed.length, 0, "정체가 그대로면 되돌아간다");
  assert.equal(await fs.readFile(path.join(desktop, "노트.txt"), "utf8"), "hello");
});

test("a junction inside the desktop is never a destination and files inside it are never listed", async () => {
  const desktop = await makeDesktop();
  const outside = await makeOutside();
  await fs.symlink(outside, path.join(desktop, "정션"), "junction");
  const session = await createDesktopSession({ desktopPath: desktop });
  const scanned = await session.scan();

  assert.equal(scanned.folders.some((folder) => folder.name === "정션"), false, "목록에서 빠진다");
  assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "secret");
});

test("createFolder makes a real folder inside the desktop only", async () => {
  const desktop = await makeDesktop();
  const session = await createDesktopSession({ desktopPath: desktop });
  const scanned = await session.scan();
  const tasks = scanned.folders.find((folder) => folder.name === "과제");

  const root = await session.createFolder(null, "새 상자");
  assert.equal(root.folder.name, "새 상자");
  assert.ok((await fs.stat(path.join(desktop, "새 상자"))).isDirectory());
  const nested = await session.createFolder(tasks.id, "주차별");
  assert.ok((await fs.stat(path.join(desktop, "과제", "주차별"))).isDirectory());
  assert.equal(nested.folder.parentId, tasks.id);

  await assert.rejects(session.createFolder(null, "새 상자"), (error) => error.code === "DESTINATION_EXISTS");
  await assert.rejects(session.createFolder(null, "..\\탈출"), (error) => error.code === "BAD_NAME");
  await assert.rejects(session.createFolder("d_nope", "x"), (error) => error.code === "FOLDER_UNKNOWN");
});

test("HTTP layer rejects wrong origin, missing token, oversized bodies, and serves the API for the allowed page", async () => {
  const desktop = await makeDesktop();
  const session = await createDesktopSession({ desktopPath: desktop });
  const token = "test-token";
  let byes = 0;
  const server = createHelperServer({ session, token, allowedOrigins: ["https://example.test"], onBye: () => (byes += 1) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const good = { Origin: "https://example.test", Authorization: `Bearer ${token}` };

  try {
    assert.equal((await fetch(`${base}/hello`)).status, 403, "Origin 없음");
    assert.equal((await fetch(`${base}/hello`, { headers: { Origin: "https://evil.test", Authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await fetch(`${base}/hello`, { headers: { Origin: "https://example.test" } })).status, 401, "토큰 없음");
    assert.equal((await fetch(`${base}/hello`, { headers: { Origin: "https://example.test", Authorization: "Bearer wrong" } })).status, 401);

    const preflight = await fetch(`${base}/move`, { method: "OPTIONS", headers: { Origin: "https://example.test" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://example.test");
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");

    const hello = await (await fetch(`${base}/hello`, { headers: good })).json();
    assert.equal(hello.name, "jeongridae-desktop-helper");

    const scanned = await (await fetch(`${base}/scan`, { headers: good })).json();
    const txt = scanned.files.find((file) => file.name === "노트.txt");
    const tasks = scanned.folders.find((folder) => folder.name === "과제");

    const moved = await (await fetch(`${base}/move`, { method: "POST", headers: { ...good, "Content-Type": "application/json" }, body: JSON.stringify({ fileIds: [txt.id], folderId: tasks.id }) })).json();
    assert.equal(moved.moved.length, 1);
    assert.equal(await fs.readFile(path.join(desktop, "과제", "노트.txt"), "utf8"), "hello");

    const children = await (await fetch(`${base}/folders/${tasks.id}/children`, { headers: good })).json();
    assert.deepEqual(children.folders.map((folder) => folder.name), ["3D모델링"]);

    const undone = await (await fetch(`${base}/undo`, { method: "POST", headers: { ...good, "Content-Type": "application/json" }, body: JSON.stringify({ batchId: moved.batchId }) })).json();
    assert.equal(undone.restored.length, 1);

    const huge = await fetch(`${base}/move`, { method: "POST", headers: { ...good, "Content-Type": "application/json" }, body: "x".repeat(70 * 1024) });
    assert.equal(huge.status, 413);

    const missing = await fetch(`${base}/nope`, { headers: good });
    assert.equal(missing.status, 404);

    const png = scanned.files.find((file) => file.name === "렌더_0412.png");
    const content = await fetch(`${base}/files/${png.id}/content`, { headers: good });
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-type"), "image/png");
    assert.equal(await content.text(), "png-bytes");
    const notImage = await fetch(`${base}/files/${txt.id}/content`, { headers: good });
    assert.equal(notImage.status, 415);

    assert.equal((await fetch(`${base}/bye`, { method: "POST", headers: good })).status, 200);
    assert.equal(byes, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("parseArgs reads flags", () => {
  const options = parseArgs(["--dev", "--desktop", "C:\\tmp\\d", "--origin", "https://a.test", "--no-open", "--idle-minutes", "3"]);
  assert.equal(options.dev, true);
  assert.equal(options.desktop, "C:\\tmp\\d");
  assert.deepEqual(options.origins, ["https://a.test"]);
  assert.equal(options.open, false);
  assert.equal(options.idleMinutes, 3);
});
