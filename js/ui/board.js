/**
 * Board — 2D 장면. 카드, 배송지 상자, 남은 더미, 선택, 마퀴, 더미 드래그, 상태 연출.
 *
 * 파일 시스템을 모른다. SessionStore를 읽어 DOM을 맞추고(keyed sync), 제스처를 콜백으로 올린다.
 * 어떤 Provider인지도 모른다. `labels`로 문구만 받는다.
 * 좌표계는 논리 단위(1280×720)이고 컨테이너 폭에 맞춰 CSS scale로 줄인다.
 *
 * 배송지 열기: 상자 위에 더미를 올려 두거나(스프링 폴더) 클릭하면 그 줄이 [← 여기에, ...하위 폴더]로 바뀐다.
 *
 * 아래 수치는 전부 [임시] 검증 대상이다. 1단계에서 이 파일만 Three.js 장면으로 바꾼다.
 */
import { SELECTABLE_STATUSES } from "../state/session-store.js";
import {
  BOARD_SIZE,
  BOX_ZONE,
  STAGE_LABEL,
  familyClass,
  formatSize,
  playBoundsFor,
  truncateMiddle,
} from "./board-layout.js";

export { BOARD_SIZE, BOX_ZONE, formatSize, playBoundsFor, truncateMiddle };

const DRAG_THRESHOLD = 4;
const SPRING_OPEN_MS = 650; // 더미를 상자 위에 이만큼 두면 열린다 [임시]
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"]);

export class Board {
  #root;
  #store;
  #labels;
  #board;
  #playArea;
  #cardsLayer;
  #boxZone;
  #boxRow;
  #breadcrumb;
  #pile;
  #marquee;
  #tiltHint;
  #boxes = new Map();
  #cards = new Map();
  #objectUrls = new Map();
  #placement = "bottom";
  #tilted = false;
  #scale = 1;
  #drag = null;
  #marqueeState = null;
  #boxPress = null;
  #onDropToFolder;
  #onPullWave;
  #onOpenFolder;
  #onLeaveFolder;
  #unsubscribe;
  #resizeObserver;
  #cardTemplate;
  #boxTemplate;

  constructor({ root, store, labels = { verb: "옮김" }, onDropToFolder, onPullWave, onOpenFolder, onLeaveFolder }) {
    this.#root = root;
    this.#store = store;
    this.#labels = labels;
    this.#onDropToFolder = onDropToFolder;
    this.#onPullWave = onPullWave;
    this.#onOpenFolder = onOpenFolder;
    this.#onLeaveFolder = onLeaveFolder;
    this.#cardTemplate = document.querySelector("#card-template");
    this.#boxTemplate = document.querySelector("#box-template");
    this.#build();
    this.#bindPointer();
    this.#resizeObserver = new ResizeObserver(() => this.#fit());
    this.#resizeObserver.observe(root);
    this.#unsubscribe = store.subscribe((event) => this.sync(event));
    this.sync();
  }

  get placement() {
    return this.#placement;
  }

  get tilted() {
    return this.#tilted;
  }

  /** 3D 보드와 같은 모양의 카메라 API. 2D에서는 사선 미리보기 토글이 전부다. */
  get cameraPresets() {
    return [
      { id: "flat", label: "평면" },
      { id: "tilt", label: "사선 미리보기" },
    ];
  }

  setCamera(id) {
    this.setTilt(id === "tilt");
  }

  destroy() {
    this.#unsubscribe?.();
    this.#resizeObserver?.disconnect();
    for (const url of this.#objectUrls.values()) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
  }

  // ───────────────────────── DOM ─────────────────────────

  #build() {
    this.#root.classList.add("board-viewport");
    this.#board = document.createElement("div");
    this.#board.className = "board";
    this.#board.style.width = `${BOARD_SIZE.width}px`;
    this.#board.style.height = `${BOARD_SIZE.height}px`;

    this.#playArea = document.createElement("div");
    this.#playArea.className = "play-area";

    this.#cardsLayer = document.createElement("div");
    this.#cardsLayer.className = "cards-layer";

    this.#boxZone = document.createElement("div");
    this.#boxZone.className = "box-zone";

    this.#breadcrumb = document.createElement("div");
    this.#breadcrumb.className = "breadcrumb";

    this.#boxRow = document.createElement("div");
    this.#boxRow.className = "box-row";

    this.#pile = document.createElement("button");
    this.#pile.type = "button";
    this.#pile.className = "pile";
    this.#pile.innerHTML = '<span class="pile-stack" aria-hidden="true"></span><strong class="pile-count">0</strong><small class="pile-label"></small>';

    this.#marquee = document.createElement("div");
    this.#marquee.className = "marquee";
    this.#marquee.hidden = true;

    this.#tiltHint = document.createElement("div");
    this.#tiltHint.className = "tilt-hint";
    this.#tiltHint.textContent = "사선 미리보기 — 가독성만 봅니다. 조작은 탑다운에서.";
    this.#tiltHint.hidden = true;

    this.#boxZone.append(this.#pile, this.#breadcrumb, this.#boxRow);
    this.#board.append(this.#playArea, this.#cardsLayer, this.#boxZone, this.#marquee);
    this.#applyPlacement();
    // 보드를 붙이기 전에 scale을 정한다. 붙인 뒤 바꾸면 transform 전환이 애니메이션된다.
    this.#fit();
    this.#root.replaceChildren(this.#board, this.#tiltHint);
  }

  #applyPlacement() {
    this.#board.dataset.placement = this.#placement;
    this.#boxZone.dataset.placement = this.#placement;
  }

  #fit() {
    const width = this.#root.clientWidth || BOARD_SIZE.width;
    this.#scale = width / BOARD_SIZE.width;
    this.#root.style.setProperty("--scale", this.#scale);
    this.#root.style.height = `${Math.round(BOARD_SIZE.height * this.#scale)}px`;
  }

  setPlacement(placement) {
    if (placement === this.#placement) return;
    this.#placement = placement;
    this.#applyPlacement();
    this.#store.setBounds(playBoundsFor(placement));
    this.sync();
  }

  setTilt(on) {
    this.#tilted = Boolean(on);
    this.#root.classList.toggle("is-tilted", this.#tilted);
    this.#tiltHint.hidden = !this.#tilted;
    if (this.#tilted) this.#cancelGestures();
  }

  // ───────────────────────── 좌표 ─────────────────────────

  #toLogical(clientX, clientY) {
    const rect = this.#board.getBoundingClientRect();
    const scale = rect.width / BOARD_SIZE.width || this.#scale;
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  }

  /** transform과 무관한 offset 좌표로 상자의 논리 위치를 구한다 */
  #elementRect(element) {
    let x = 0;
    let y = 0;
    let node = element;
    while (node && node !== this.#board) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent;
    }
    return { x, y, width: element.offsetWidth, height: element.offsetHeight };
  }

  #boxAt(point) {
    for (const [, box] of this.#boxes) {
      const rect = this.#elementRect(box);
      if (
        point.x >= rect.x &&
        point.x <= rect.x + rect.width &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.height
      ) {
        return box.dataset.folderId;
      }
    }
    return null;
  }

  #boxElement(folderId) {
    return this.#boxes.get(folderId) ?? this.#boxes.get(`self:${folderId}`) ?? null;
  }

  /** 이 폴더 또는 가장 가까운 보이는 조상의 상자 */
  #visibleBoxFor(folderId) {
    let id = folderId;
    while (id) {
      const box = this.#boxElement(id);
      if (box) return box;
      id = this.#store.folder(id)?.parentId ?? null;
    }
    return null;
  }

  #pileCenter() {
    const rect = this.#elementRect(this.#pile);
    const { width, height } = this.#store.card;
    return { x: rect.x + rect.width / 2 - width / 2, y: rect.y + rect.height / 2 - height / 2 };
  }

  /** 옮기는 중인 카드가 상자 가장자리에 붙어 있는 자리 (§12 "손에 붙어 있는 연출") */
  #dockPosition(folderId, index) {
    const box = this.#visibleBoxFor(folderId);
    const { width, height } = this.#store.card;
    if (!box) return null;
    const rect = this.#elementRect(box);
    const column = index % 3;
    const row = Math.floor(index / 3);
    if (this.#placement === "right") {
      return {
        x: rect.x - width * 0.78 - row * 10,
        y: rect.y + rect.height / 2 - height / 2 + (column - 1) * 10,
      };
    }
    return {
      x: rect.x + rect.width / 2 - width / 2 + (column - 1) * 8,
      y: rect.y - height * 0.72 - row * 10,
    };
  }

  /** 옮겨진 카드가 상자 안에 쌓이는 자리 */
  #trayPosition(folderId, index) {
    const box = this.#visibleBoxFor(folderId);
    const { width, height } = this.#store.card;
    if (!box) return null;
    const rect = this.#elementRect(box);
    const slot = index % 5;
    return {
      x: rect.x + (rect.width - width * 0.5) / 2 + (slot - 2) * 6,
      y: rect.y + rect.height - height * 0.5 - 14 - slot * 3,
    };
  }

  // ───────────────────────── 동기화 ─────────────────────────

  sync(event) {
    this.#syncBoxes();
    this.#syncCards({ unboxing: event?.reason === "supply" });
    this.#syncPile();
  }

  #syncBoxes() {
    const store = this.#store;
    const targets = store.visibleTargets;
    const level = store.level;
    const seen = new Set();

    this.#breadcrumb.textContent =
      level === null
        ? targets.length
          ? "배송지 · 상자를 클릭하거나 더미를 올려 두면 안이 열립니다"
          : "배송지가 없습니다 · 위의 '새 폴더'로 만드세요"
        : `${store.folderLabel(level)} · Esc 뒤로`;
    this.#breadcrumb.dataset.level = level === null ? "root" : "inner";

    targets.forEach((target, index) => {
      const key = target.isSelf ? `self:${target.id}` : target.id;
      seen.add(key);
      let box = this.#boxes.get(key);
      if (!box) {
        box = this.#boxTemplate.content.firstElementChild.cloneNode(true);
        this.#boxes.set(key, box);
      }
      this.#boxRow.append(box); // 보이는 순서대로 다시 붙인다 (숫자 키 순서와 같다)
      box.dataset.folderId = target.id;
      box.classList.toggle("is-self", Boolean(target.isSelf));
      box.classList.toggle("is-virtual", Boolean(target.virtual));
      box.querySelector(".box-key").textContent = index + 1;
      box.querySelector(".box-name").textContent = target.isSelf ? `← ${target.name}` : target.name;
      box.querySelector(".box-name").title = store.folderLabel(target.id);
      const count = store.placedInTree(target.id).length;
      const countLabel = box.querySelector(".box-count");
      if (target.isSelf) countLabel.textContent = count ? `여기에 바로 넣기 · ${count}개 ${this.#labels.verb}` : "여기에 바로 넣기 · 클릭하면 닫힘";
      else countLabel.textContent = count ? `${count}개 ${this.#labels.verb}` : target.virtual ? "새 폴더" : "비어 있음";
      box.dataset.count = count;
      const hint = box.querySelector(".box-hint");
      hint.hidden = Boolean(target.isSelf) || target.hasChildren === false;
      hint.textContent = target.hasChildren === null ? "열기 ▸" : "칸 ▸";
    });

    for (const [key, box] of this.#boxes) {
      if (!seen.has(key)) {
        box.remove();
        this.#boxes.delete(key);
      }
    }
  }

  #syncCards({ unboxing = false } = {}) {
    const store = this.#store;
    const seen = new Set();
    const dragIds = this.#drag?.ids ?? new Set();
    const trayIndex = new Map();
    for (const folder of store.folders) {
      store.placedIn(folder.id).forEach((entry, index) => trayIndex.set(entry.id, index));
    }
    const pileCenter = unboxing ? this.#pileCenter() : null;
    let fresh = 0;

    for (const entry of store.files) {
      if (entry.status === "queued") continue;
      seen.add(entry.id);
      let card = this.#cards.get(entry.id);
      if (!card) {
        card = this.#createCard(entry);
        this.#cardsLayer.append(card);
        this.#cards.set(entry.id, card);
        if (pileCenter && entry.status === "idle") {
          // 더미에서 쏟아져 나오는 연출: 더미 자리에서 시작해 제자리로 간다
          this.#setTransform(card, pileCenter.x, pileCenter.y, 0, 0.4);
          card.style.transitionDelay = `${Math.min(fresh, 20) * 28}ms`;
          void card.offsetWidth;
          fresh += 1;
          card.addEventListener("transitionend", () => (card.style.transitionDelay = ""), { once: true });
        }
      }
      this.#updateCard(card, entry, { skipPosition: dragIds.has(entry.id), trayIndex: trayIndex.get(entry.id) ?? 0 });
    }

    for (const [id, card] of this.#cards) {
      if (seen.has(id)) continue;
      card.remove();
      this.#cards.delete(id);
      const url = this.#objectUrls.get(id);
      if (url) {
        URL.revokeObjectURL(url);
        this.#objectUrls.delete(id);
      }
    }
  }

  #syncPile() {
    const store = this.#store;
    const queued = store.queuedCount;
    const count = this.#pile.querySelector(".pile-count");
    const label = this.#pile.querySelector(".pile-label");
    if (queued > 0) {
      this.#pile.dataset.state = "full";
      count.textContent = queued;
      label.textContent = "남은 파일 · 클릭해서 꺼내기";
      this.#pile.disabled = false;
    } else {
      this.#pile.dataset.state = "empty";
      count.textContent = "0";
      label.textContent = store.unprocessedCount > 0 ? "다 꺼냈음" : "책상이 비었음";
      this.#pile.disabled = true;
    }
    this.#pile.style.setProperty("--depth", Math.min(6, Math.ceil(queued / 4)));
  }

  #createCard(entry) {
    const card = this.#cardTemplate.content.firstElementChild.cloneNode(true);
    const { item } = entry;
    card.dataset.id = entry.id;
    card.dataset.family = familyClass(item.extension);
    card.style.width = `${this.#store.card.width}px`;
    card.style.height = `${this.#store.card.height}px`;

    const glyph = card.querySelector(".card-glyph");
    const ext = card.querySelector(".card-ext");
    if (item.file && IMAGE_EXTENSIONS.has(item.extension)) {
      try {
        const url = URL.createObjectURL(item.file);
        this.#objectUrls.set(entry.id, url);
        const image = document.createElement("img");
        image.src = url;
        image.alt = "";
        image.loading = "lazy";
        image.draggable = false;
        glyph.replaceChildren(image);
      } catch {
        ext.textContent = item.extension ? item.extension.toUpperCase() : "FILE";
      }
    } else {
      ext.textContent = item.extension ? item.extension.toUpperCase().slice(0, 5) : "FILE";
    }

    const name = card.querySelector(".card-name");
    name.textContent = truncateMiddle(item.name);
    name.title = item.name;
    card.querySelector(".card-meta").textContent = `${formatSize(item.size)} · ${item.extension ? item.extension.toUpperCase() : "확장자 없음"}`;
    return card;
  }

  #updateCard(card, entry, { skipPosition, trayIndex }) {
    card.dataset.status = entry.status;
    card.classList.toggle("is-selected", this.#store.isSelected(entry.id));

    const badge = card.querySelector(".card-badge");
    if (entry.status === "conflict") {
      badge.textContent = "동명 파일 있음";
      badge.dataset.tone = "error";
      badge.hidden = false;
    } else if (entry.status === "error") {
      badge.textContent = entry.code === "LOCKED" ? "사용 중인 파일" : entry.code === "CROSS_VOLUME" ? "다른 드라이브" : "옮기지 못함";
      badge.dataset.tone = "warn";
      badge.hidden = false;
    } else if (entry.status === "placed" && entry.message) {
      badge.textContent = "확인 필요";
      badge.dataset.tone = "warn";
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
    card.title = entry.message ? `${entry.item.name}\n${entry.message}` : entry.item.name;

    const ring = card.querySelector(".card-ring");
    ring.dataset.label = entry.status === "moving" ? STAGE_LABEL[entry.stage] ?? "옮기는 중" : "";

    if (skipPosition) return;

    let spot = null;
    let rot = entry.position?.rot ?? 0;
    let scale = 1;
    if (entry.status === "moving") {
      spot = this.#dockPosition(entry.folderId, entry.dockIndex);
      rot = 0;
      scale = 0.92;
    } else if (entry.status === "placed") {
      spot = this.#trayPosition(entry.folderId, trayIndex);
      rot = trayIndex % 2 ? 3 : -3;
      scale = 0.5;
    } else {
      spot = { x: entry.position?.x ?? 0, y: entry.position?.y ?? 0 };
    }
    if (!spot) return; // 보이는 상자가 없다 (다른 배송지가 열려 있음). 지금 자리에 둔다.
    this.#setTransform(card, spot.x, spot.y, rot, scale);
  }

  #setTransform(card, x, y, rot, scale) {
    card.style.setProperty("--x", `${x}px`);
    card.style.setProperty("--y", `${y}px`);
    card.style.setProperty("--r", `${rot}deg`);
    card.style.setProperty("--s", scale);
  }

  // ───────────────────────── 포인터 ─────────────────────────

  #bindPointer() {
    this.#board.addEventListener("pointerdown", (event) => this.#onPointerDown(event));
    this.#board.addEventListener("pointermove", (event) => this.#onPointerMove(event));
    this.#board.addEventListener("pointerup", (event) => this.#onPointerUp(event));
    this.#board.addEventListener("pointercancel", () => this.#cancelGestures());
    this.#board.addEventListener("dragstart", (event) => event.preventDefault());
    this.#pile.addEventListener("click", () => this.#onPullWave?.());
  }

  #capture(pointerId) {
    try {
      this.#board.setPointerCapture(pointerId);
    } catch {
      // 이미 끝난 포인터이거나 합성 이벤트. 캡처 없이도 보드 안에서는 동작한다.
    }
  }

  #release(pointerId) {
    try {
      this.#board.releasePointerCapture(pointerId);
    } catch {
      // 캡처가 없었다.
    }
  }

  #clearSpring() {
    if (this.#drag?.springTimer) {
      clearTimeout(this.#drag.springTimer);
      this.#drag.springTimer = null;
    }
  }

  #cancelGestures() {
    if (this.#drag) {
      this.#clearSpring();
      for (const id of this.#drag.ids) this.#cards.get(id)?.classList.remove("is-dragging");
      this.#drag = null;
      this.#clearTarget();
      this.sync();
    }
    if (this.#marqueeState) {
      this.#marqueeState = null;
      this.#marquee.hidden = true;
      for (const card of this.#cards.values()) card.classList.remove("is-marquee-hit");
    }
    this.#boxPress = null;
  }

  #onPointerDown(event) {
    if (this.#tilted || event.button !== 0) return;
    if (event.target.closest(".pile")) return;

    const boxElement = event.target.closest(".box");
    if (boxElement) {
      this.#boxPress = { pointerId: event.pointerId, folderId: boxElement.dataset.folderId, isSelf: boxElement.classList.contains("is-self") };
      return;
    }

    const point = this.#toLogical(event.clientX, event.clientY);
    const cardElement = event.target.closest(".card");
    const store = this.#store;

    if (cardElement) {
      const id = cardElement.dataset.id;
      const entry = store.entry(id);
      if (!entry || !SELECTABLE_STATUSES.has(entry.status)) return;
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      let pendingDeselect = null;
      if (!store.isSelected(id)) {
        store.select(id, { additive });
      } else if (additive) {
        pendingDeselect = id;
      }
      const ids = new Set(store.selection);
      ids.add(id);
      const origin = new Map();
      for (const selectedId of ids) {
        const selected = store.entry(selectedId);
        if (selected?.position) origin.set(selectedId, { x: selected.position.x, y: selected.position.y });
      }
      this.#drag = { pointerId: event.pointerId, start: point, ids, origin, moved: false, targetFolder: null, springTimer: null, pendingDeselect };
      this.#capture(event.pointerId);
      event.preventDefault();
      return;
    }

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    this.#marqueeState = { pointerId: event.pointerId, start: point, current: point, additive, moved: false };
    this.#capture(event.pointerId);
    event.preventDefault();
  }

  #onPointerMove(event) {
    const point = this.#toLogical(event.clientX, event.clientY);

    if (this.#drag && event.pointerId === this.#drag.pointerId) {
      const drag = this.#drag;
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.moved = true;
        drag.pendingDeselect = null;
        let z = 0;
        for (const id of drag.ids) {
          const card = this.#cards.get(id);
          if (!card) continue;
          card.classList.add("is-dragging");
          card.style.zIndex = 100 + z;
          z += 1;
        }
      }
      for (const [id, origin] of drag.origin) {
        const card = this.#cards.get(id);
        const entry = this.#store.entry(id);
        if (!card || !entry) continue;
        this.#setTransform(card, origin.x + dx, origin.y + dy, entry.position?.rot ?? 0, 1.03);
      }
      const target = this.#boxAt(point);
      if (target !== drag.targetFolder) {
        this.#clearTarget();
        this.#clearSpring();
        drag.targetFolder = target;
        if (target) {
          const box = this.#boxElement(target);
          box?.classList.add("is-target");
          const isSelf = box?.classList.contains("is-self");
          const folder = this.#store.folder(target);
          if (!isSelf && folder && folder.hasChildren !== false) {
            drag.springTimer = setTimeout(() => {
              drag.springTimer = null;
              if (this.#drag === drag && drag.targetFolder === target) this.#onOpenFolder?.(target);
            }, SPRING_OPEN_MS);
          }
        }
      }
      return;
    }

    if (this.#marqueeState && event.pointerId === this.#marqueeState.pointerId) {
      const state = this.#marqueeState;
      state.current = point;
      if (!state.moved && Math.hypot(point.x - state.start.x, point.y - state.start.y) < DRAG_THRESHOLD) return;
      state.moved = true;
      const rect = this.#marqueeRect(state);
      this.#marquee.hidden = false;
      this.#marquee.style.left = `${rect.x}px`;
      this.#marquee.style.top = `${rect.y}px`;
      this.#marquee.style.width = `${rect.width}px`;
      this.#marquee.style.height = `${rect.height}px`;
      const hits = new Set(this.#cardsIn(rect));
      for (const [id, card] of this.#cards) card.classList.toggle("is-marquee-hit", hits.has(id));
    }
  }

  #onPointerUp(event) {
    const point = this.#toLogical(event.clientX, event.clientY);

    if (this.#boxPress && event.pointerId === this.#boxPress.pointerId) {
      const press = this.#boxPress;
      this.#boxPress = null;
      const boxElement = event.target.closest(".box");
      if (boxElement && boxElement.dataset.folderId === press.folderId) {
        if (press.isSelf) this.#onLeaveFolder?.();
        else this.#onOpenFolder?.(press.folderId);
      }
      return;
    }

    if (this.#drag && event.pointerId === this.#drag.pointerId) {
      const drag = this.#drag;
      this.#drag = null;
      this.#clearSpring();
      this.#release(event.pointerId);
      this.#clearTarget();
      for (const id of drag.ids) {
        const card = this.#cards.get(id);
        card?.classList.remove("is-dragging");
        if (card) card.style.zIndex = "";
      }

      if (!drag.moved) {
        if (drag.pendingDeselect) this.#store.select(drag.pendingDeselect, { toggle: true });
        this.sync();
        return;
      }

      const target = this.#boxAt(point);
      if (target) {
        this.sync(); // 실패하면 원래 자리로 튕겨 돌아가야 하므로 위치는 그대로 둔다
        this.#onDropToFolder?.([...drag.ids], target);
        return;
      }

      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      this.#store.setPositions([...drag.origin].map(([id, origin]) => ({ id, x: origin.x + dx, y: origin.y + dy })));
      return;
    }

    if (this.#marqueeState && event.pointerId === this.#marqueeState.pointerId) {
      const state = this.#marqueeState;
      this.#marqueeState = null;
      this.#release(event.pointerId);
      this.#marquee.hidden = true;
      for (const card of this.#cards.values()) card.classList.remove("is-marquee-hit");
      if (!state.moved) {
        if (!state.additive) this.#store.clearSelection();
        return;
      }
      const ids = this.#cardsIn(this.#marqueeRect(state));
      if (ids.length === 0 && !state.additive) {
        this.#store.clearSelection();
        return;
      }
      this.#store.selectMany(ids, { additive: state.additive });
    }
  }

  #clearTarget() {
    for (const box of this.#boxes.values()) box.classList.remove("is-target");
  }

  #marqueeRect(state = this.#marqueeState) {
    const { start, current } = state;
    return {
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      width: Math.abs(current.x - start.x),
      height: Math.abs(current.y - start.y),
    };
  }

  #cardsIn(rect) {
    const { width, height } = this.#store.card;
    const ids = [];
    for (const entry of this.#store.boardEntries) {
      if (!SELECTABLE_STATUSES.has(entry.status) || !entry.position) continue;
      const { x, y } = entry.position;
      if (x < rect.x + rect.width && rect.x < x + width && y < rect.y + rect.height && rect.y < y + height) {
        ids.push(entry.id);
      }
    }
    return ids;
  }
}
