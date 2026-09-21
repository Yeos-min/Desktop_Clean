/**
 * File System Access API 핸들의 가짜 구현. tests/file-system-service.test.js의 것과 같은 동작이며,
 * 기존 테스트 파일을 건드리지 않기 위해 별도 모듈로 둔다. 디렉터리 순회, resolve, 폴더 remove()를 더했다.
 *
 * 이 파일이 흉내 내는 것은 API 형태뿐이다. 실제 Windows에서의 동작 근거가 아니다. (CLAUDE.md §3)
 */

export function domError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

export class FakeFileHandle {
  constructor(name, bytes, options = {}) {
    this.kind = "file";
    this.name = name;
    this.bytes = Uint8Array.from(bytes);
    this.lastModified = options.lastModified ?? 10;
    this.corruptWrites = options.corruptWrites ?? false;
    this.ownPermission = options.permission ?? null; // null이면 부모에서 상속 (Chromium과 같다)
    this.requestResult = options.requestResult ?? null; // 프롬프트에서 사용자가 고를 답
    this.permissionRequests = 0;
    this.removed = false;
    this.parent = options.parent ?? null;
    if (options.removeUnsupported) this.remove = undefined;
  }

  get permission() {
    return this.ownPermission ?? this.parent?.permission ?? "granted";
  }

  set permission(value) {
    this.ownPermission = value;
  }

  async isSameEntry(other) {
    return other === this;
  }

  async queryPermission() {
    return this.permission;
  }

  async requestPermission() {
    this.permissionRequests += 1;
    this.permission = this.requestResult ?? this.permission;
    return this.permission;
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
    this.parent?.entriesMap.delete(this.name);
  }
}

export class FakeDirectoryHandle {
  constructor(name, { corruptNewFiles = false, permission = null, requestResult = null, parent = null } = {}) {
    this.kind = "directory";
    this.name = name;
    this.entriesMap = new Map();
    this.corruptNewFiles = corruptNewFiles;
    this.ownPermission = permission; // null이면 부모에서 상속. 루트는 granted
    this.requestResult = requestResult;
    this.permissionRequests = 0;
    this.removeEntryCalls = [];
    this.removeCalls = [];
    this.removed = false;
    this.parent = parent;
  }

  get permission() {
    return this.ownPermission ?? this.parent?.permission ?? "granted";
  }

  set permission(value) {
    this.ownPermission = value;
  }

  async isSameEntry(other) {
    return other === this;
  }

  async queryPermission() {
    return this.permission;
  }

  async requestPermission() {
    this.permissionRequests += 1;
    this.permission = this.requestResult ?? this.permission;
    return this.permission;
  }

  /** 자식 파일. 권한은 부모에서 그때그때 상속된다 (실제 Chromium과 같다) */
  addFile(name, bytes, options = {}) {
    const handle = new FakeFileHandle(name, bytes, { ...options, parent: this });
    this.entriesMap.set(name, handle);
    return handle;
  }

  addDirectory(name, options = {}) {
    const handle = new FakeDirectoryHandle(name, { ...options, parent: this });
    this.entriesMap.set(name, handle);
    return handle;
  }

  async getFileHandle(name, options = {}) {
    const entry = this.entriesMap.get(name);
    if (entry) {
      if (entry.kind !== "file") throw domError("TypeMismatchError");
      return entry;
    }
    if (!options.create) throw domError("NotFoundError");
    return this.addFile(name, [], { corruptWrites: this.corruptNewFiles });
  }

  async getDirectoryHandle(name, options = {}) {
    const entry = this.entriesMap.get(name);
    if (entry) {
      if (entry.kind !== "directory") throw domError("TypeMismatchError");
      return entry;
    }
    if (!options.create) throw domError("NotFoundError");
    return this.addDirectory(name);
  }

  async *entries() {
    for (const [name, handle] of this.entriesMap) yield [name, handle];
  }

  /** other가 이 디렉터리 아래에 있으면 경로 이름 배열, 자기 자신이면 [], 아니면 null */
  async resolve(other) {
    if (other === this) return [];
    for (const [name, handle] of this.entriesMap) {
      if (handle === other) return [name];
      if (handle.kind === "directory") {
        const nested = await handle.resolve(other);
        if (nested) return [name, ...nested];
      }
    }
    return null;
  }

  async removeEntry(name) {
    this.removeEntryCalls.push(name);
    if (!this.entriesMap.has(name)) throw domError("NotFoundError");
    this.entriesMap.delete(name);
  }

  async remove(options = {}) {
    this.removeCalls.push({ ...options });
    if (this.entriesMap.size > 0 && !options.recursive) throw domError("InvalidModificationError");
    this.removed = true;
    this.parent?.entriesMap.delete(this.name);
  }
}

/** IndexedDB 대신 쓰는 메모리 핸들 저장소 */
export function createMemoryHandleStore(initial = null) {
  let saved = initial;
  return {
    saves: 0,
    get saved() {
      return saved;
    },
    async saveWorkspaceHandles(payload) {
      this.saves += 1;
      saved = { ...payload, savedAt: Date.now() };
    },
    async loadWorkspaceHandles() {
      return saved;
    },
  };
}
