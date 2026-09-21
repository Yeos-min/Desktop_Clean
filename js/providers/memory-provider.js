/**
 * MemoryProvider — 개발·테스트용 샘플 바탕화면. 디스크를 일절 건드리지 않는다.
 * 손맛 조정은 이걸로 한다. 게임 모드가 아니다 — 데이터가 가짜일 뿐 규칙은 같다.
 */
import { emptyImport, getExtension } from "./file-system-provider.js";
import { SAMPLE_FILES, SAMPLE_FOLDERS, SAMPLE_IMAGE_EXTENSIONS, makeSampleImage } from "./sample-desktop.js";
import { VirtualMoveProvider } from "./virtual-move-provider.js";

export class MemoryProvider extends VirtualMoveProvider {
  capabilities = {
    kind: "memory",
    realFiles: false,
    immediateMove: true,
    canCreateFolder: true,
    canWatch: false,
    canScan: true,
  };

  #seedFiles;
  #seedFolders;
  #thumbnails = new Map();
  #contentsLoaded = new Set();

  /**
   * @param {object} [options]
   * @param {boolean} [options.delay=true]  크기에 비례한 이동 지연을 흉내 낸다
   * @param {Array} [options.files]        기본 SAMPLE_FILES
   * @param {Array} [options.folders]      기본 SAMPLE_FOLDERS
   * @param {string} [options.desktopName]
   */
  constructor({ delay = true, files = SAMPLE_FILES, folders = SAMPLE_FOLDERS, desktopName = "샘플 바탕화면" } = {}) {
    super({ delay });
    this.#seedFiles = files;
    this.#seedFolders = folders;
    this._desktopName = desktopName;
  }

  async scan() {
    this._reset();
    this.#contentsLoaded.clear();
    this.#thumbnails.clear();
    const result = emptyImport();
    for (const spec of this.#seedFolders) result.folders.push(this._addFolder({ name: spec.name, parentId: null }, spec));
    for (const file of this.#seedFiles) {
      result.files.push(
        this._addFile({
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size ?? 0,
          type: file.type ?? "",
          lastModified: file.lastModified ?? Date.now(),
          extension: getExtension(file.name),
          file: null,
        }),
      );
    }
    return result;
  }

  // 메모리 모드에서 드롭은 샘플 스캔과 같다
  async importDropped() {
    return this.scan();
  }

  async _listChildren(folderEntry) {
    return (folderEntry.source?.children ?? []).map((spec) => ({ name: spec.name, source: spec }));
  }

  // 실제 파일 Provider에는 없는, 샘플 전용 내부 탐색/꺼내기 계약.
  async listContents(folderId) {
    const folder = this._folders.get(folderId);
    if (!folder) throw new Error("폴더를 찾지 못했습니다.");
    const folders = await this.listSubfolders(folderId);
    if (!this.#contentsLoaded.has(folderId)) {
      for (const name of folder.source?.existing ?? []) {
        const item = this._addFile({ id: crypto.randomUUID(), name, size: 0,
          type: "", extension: getExtension(name), file: null, lastModified: 0 });
        this._placement.set(item.id, folderId);
      }
      this.#contentsLoaded.add(folderId);
    }
    return { folders, files: this.files.filter((file) => this._placement.get(file.id) === folderId) };
  }

  async _namesIn(folderId) {
    const { folders, files } = await this.listContents(folderId);
    // 이름 캐시 대신 현재 위치로 재계산: 꺼낸 자리에 다시 넣을 수 있어야 한다.
    return new Set([...folders.map((folder) => folder.name), ...files.map((file) => file.name)]);
  }

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
    const origins = new Map((this._undoLog.get(batchId) ?? []).map((step) => [step.fileId, step.from]));
    const result = await super.undoBatch(batchId);
    for (const move of result.restored) move.restoredFolderId = origins.get(move.fileId) ?? null;
    return result;
  }

  /** 샘플에는 실제 파일이 없다. 미리보기 자리를 채워 손맛을 볼 수 있게 그림을 만들어 준다. */
  async readThumbnail(fileId) {
    const item = this._files.get(fileId)?.item;
    if (!item || !SAMPLE_IMAGE_EXTENSIONS.has(item.extension)) return null;
    if (!this.#thumbnails.has(fileId)) this.#thumbnails.set(fileId, makeSampleImage(item.name));
    return this.#thumbnails.get(fileId);
  }

  async _listNames(folderEntry) {
    const spec = folderEntry.source;
    return new Set([...(spec?.existing ?? []), ...(spec?.children ?? []).map((child) => child.name)]);
  }
}
