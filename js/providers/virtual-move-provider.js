/**
 * VirtualMoveProvider — 디스크를 건드리지 않는 Provider의 공통 뼈대.
 *
 * 파일과 폴더 목록은 하위 클래스가 "출처"에서 가져오고(드롭 핸들 또는 샘플), 이동·되돌리기·새 폴더는
 * 전부 메모리 안에서만 일어난다. 동명 충돌은 폴더 안의 **실제 이름**(출처가 읽어 준다)과 이번 세션에서
 * 가상으로 넣은 이름을 합쳐서 판단한다. 그래서 체험 모드에서도 "이미 같은 이름이 있음"이 진짜처럼 튕긴다.
 *
 * 하위 클래스가 구현할 것:
 *   _listChildren(folderEntry)  → Promise<Array<{ name: string }>>   하위 폴더 한 단계
 *   _listNames(folderEntry)     → Promise<Set<string>>               폴더 안의 실제 항목 이름
 */
import { FileSystemProvider, ProviderError, emptyImport, folderLabel, validateFolderName } from "./file-system-provider.js";

const nameCollator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

export class VirtualMoveProvider extends FileSystemProvider {
  /** id → { item, source } */
  _files = new Map();
  /** id → { item, source, listed, names: Set<string>|null } */
  _folders = new Map();
  _folderOrder = [];
  /** fileId → folderId|null  (가상 현재 위치. null = 바탕화면) */
  _placement = new Map();
  /** batchId → [{ fileId, from, to }] */
  _undoLog = new Map();
  _desktopName = "바탕화면";
  _delay;

  constructor({ delay = false } = {}) {
    super();
    this._delay = delay;
  }

  get files() {
    return [...this._files.values()].map((entry) => entry.item);
  }

  get folders() {
    return this._folderOrder.map((id) => this._folders.get(id).item);
  }

  get desktopName() {
    return this._desktopName;
  }

  /** 지금 각 파일이 (가상으로) 어디에 있는지. 정리 계획 요약에 쓴다. */
  get placements() {
    return [...this._placement.entries()]
      .filter(([, folderId]) => folderId !== null)
      .map(([fileId, folderId]) => ({ fileId, folderId }));
  }

  // ───────────────────────── 등록 (하위 클래스가 부른다) ─────────────────────────

  _addFile(item, source = null) {
    this._files.set(item.id, { item, source });
    this._placement.set(item.id, null);
    return item;
  }

  _addFolder({ name, parentId = null, virtual = false }, source = null) {
    const parent = parentId ? this._folders.get(parentId) : null;
    const item = {
      id: crypto.randomUUID(),
      name,
      parentId,
      path: parent ? [...parent.item.path, name] : [name],
      hasChildren: virtual ? false : null,
      virtual,
    };
    this._folders.set(item.id, { item, source, listed: virtual, names: virtual ? new Set() : null });
    this._folderOrder.push(item.id);
    return item;
  }

  _reset() {
    this._files.clear();
    this._folders.clear();
    this._folderOrder = [];
    this._placement.clear();
    this._undoLog.clear();
  }

  // ───────────────────────── 하위 클래스가 구현 ─────────────────────────

  async _listChildren(_folderEntry) {
    return [];
  }

  async _listNames(_folderEntry) {
    return new Set();
  }

  /** 드롭으로 받은 파일은 이미 Blob을 들고 있다. 읽기 권한만으로 되므로 확인창이 없다. */
  async readThumbnail(fileId) {
    return this._files.get(fileId)?.item.file ?? null;
  }

  // ───────────────────────── 조회 ─────────────────────────

  async listSubfolders(folderId) {
    const entry = this._folders.get(folderId);
    if (!entry) return [];
    if (!entry.listed) {
      let children;
      try {
        children = await this._listChildren(entry);
      } catch (error) {
        throw new ProviderError("FOLDER_UNREADABLE", `'${entry.item.name}' 안을 읽지 못했습니다.`, error);
      }
      children.sort((a, b) => nameCollator.compare(a.name, b.name));
      for (const child of children) this._addFolder({ name: child.name, parentId: folderId }, child.source ?? null);
      entry.listed = true;
      entry.item.hasChildren = children.length > 0;
    }
    if (this._delay) await new Promise((resolve) => setTimeout(resolve, 120));
    return this.folders.filter((item) => item.parentId === folderId);
  }

  async _namesIn(folderId) {
    const entry = this._folders.get(folderId);
    if (!entry) throw new ProviderError("FOLDER_UNKNOWN", "배송지를 찾지 못했습니다.");
    if (!entry.names) {
      try {
        entry.names = new Set(await this._listNames(entry));
      } catch {
        entry.names = new Set();
      }
    }
    // 이번 세션에서 가상으로 넣은 파일도 이름을 차지한다
    for (const [fileId, placedIn] of this._placement) {
      if (placedIn === folderId) entry.names.add(this._files.get(fileId).item.name);
    }
    return entry.names;
  }

  // ───────────────────────── 이동 / 되돌리기 (전부 가상) ─────────────────────────

  async moveBatch(fileIds, folderId, { onItem = () => {} } = {}) {
    const batchId = crypto.randomUUID();
    const result = { batchId, folderId, moved: [], failed: [] };
    const folder = this._folders.get(folderId);
    const fail = (fileId, code, message) => {
      const fileName = this._files.get(fileId)?.item.name ?? fileId;
      result.failed.push({ fileId, fileName, code, message });
      onItem(fileId, "failed", new ProviderError(code, message));
    };
    if (!folder) {
      for (const fileId of fileIds) fail(fileId, "FOLDER_UNKNOWN", "배송지를 찾지 못했습니다.");
      return result;
    }
    const label = folderLabel(folder.item.path);
    const names = await this._namesIn(folderId);
    const log = [];

    for (const fileId of fileIds) {
      const entry = this._files.get(fileId);
      if (!entry) {
        fail(fileId, "FILE_UNKNOWN", "파일을 찾지 못했습니다.");
        continue;
      }
      const from = this._placement.get(fileId) ?? null;
      if (from === folderId) {
        fail(fileId, "ALREADY_THERE", `'${entry.item.name}'은(는) 이미 그 폴더에 있습니다.`);
        continue;
      }
      if (names.has(entry.item.name)) {
        // §5-2 동명 파일: 경고하고 이 항목만 중단. 덮어쓰지 않는다.
        fail(fileId, "DESTINATION_EXISTS", `'${label}'에 '${entry.item.name}'이(가) 이미 있습니다. 덮어쓰지 않았습니다.`);
        continue;
      }
      onItem(fileId, "moving");
      if (this._delay) await new Promise((resolve) => setTimeout(resolve, Math.min(900, 120 + entry.item.size / (1024 * 1024) * 4)));
      this._placement.set(fileId, folderId);
      names.add(entry.item.name);
      log.push({ fileId, from, to: folderId });
      const move = { moveId: crypto.randomUUID(), batchId, fileId, folderId, fileName: entry.item.name, folderName: label, movedAt: Date.now() };
      result.moved.push(move);
      onItem(fileId, "placed");
    }

    if (log.length > 0) this._undoLog.set(batchId, log);
    return result;
  }

  /** 폴더에서 꺼내기도 디스크 쓰기 없이 가상 위치만 바꾼다. */
  async takeOut(fileIds, folderId) {
    const batchId = crypto.randomUUID();
    const result = { batchId, folderId, moved: [], failed: [] };
    const log = [];
    for (const fileId of new Set(fileIds)) {
      const item = this._files.get(fileId)?.item;
      if (!item || this._placement.get(fileId) !== folderId) {
        result.failed.push({ fileId, code: "FILE_NOT_IN_FOLDER", message: "이 폴더에 없는 파일입니다." });
        continue;
      }
      this._placement.set(fileId, null);
      log.push({ fileId, from: folderId, to: null });
      result.moved.push({ fileId, fileName: item.name });
    }
    if (log.length) this._undoLog.set(batchId, log);
    return result;
  }

  async undoBatch(batchId) {
    const log = this._undoLog.get(batchId) ?? [];
    const result = { batchId, restored: [], failed: [] };
    for (const step of [...log].reverse()) {
      const entry = this._files.get(step.fileId);
      if (!entry) continue;
      if (this._delay) await new Promise((resolve) => setTimeout(resolve, 60));
      this._placement.set(step.fileId, step.from);
      this._folders.get(step.to)?.names?.delete(entry.item.name);
      result.restored.push({
        moveId: crypto.randomUUID(),
        batchId,
        fileId: step.fileId,
        restoredFolderId: step.from,
        folderId: step.to,
        fileName: entry.item.name,
        folderName: folderLabel(this._folders.get(step.to)?.item.path ?? []),
        movedAt: Date.now(),
      });
    }
    this._undoLog.delete(batchId);
    return result;
  }

  async createFolder(parentId, name) {
    const problem = validateFolderName(name);
    if (problem) throw new ProviderError("BAD_NAME", problem);
    const trimmed = name.trim();
    if (parentId && !this._folders.has(parentId)) throw new ProviderError("FOLDER_UNKNOWN", "상위 폴더를 찾지 못했습니다.");
    const siblings = this.folders.filter((folder) => folder.parentId === parentId);
    if (siblings.some((folder) => folder.name.localeCompare(trimmed, undefined, { sensitivity: "accent" }) === 0)) {
      throw new ProviderError("DESTINATION_EXISTS", `'${trimmed}' 폴더가 이미 있습니다.`);
    }
    return this._addFolder({ name: trimmed, parentId, virtual: true });
  }
}

export { emptyImport };
