/**
 * NativeHelperProvider — Enhanced Desktop Mode. 127.0.0.1에서 도는 Desktop Helper의 클라이언트.
 *
 * 웹은 절대경로를 모른다. Helper가 준 id(`f_…`, `d_…`)로만 말한다. (Helper 설계 §6)
 * 이동은 Helper가 같은 볼륨 rename으로 즉시 끝내고, 되돌리기는 rename 역방향이다.
 * 덮어쓰기 없음, 삭제 없음. 항목별 결과.
 *
 * 연결: Helper가 실행되며 만든 포트와 일회용 토큰을 URL(?helper=PORT&token=…)로 받거나 사용자가 직접 입력한다.
 * 모든 요청에 `Authorization: Bearer <token>`. Helper는 Origin 허용 목록과 토큰을 둘 다 검사한다.
 */
import { FileSystemProvider, ProviderError, emptyImport, folderLabel, getExtension } from "./file-system-provider.js";

const nameCollator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

export class NativeHelperProvider extends FileSystemProvider {
  capabilities = {
    kind: "helper",
    realFiles: true,
    immediateMove: true,
    canCreateFolder: true,
    canWatch: false, // 다음 단계
    canScan: true,
  };

  #base;
  #token;
  #fetch;
  #files = new Map();
  #folders = new Map();
  #folderOrder = [];
  #desktopName = "바탕화면";
  #version = null;

  /**
   * @param {object} options
   * @param {number|string} options.port
   * @param {string} options.token
   * @param {string} [options.host="127.0.0.1"]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({ port, token, host = "127.0.0.1", fetchImpl = globalThis.fetch?.bind(globalThis) }) {
    super();
    this.#base = `http://${host}:${Number(port)}/v1`;
    this.#token = String(token ?? "");
    this.#fetch = fetchImpl;
  }

  get files() {
    return [...this.#files.values()];
  }

  get folders() {
    return this.#folderOrder.map((id) => this.#folders.get(id));
  }

  get desktopName() {
    return this.#desktopName;
  }

  get version() {
    return this.#version;
  }

  async #request(method, route, body, { keepalive = false } = {}) {
    let response;
    try {
      response = await this.#fetch(`${this.#base}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        keepalive, // 페이지가 닫히는 중에도 요청이 살아남게 (bye 전용)
      });
    } catch (error) {
      throw new ProviderError("HELPER_UNREACHABLE", "Desktop Helper에 연결할 수 없습니다. 실행 중인지 확인하세요.", error);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const code = payload?.error?.code ?? (response.status === 401 ? "HELPER_UNAUTHORIZED" : response.status === 403 ? "HELPER_FORBIDDEN" : "HELPER_ERROR");
      const message = payload?.error?.message ?? `Helper 응답 ${response.status}`;
      throw new ProviderError(code, message);
    }
    return payload;
  }

  #registerFolder(raw) {
    const parent = raw.parentId ? this.#folders.get(raw.parentId) : null;
    const item = {
      id: raw.id,
      name: raw.name,
      parentId: raw.parentId ?? null,
      path: parent ? [...parent.path, raw.name] : [raw.name],
      hasChildren: raw.hasChildren ?? null,
      virtual: false,
    };
    if (!this.#folders.has(item.id)) this.#folderOrder.push(item.id);
    this.#folders.set(item.id, item);
    return item;
  }

  #registerFile(raw) {
    const item = {
      id: raw.id,
      name: raw.name,
      size: raw.size ?? 0,
      type: raw.type ?? "",
      lastModified: raw.lastModified ?? 0,
      extension: getExtension(raw.name),
      file: null, // 썸네일은 다음 단계 (Authorization 헤더 때문에 <img src>로는 못 받는다)
    };
    this.#files.set(item.id, item);
    return item;
  }

  /** 핸드셰이크. 토큰과 Origin이 맞으면 Helper 정보가 온다. */
  async connect() {
    const hello = await this.#request("GET", "/hello");
    this.#version = hello.version ?? null;
    this.#desktopName = hello.desktopName ?? this.#desktopName;
    return { version: this.#version, desktopName: this.#desktopName };
  }

  async scan() {
    const payload = await this.#request("GET", "/scan");
    this.#files.clear();
    this.#folders.clear();
    this.#folderOrder = [];
    this.#desktopName = payload.desktop?.name ?? this.#desktopName;
    const result = emptyImport();
    for (const raw of payload.folders ?? []) result.folders.push(this.#registerFolder(raw));
    for (const raw of payload.files ?? []) result.files.push(this.#registerFile(raw));
    result.files.sort((a, b) => nameCollator.compare(a.name, b.name));
    result.skipped = payload.skipped ?? 0;
    if (payload.skippedReparsePoints) result.notes.push(`바로가기·정션 ${payload.skippedReparsePoints}개는 다루지 않습니다.`);
    return result;
  }

  async listSubfolders(folderId) {
    const folder = this.#folders.get(folderId);
    if (!folder) return [];
    const payload = await this.#request("GET", `/folders/${encodeURIComponent(folderId)}/children`);
    const children = (payload.folders ?? []).map((raw) => this.#registerFolder({ ...raw, parentId: folderId }));
    folder.hasChildren = children.length > 0;
    return children;
  }

  async moveBatch(fileIds, folderId, { onItem = () => {} } = {}) {
    const folder = this.#folders.get(folderId);
    if (!folder) {
      return {
        batchId: "",
        folderId,
        moved: [],
        failed: fileIds.map((fileId) => ({ fileId, fileName: this.#files.get(fileId)?.name ?? fileId, code: "FOLDER_UNKNOWN", message: "배송지를 찾지 못했습니다." })),
      };
    }
    for (const fileId of fileIds) onItem(fileId, "moving");
    const payload = await this.#request("POST", "/move", { fileIds, folderId });
    const label = folderLabel(folder.path);
    const result = {
      batchId: payload.batchId,
      folderId,
      moved: (payload.moved ?? []).map((raw) => ({
        moveId: raw.moveId,
        batchId: payload.batchId,
        fileId: raw.fileId,
        folderId,
        fileName: raw.fileName ?? this.#files.get(raw.fileId)?.name ?? raw.fileId,
        folderName: label,
        movedAt: raw.movedAt ?? Date.now(),
      })),
      failed: (payload.failed ?? []).map((raw) => ({
        fileId: raw.fileId,
        fileName: raw.fileName ?? this.#files.get(raw.fileId)?.name ?? raw.fileId,
        code: raw.code ?? "MOVE_FAILED",
        message: raw.message ?? "옮기지 못했습니다.",
      })),
    };
    for (const move of result.moved) onItem(move.fileId, "placed");
    for (const failure of result.failed) onItem(failure.fileId, "failed", new ProviderError(failure.code, failure.message));
    return result;
  }

  async undoBatch(batchId) {
    const payload = await this.#request("POST", "/undo", { batchId });
    return {
      batchId,
      restored: (payload.restored ?? []).map((raw) => ({
        moveId: raw.moveId ?? crypto.randomUUID(),
        batchId,
        fileId: raw.fileId,
        folderId: raw.folderId ?? null,
        fileName: raw.fileName ?? this.#files.get(raw.fileId)?.name ?? raw.fileId,
        folderName: raw.folderId ? folderLabel(this.#folders.get(raw.folderId)?.path ?? []) : "",
        movedAt: raw.movedAt ?? Date.now(),
      })),
      failed: (payload.failed ?? []).map((raw) => ({
        fileId: raw.fileId,
        fileName: raw.fileName ?? this.#files.get(raw.fileId)?.name ?? raw.fileId,
        code: raw.code ?? "UNDO_FAILED",
        message: raw.message ?? "되돌리지 못했습니다.",
      })),
    };
  }

  /**
   * 카드 얼굴에 넣을 이미지. Helper가 이미지 여부와 크기를 검사하고 바이트만 돌려준다.
   * Authorization 헤더가 필요해서 `<img src>`로는 못 받는다. fetch로 받아 Blob으로 넘긴다.
   */
  async readThumbnail(fileId) {
    if (!this.#files.has(fileId)) return null;
    try {
      const response = await this.#fetch(`${this.#base}/files/${encodeURIComponent(fileId)}/content`, {
        headers: { Authorization: `Bearer ${this.#token}` },
      });
      if (!response.ok) return null; // 이미지가 아니거나(415) 너무 크다(413)
      return await response.blob();
    } catch {
      return null;
    }
  }

  async createFolder(parentId, name) {
    const payload = await this.#request("POST", "/folders", { parentId: parentId ?? null, name });
    return this.#registerFolder({ ...payload.folder, parentId: parentId ?? null, hasChildren: false });
  }

  /** 페이지가 닫힐 때 Helper에 작별 인사. 못 닿아도 Helper는 idle 타이머로 스스로 꺼진다. */
  async disconnect() {
    try {
      await this.#request("POST", "/bye", {}, { keepalive: true });
    } catch {
      // 이미 꺼졌거나 페이지가 먼저 사라졌다
    }
  }
}
