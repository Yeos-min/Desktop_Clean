/**
 * SessionStore — 보드의 세션 상태. DOM 없음. 파일 시스템 없음.
 *
 * 카드 상태, 위치, 선택, 배치(더미) 이력, 파동 공급, 배송지 트리와 현재 열린 단계를 담당한다.
 * 파일 작업 결과는 Provider가 돌려준 결과 객체를 받아 반영할 뿐, 직접 실행하지 않는다.
 *
 * 상태 전이:
 *   queued → idle → moving → placed → (undo) idle
 *                          ↘ conflict / error (보드에 남는다, 다시 집을 수 있다)
 *
 * 이동 이력(배치)은 메모리에만 있다. 새로고침하면 사라진다. (§7)
 */
import { LAYOUT_DEFAULTS, placeItems, slotCount } from "../ui/layout.js";

export const SELECTABLE_STATUSES = new Set(["idle", "conflict", "error"]);
export const BOARD_STATUSES = new Set(["idle", "conflict", "error", "moving"]);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export class SessionStore {
  #files = new Map();
  #queue = [];
  #folders = new Map();
  #folderOrder = [];
  #level = null;
  #batches = [];
  #selection = new Set();
  #listeners = new Set();
  #bounds;
  #capacity;
  #refillBelow;
  #layoutConfig;
  #seed;
  /** 겹친 카드 중 누가 위인지. 나중에 놓인 것이 위로 간다. */
  #stackCounter = 0;

  /**
   * @param {object} [options]
   * @param {number} [options.capacity=24]     보드에 동시에 두는 미처리 카드 수 [임시]
   * @param {number} [options.refillBelow=-1]  미처리 카드가 이 수 **이하**가 되면 다음 파동.
   *   -1이면 자동 보충을 하지 않는다 → 책상을 다 치우면 바닥이 드러나고, 다음 무더기는 사용자가 꺼낸다. [임시]
   * @param {{x:number,y:number,width:number,height:number}} [options.bounds]
   * @param {object} [options.layout]          layout.js 설정 덮어쓰기
   * @param {number} [options.seed]
   */
  constructor({
    capacity = 24,
    refillBelow = -1,
    bounds = { x: 0, y: 0, width: 1280, height: 570 },
    layout = {},
    seed,
  } = {}) {
    this.#capacity = capacity;
    this.#refillBelow = refillBelow;
    this.#bounds = { ...bounds };
    this.#layoutConfig = layout;
    this.#seed = seed;
  }

  // ───────────────────────── 구독 ─────────────────────────

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(reason, detail = {}) {
    for (const listener of this.#listeners) listener({ reason, ...detail });
  }

  // ───────────────────────── 조회 ─────────────────────────

  get card() {
    return this.#layoutConfig.card ?? LAYOUT_DEFAULTS.card;
  }

  get bounds() {
    return { ...this.#bounds };
  }

  /** 요청한 정원과 보드 슬롯 수 중 작은 쪽 */
  get capacity() {
    return Math.min(this.#capacity, slotCount(this.#bounds, this.#layoutConfig));
  }

  get files() {
    return [...this.#files.values()];
  }

  get selection() {
    return [...this.#selection];
  }

  get queuedCount() {
    return this.#queue.length;
  }

  get boardEntries() {
    return this.files.filter((entry) => BOARD_STATUSES.has(entry.status));
  }

  get unprocessedCount() {
    return this.boardEntries.length;
  }

  get placedEntries() {
    return this.files.filter((entry) => entry.status === "placed");
  }

  get placedCount() {
    return this.placedEntries.filter((entry) => entry.tracked !== false).length;
  }

  /**
   * 화면에 크게 박는 숫자. 정리 시뮬레이터의 동기는 사실 이것뿐이다.
   * 올라가기만 하고 내려가지 않는다 (되돌리기는 예외).
   */
  get progress() {
    return { done: this.placedCount, total: this.files.filter((entry) => entry.tracked !== false).length };
  }

  get batches() {
    return this.#batches.map((batch) => ({ ...batch, fileIds: [...batch.fileIds] }));
  }

  get lastBatch() {
    const batch = this.#batches.at(-1);
    return batch ? { ...batch, fileIds: [...batch.fileIds] } : null;
  }

  entry(id) {
    return this.#files.get(id) ?? null;
  }

  isSelected(id) {
    return this.#selection.has(id);
  }

  // ───────────────────────── 배송지 트리 ─────────────────────────

  get folders() {
    return this.#folderOrder.map((id) => this.#folders.get(id));
  }

  get rootFolders() {
    return this.folders.filter((folder) => folder.parentId === null);
  }

  folder(id) {
    return this.#folders.get(id) ?? null;
  }

  childrenOf(id) {
    return this.folders.filter((folder) => folder.parentId === id);
  }

  isDescendant(folderId, ancestorId) {
    let current = this.#folders.get(folderId);
    while (current) {
      if (current.parentId === ancestorId) return true;
      current = current.parentId ? this.#folders.get(current.parentId) : null;
    }
    return false;
  }

  folderLabel(id) {
    return this.#folders.get(id)?.path.join(" › ") ?? "";
  }

  setFolders(items) {
    this.#folders.clear();
    this.#folderOrder = [];
    this.#level = null;
    this.addFolders(items);
  }

  addFolders(items) {
    for (const item of items) {
      if (this.#folders.has(item.id)) {
        Object.assign(this.#folders.get(item.id), item);
        continue;
      }
      this.#folders.set(item.id, { ...item, path: [...(item.path ?? [item.name])] });
      this.#folderOrder.push(item.id);
    }
    this.#emit("folders");
  }

  /** 현재 열려 있는 배송지. null이면 루트 줄. */
  get level() {
    return this.#level;
  }

  /**
   * 지금 보이는 상자 줄. 루트면 배송지 전부, 열려 있으면 [← 자기 자신(여기에), ...하위 폴더].
   * 숫자 키는 이 순서에 대응한다.
   */
  get visibleTargets() {
    if (this.#level === null) return this.rootFolders.map((folder) => ({ ...folder, isSelf: false }));
    const parent = this.#folders.get(this.#level);
    if (!parent) return this.rootFolders.map((folder) => ({ ...folder, isSelf: false }));
    return [{ ...parent, isSelf: true }, ...this.childrenOf(this.#level).map((folder) => ({ ...folder, isSelf: false }))];
  }

  /** 숫자 키용. 1부터 센다. */
  folderAt(index) {
    return this.visibleTargets[index - 1] ?? null;
  }

  enterFolder(id) {
    if (!this.#folders.has(id) || this.#level === id) return false;
    this.#level = id;
    this.#emit("level");
    return true;
  }

  /** 한 단계 위로. 루트면 아무것도 안 한다. */
  leaveFolder() {
    if (this.#level === null) return false;
    this.#level = this.#folders.get(this.#level)?.parentId ?? null;
    this.#emit("level");
    return true;
  }

  leaveToRoot() {
    if (this.#level === null) return false;
    this.#level = null;
    this.#emit("level");
    return true;
  }

  placedIn(folderId) {
    return this.placedEntries
      .filter((entry) => entry.folderId === folderId)
      .sort((a, b) => a.movedAt - b.movedAt);
  }

  /** 이 폴더와 그 아래 전부에 옮겨진 항목 */
  placedInTree(folderId) {
    return this.placedEntries
      .filter((entry) => entry.folderId === folderId || this.isDescendant(entry.folderId, folderId))
      .sort((a, b) => a.movedAt - b.movedAt);
  }

  // ───────────────────────── 파일 공급 ─────────────────────────

  /** 폴더 내부의 기존 파일. 탐색만으로 바닥/정리 진행률에 추가하지 않는다. */
  addContainedFiles(items, folderId) {
    for (const item of items) {
      if (this.#files.has(item.id)) continue;
      this.#files.set(item.id, { id: item.id, item, status: "placed", folderId,
        tracked: false, position: null, movedAt: 0, dockIndex: 0, stackSeq: 0 });
    }
    this.#emit("contents");
  }

  applyTakeOutResult(result) {
    const ids = [];
    const trackedBefore = {};
    for (const move of result.moved) {
      const entry = this.entry(move.fileId);
      if (!entry) continue;
      trackedBefore[entry.id] = entry.tracked !== false;
      entry.status = "idle";
      entry.folderId = null;
      entry.tracked = true;
      entry.code = entry.message = entry.stage = null;
      entry.position ??= { x: this.#bounds.x, y: this.#bounds.y, rot: 0 };
      ids.push(entry.id);
    }
    if (ids.length) this.#batches.push({ batchId: result.batchId, folderId: result.folderId, fileIds: ids, trackedBefore });
    this.selectMany(ids);
    this.#emit("take-out");
  }

  addFiles(items) {
    let added = 0;
    for (const item of items) {
      if (this.#files.has(item.id)) continue;
      this.#files.set(item.id, {
        id: item.id,
        item,
        status: "queued",
        position: null,
        group: null,
        folderId: null,
        moveId: null,
        batchId: null,
        movedAt: null,
        stage: null,
        code: null,
        message: null,
        dockIndex: 0,
        stackSeq: 0,
      });
      this.#queue.push(item.id);
      added += 1;
    }
    // 빈 책상에 파일이 들어오면 첫 무더기는 자동으로 꺼낸다. 그 뒤 보충은 refillBelow가 정한다.
    if (this.unprocessedCount === 0) this.supply({ force: true });
    else this.supply();
    this.#emit("files", { added });
    return added;
  }

  #obstacles() {
    const { width, height } = this.card;
    return this.boardEntries
      .filter((entry) => entry.position)
      .map((entry) => ({ x: entry.position.x, y: entry.position.y, width, height, group: entry.group }));
  }

  /**
   * 대기 더미에서 보드로 카드를 꺼낸다.
   * 자동: 미처리 카드가 refillBelow 아래로 내려갔을 때만 capacity까지 채운다.
   * 수동(force): 언제든 최소 1장.
   */
  supply({ force = false, count } = {}) {
    const unprocessed = this.unprocessedCount;
    const capacity = this.capacity;
    let pull;
    if (force) {
      pull = count ?? Math.max(1, capacity - unprocessed);
    } else {
      if (unprocessed > this.#refillBelow) return [];
      pull = capacity - unprocessed;
    }
    pull = Math.min(pull, this.#queue.length);
    if (pull <= 0) return [];

    const candidates = this.#queue.splice(0, pull);
    const placed = placeItems({
      items: candidates.map((id) => this.#files.get(id).item),
      bounds: this.#bounds,
      existing: this.#obstacles(),
      seed: this.#seed,
      config: this.#layoutConfig,
    });
    const ids = [];
    const leftovers = [];
    for (const id of candidates) {
      const spot = placed.get(id);
      if (!spot) {
        leftovers.push(id); // 빈 슬롯이 없다. 더미에 되돌린다
        continue;
      }
      const entry = this.#files.get(id);
      entry.status = "idle";
      entry.position = { x: spot.x, y: spot.y, rot: spot.rot };
      entry.group = spot.group;
      entry.stackSeq = (this.#stackCounter += 1);
      ids.push(id);
    }
    this.#queue.unshift(...leftovers);
    if (ids.length > 0) this.#emit("supply", { ids });
    return ids;
  }

  /** 상자 배치가 바뀌면 보드 카드를 전부 다시 놓는다. 자리가 모자라면 더미로 돌아간다. */
  setBounds(bounds) {
    this.#bounds = { ...bounds };
    const entries = this.boardEntries.filter((entry) => entry.status !== "moving");
    const placed = placeItems({
      items: entries.map((entry) => entry.item),
      bounds: this.#bounds,
      seed: this.#seed,
      config: this.#layoutConfig,
    });
    const leftovers = [];
    for (const entry of entries) {
      const spot = placed.get(entry.id);
      if (!spot) {
        entry.status = "queued";
        entry.position = null;
        entry.group = null;
        this.#selection.delete(entry.id);
        leftovers.push(entry.id);
        continue;
      }
      entry.position = { x: spot.x, y: spot.y, rot: spot.rot };
      entry.group = spot.group;
      entry.stackSeq = (this.#stackCounter += 1);
    }
    this.#queue.unshift(...leftovers);
    this.#emit("layout");
  }

  // ───────────────────────── 선택 ─────────────────────────

  #selectable(id) {
    const entry = this.#files.get(id);
    return Boolean(entry && SELECTABLE_STATUSES.has(entry.status));
  }

  select(id, { additive = false, toggle = false } = {}) {
    if (!this.#selectable(id)) return;
    if (toggle) {
      if (this.#selection.has(id)) this.#selection.delete(id);
      else this.#selection.add(id);
    } else {
      if (!additive) this.#selection.clear();
      this.#selection.add(id);
    }
    this.#emit("selection");
  }

  selectMany(ids, { additive = false } = {}) {
    if (!additive) this.#selection.clear();
    for (const id of ids) if (this.#selectable(id)) this.#selection.add(id);
    this.#emit("selection");
  }

  selectAll() {
    this.selectMany(this.boardEntries.map((entry) => entry.id));
  }

  clearSelection() {
    if (this.#selection.size === 0) return;
    this.#selection.clear();
    this.#emit("selection");
  }

  // ───────────────────────── 위치 ─────────────────────────

  setPositions(list) {
    const { width, height } = this.card;
    const maxX = this.#bounds.x + this.#bounds.width - width;
    const maxY = this.#bounds.y + this.#bounds.height - height;
    for (const { id, x, y } of list) {
      const entry = this.#files.get(id);
      if (!entry || !entry.position) continue;
      entry.position = {
        ...entry.position,
        x: Math.round(clamp(x, this.#bounds.x, maxX)),
        y: Math.round(clamp(y, this.#bounds.y, maxY)),
      };
      // 방금 내려놓은 카드가 맨 위로 온다
      entry.stackSeq = (this.#stackCounter += 1);
    }
    this.#emit("positions");
  }

  // ───────────────────────── 배치 (더미 → 배송지) ─────────────────────────

  /** 카드를 배송지에 넣는 제스처. Provider 호출 전에 상태를 moving으로 바꾼다. */
  beginBatch(fileIds, folderId) {
    const folder = this.folder(folderId);
    if (!folder) return { ids: [], folderId };
    const ids = fileIds.filter((id) => this.#selectable(id));
    ids.forEach((id, index) => {
      const entry = this.#files.get(id);
      entry.status = "moving";
      entry.folderId = folderId;
      entry.dockIndex = index;
      entry.stage = "queued";
      entry.code = null;
      entry.message = null;
      this.#selection.delete(id);
    });
    this.#emit("batch:begin", { ids, folderId });
    return { ids, folderId };
  }

  setItemStage(id, stage) {
    const entry = this.#files.get(id);
    if (!entry) return;
    entry.stage = stage;
    this.#emit("stage", { id, stage });
  }

  /** @param {import("../providers/file-system-provider.js").MoveResult} result */
  applyMoveResult(result) {
    for (const move of result.moved) {
      const entry = this.#files.get(move.fileId);
      if (!entry) continue;
      entry.status = "placed";
      entry.moveId = move.moveId;
      entry.batchId = move.batchId;
      entry.folderId = move.folderId;
      entry.movedAt = move.movedAt;
      entry.stage = null;
      entry.code = null;
      entry.message = null;
    }
    for (const failure of result.failed) {
      const entry = this.#files.get(failure.fileId);
      if (!entry) continue;
      entry.status = failure.code === "DESTINATION_EXISTS" ? "conflict" : "error";
      entry.folderId = null;
      entry.stage = null;
      entry.code = failure.code;
      entry.message = failure.message;
    }
    if (result.moved.length > 0) {
      this.#batches.push({
        batchId: result.batchId,
        folderId: result.folderId,
        fileIds: result.moved.map((move) => move.fileId),
      });
    }
    const supplied = this.supply();
    this.#emit("batch:result", { result, supplied });
  }

  /** @param {import("../providers/file-system-provider.js").UndoResult} result */
  applyUndoResult(result) {
    const trackedBefore = this.#batches.find((batch) => batch.batchId === result.batchId)?.trackedBefore;
    for (const move of result.restored) {
      const entry = this.#files.get(move.fileId);
      if (!entry) continue;
      entry.status = "idle";
      entry.moveId = null;
      entry.batchId = null;
      entry.folderId = null;
      entry.movedAt = null;
      entry.code = null;
      entry.message = null;
      this.#selection.delete(entry.id);
      if (trackedBefore && entry.id in trackedBefore) entry.tracked = trackedBefore[entry.id];
      if (move.restoredFolderId != null) {
        entry.status = "placed";
        entry.folderId = move.restoredFolderId;
      }
    }
    for (const failure of result.failed) {
      const entry = this.#files.get(failure.fileId);
      if (!entry) continue;
      entry.code = failure.code;
      entry.message = failure.message;
    }
    const restoredIds = new Set(result.restored.map((move) => move.fileId));
    this.#batches = this.#batches
      .map((batch) =>
        batch.batchId === result.batchId
          ? { ...batch, fileIds: batch.fileIds.filter((id) => !restoredIds.has(id)) }
          : batch,
      )
      .filter((batch) => batch.fileIds.length > 0);
    this.#emit("undo", { result });
  }

  /** 정리 요약: 폴더별로 옮긴 파일 이름 */
  get summary() {
    const byFolder = new Map();
    for (const entry of this.placedEntries) {
      if (entry.tracked === false) continue;
      const label = this.folderLabel(entry.folderId);
      if (!byFolder.has(label)) byFolder.set(label, []);
      byFolder.get(label).push(entry.item.name);
    }
    return [...byFolder.entries()].map(([folder, names]) => ({ folder, names }));
  }
}
