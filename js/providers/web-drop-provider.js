/**
 * WebDropProvider — 기본 Web Mode. 설치 없음, 확인창 없음, 디스크 무변경.
 *
 * 사용자가 바탕화면에서 Ctrl+A 후 브라우저에 드롭한 항목을 받는다.
 * - 파일 → 카드. `getFile()`로 크기·수정 시각·썸네일용 Blob을 읽는다 (읽기는 드롭으로 이미 허용됨).
 * - 폴더 → 배송지. 하위 폴더는 한 단계씩만 연다. 재귀하지 않는다. (§9)
 * - 이동은 가상이다. 폴더 안의 실제 이름을 읽어 동명 충돌은 진짜처럼 판정한다.
 * - 쓰기 API(createWritable, remove, removeEntry)는 절대 부르지 않는다.
 *
 * 왜 읽기 전용인가: 드롭 핸들의 쓰기 권한은 파일마다 확인창이 뜬다 (18개 → 18번, 실기기 확인 2026-09-02).
 * 실제 반영은 NativeHelperProvider가 한다.
 */
import { describeFileHandle, resolveDroppedHandles } from "../file-system-service.js";
import { emptyImport, getExtension } from "./file-system-provider.js";
import { VirtualMoveProvider } from "./virtual-move-provider.js";

const nameCollator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

async function handlesMatch(first, second) {
  try {
    return await first.isSameEntry(second);
  } catch {
    return first.kind === second.kind && first.name === second.name;
  }
}

export class WebDropProvider extends VirtualMoveProvider {
  #contentsLoaded = new Set();

  capabilities = {
    kind: "web",
    realFiles: false,
    immediateMove: true,
    canCreateFolder: true, // 가상 폴더
    canWatch: false,
    canScan: false,
  };

  static isSupported(globalObject = globalThis) {
    const w = globalObject;
    return Boolean(
      w.isSecureContext && typeof w.DataTransferItem === "function" && "getAsFileSystemHandle" in w.DataTransferItem.prototype,
    );
  }

  async #hasHandle(entries, candidate) {
    for (const entry of entries) {
      if (entry.source && (await handlesMatch(entry.source, candidate))) return true;
    }
    return false;
  }

  /** @param {Iterable<FileSystemHandle>} handles */
  async importHandles(handles) {
    const result = emptyImport();
    const files = [];
    for (const handle of Array.from(handles ?? []).filter(Boolean)) {
      try {
        if (handle.kind === "file") {
          if (await this.#hasHandle(this._files.values(), handle)) {
            result.skipped += 1;
            continue;
          }
          const described = await describeFileHandle(handle);
          files.push(
            this._addFile(
              {
                id: described.id,
                name: described.name,
                size: described.size,
                type: described.type,
                lastModified: described.lastModified,
                extension: getExtension(described.name),
                file: described.file,
              },
              handle,
            ),
          );
        } else if (handle.kind === "directory") {
          const roots = this._folderOrder.map((id) => this._folders.get(id)).filter((entry) => entry.item.parentId === null);
          if (await this.#hasHandle(roots, handle)) {
            result.skipped += 1;
            continue;
          }
          result.folders.push(this._addFolder({ name: handle.name, parentId: null }, handle));
        } else {
          result.skipped += 1;
        }
      } catch {
        result.skipped += 1;
      }
    }
    files.sort((a, b) => nameCollator.compare(a.name, b.name));
    result.files = files;
    return result;
  }

  async importDropped(items) {
    const { handles, failedCount } = await resolveDroppedHandles(items);
    const result = await this.importHandles(handles);
    result.unresolved = failedCount;
    if (failedCount > 0) result.notes.push(`${failedCount}개 항목은 브라우저가 핸들을 주지 않아 건너뜀 (휴지통·내 PC 같은 가상 항목)`);
    return result;
  }

  /** 열어 본 폴더의 바로 아래 파일만 읽는다. 하위 폴더는 재귀 탐색하지 않는다. */
  async listContents(folderId) {
    const folder = this._folders.get(folderId);
    if (!folder) throw new Error("폴더를 찾지 못했습니다.");
    const folders = await this.listSubfolders(folderId);
    if (!this.#contentsLoaded.has(folderId)) {
      if (folder.source) {
        for await (const [, handle] of folder.source.entries()) {
          if (handle.kind !== "file") continue;
          // 재시도 또는 별도로 드롭한 동일 파일을 중복 등록하지 않는다.
          if (await this.#hasHandle(this._files.values(), handle)) continue;
          const described = await describeFileHandle(handle);
          const item = this._addFile({ ...described, extension: getExtension(described.name) }, handle);
          this._placement.set(item.id, folderId);
        }
      }
      this.#contentsLoaded.add(folderId);
    }
    return { folders, files: this.files.filter((file) => this._placement.get(file.id) === folderId) };
  }

  async _namesIn(folderId) {
    const { folders, files } = await this.listContents(folderId);
    return new Set([...folders.map((folder) => folder.name), ...files.map((file) => file.name)]);
  }

  async _listChildren(folderEntry) {
    if (!folderEntry.source) return [];
    const children = [];
    for await (const [, child] of folderEntry.source.entries()) {
      if (child.kind === "directory") children.push({ name: child.name, source: child });
    }
    return children;
  }

  async _listNames(folderEntry) {
    if (!folderEntry.source) return new Set();
    const names = new Set();
    for await (const [name] of folderEntry.source.entries()) names.add(name);
    return names;
  }
}
