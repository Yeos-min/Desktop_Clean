/**
 * board-3d.js — 3D 장면. 2D Board와 **같은 인터페이스**를 구현한다.
 *
 *   new Board3D({ root, store, labels, onDropToFolder, onPullWave, onOpenFolder, onLeaveFolder })
 *   .setPlacement(placement) / .cameraPresets / .setCamera(id) / .destroy()
 *
 * 파일 시스템도, 어떤 Provider인지도 모른다. SessionStore를 읽어 오브젝트를 맞추고 제스처를 콜백으로 올린다.
 * 숫자는 전부 tuning.js에 있다. 모델 교체는 assets.js 한 곳이다.
 */
import { SELECTABLE_STATUSES } from "../state/session-store.js";
import {
  BOARD_SIZE,
  STAGE_LABEL,
  boxZoneFor,
  familyClass,
  formatSize,
  playBoundsFor,
} from "../ui/board-layout.js";
import { BoxObject } from "./box-object.js";
import { CardObject, disposeSharedCardGeometry } from "./card-object.js";
import { stackHeights } from "./stacking.js";
import { CSS2DObject, SceneKit, THREE, toLogical, toWorld, toWorldSize } from "./scene-kit.js";
import { TUNING } from "./tuning.js";
import { BoxPlacementState, rotateBox, supportsBox, validateBoxPlacement } from "./box-placement.js";
import { FolderShelfAssignments, folderShelfSlots } from "./folder-shelves.js";
import { PointerLockState } from "./pointer-lock-state.js";
import { movementKey } from "./walk-collision.js";

/**
 * 한 줄에 count개를 넣는다. 넘치면 간격을 줄이고, 그래도 넘치면 크기를 줄인다.
 * 폴더가 늘어나도 상자가 보드 밖으로 나가지 않게 하는 것이 목적이다.
 */
function fitRow(available, count, preferred, preferredGap, minimum) {
  if (count <= 0) return { size: preferred, gap: preferredGap, offset: 0 };
  let gap = preferredGap;
  let size = preferred;
  if (count * size + (count - 1) * gap > available) {
    gap = Math.max(6, (available - count * size) / Math.max(1, count - 1));
  }
  if (count * size + (count - 1) * gap > available) {
    size = Math.max(minimum, (available - (count - 1) * gap) / count);
  }
  const total = count * size + (count - 1) * gap;
  return { size, gap, offset: Math.max(0, (available - total) / 2) };
}

/** 상자 띠 안에서 상자와 더미가 놓이는 자리 (논리 좌표) */
function boxSlots(placement, count) {
  const zone = boxZoneFor(placement);
  if (placement === "right") {
    const top = zone.y + 30;
    const available = zone.height - 30 - 140; // 아래쪽은 더미 자리
    const { size: depth, gap, offset } = fitRow(available, count, 100, 18, 56);
    return {
      size: { width: 260, depth },
      slots: Array.from({ length: count }, (_, index) => ({
        cx: zone.x + zone.width / 2,
        cy: top + offset + depth / 2 + index * (depth + gap),
      })),
      pile: { cx: zone.x + zone.width / 2, cy: zone.y + zone.height - 72 },
    };
  }
  const rowLeft = zone.x + 240; // 왼쪽은 더미 자리
  const available = zone.width - 240 - 40;
  const { size: width, gap, offset } = fitRow(available, count, 200, 18, 108);
  return {
    size: { width, depth: 112 },
    slots: Array.from({ length: count }, (_, index) => ({
      cx: rowLeft + offset + width / 2 + index * (width + gap),
      cy: zone.y + zone.height / 2,
    })),
    pile: { cx: zone.x + 182, cy: zone.y + zone.height / 2 },
  };
}

export class Board3D {
  #root;
  #store;
  #labels;
  #kit;
  #cards = new Map();
  #boxes = new Map();
  #pile;
  #pileCards = [];
  #overlay;
  #breadcrumb;
  #marquee;
  #hoverLabel;
  #hoverAnchor;
  #drag = null;
  #marqueeState = null;
  #pressed = null;
  #look = null;
  #pointerLock = new PointerLockState(() => this.#updateLockUi());
  get #locked() { return this.#pointerLock.locked; }
  #suspended = false;
  get #lockDenied() { return this.#pointerLock.denied; }
  #gathering = false;
  #crosshair;
  #lockPrompt;
  #handHint;
  #keys = new Set();
  #onKeyDown = null;
  #onKeyUp = null;
  #onBlur = null;
  #onLockChange = null;
  #onLockError = null;
  #hoveredCardId = null;
  #onDropToFolder;
  #onPullWave;
  #onOpenFolder;
  #onLeaveFolder;
  #loadThumbnail;
  #unsubscribe;
  #resizeObserver;
  #placement = "bottom";
  #pendingSpill = new Set();
  #spillIndex = 0;
  #arranging = false;
  #boxPlacement = new BoxPlacementState();
  #heldBox = null;
  #boxGhost = null;
  #boxCandidate = null;
  #boxPointer = null;
  #shelfSlots = [];
  #shelfObstacles = [];
  #shelfAssignments = new FolderShelfAssignments();
  #shelfPage = 0;
  #shelfPager;
  #shownTargets = [];
  #arrangeHint;

  constructor({ root, store, labels = { verb: "옮김" }, onDropToFolder, onPullWave, onOpenFolder, onLeaveFolder, loadThumbnail = null }) {
    this.#root = root;
    this.#store = store;
    this.#labels = labels;
    this.#onDropToFolder = onDropToFolder;
    this.#onPullWave = onPullWave;
    this.#onOpenFolder = onOpenFolder;
    this.#onLeaveFolder = onLeaveFolder;
    this.#loadThumbnail = loadThumbnail;

    root.classList.add("board-viewport", "is-3d");
    root.replaceChildren();
    this.#kit = new SceneKit(root);
    this.#buildOverlay();
    this.#buildPile();
    this.#bindPointer();
    this.#bindKeys();
    if (this.#kit.isWalking) this.setPlacement("far");
    this.#overlay.dataset.walking = String(this.#kit.isWalking);
    this.#updateLockUi();

    this.#resizeObserver = new ResizeObserver(() => this.#kit.resize());
    this.#resizeObserver.observe(root);
    this.#kit.resize();

    this.#unsubscribe = store.subscribe((event) => this.#onStoreEvent(event));
    this.sync();
    this.#kit.start((dt) => this.#frame(dt));

    // 콘솔에서 손맛을 만지고 장면을 들여다볼 수 있게. 자동 테스트도 이걸 쓴다.
    if (typeof window !== "undefined") {
      window.__tuning = TUNING;
      window.__board = this;
    }
  }

  /**
   * 프레임 하나를 손으로 돌린다. 평소에는 렌더 루프가 부르지만,
   * 배경 탭에서는 requestAnimationFrame이 멈추므로 테스트가 이걸로 장면을 전진시킨다.
   */
  tick(dt = 1 / 60) {
    this.#kit.step(dt);
    this.#frame(dt);
  }

  /** 모든 오브젝트를 목표 자리에 즉시 붙인다. 애니메이션을 기다리지 않을 때. */
  snap() {
    for (let i = 0; i < 90; i += 1) this.#frame(1 / 60);
  }

  /** 카드의 현재 화면 좌표(px, 뷰포트 기준). 콘솔 디버그와 테스트용. */
  screenPositionOf(cardId) {
    const card = this.#cards.get(cardId);
    if (!card) return null;
    const screen = this.#kit.toScreen(card.position);
    const rect = this.#kit.renderer.domElement.getBoundingClientRect();
    return { x: screen.x + rect.left, y: screen.y + rect.top, behind: screen.behind };
  }

  /** 아직 안 꺼낸 더미의 현재 화면 좌표. */
  screenPositionOfPile() {
    const point = this.#pile.position.clone().setY(0.18);
    const screen = this.#kit.toScreen(point);
    const rect = this.#kit.renderer.domElement.getBoundingClientRect();
    return { x: screen.x + rect.left, y: screen.y + rect.top, behind: screen.behind };
  }

  /** 상자의 현재 화면 좌표. */
  screenPositionOfFolder(folderId) {
    const box = this.#boxes.get(folderId) ?? this.#boxes.get(`self:${folderId}`);
    if (!box) return null;
    const point = box.group.position.clone().add(new THREE.Vector3(0, TUNING.box.height * 0.5, 0));
    const screen = this.#kit.toScreen(point);
    const rect = this.#kit.renderer.domElement.getBoundingClientRect();
    return { x: screen.x + rect.left, y: screen.y + rect.top, behind: screen.behind };
  }

  get tilted() {
    return false; // 3D에는 2D의 사선 미리보기가 필요 없다. 카메라 프리셋이 대신한다.
  }

  get cameraPresets() {
    return this.#kit.cameraPresets;
  }

  get walking() {
    return this.#kit.isWalking;
  }

  /** 마우스가 시점에 붙어 있는가 (포인터 락) */
  get locked() {
    return this.#locked;
  }

  setSuspended(value) {
    this.#suspended = value;
    this.#keys.clear();
    this.#gathering = false;
    this.#pushMoveInput();
    if (value && document.pointerLockElement) document.exitPointerLock();
    this.#updateLockUi();
  }

  get placement() {
    return this.#placement;
  }

  get arranging() { return this.#arranging; }
  get canUndoArrangement() { return !!this.#boxPlacement.lastMove; }
  folderAt(number) { return this.#shownTargets[number - 1] ?? null; }

  setArranging(value) {
    if (this.#drag || this.#marqueeState || this.#suspended) return false;
    this.cancelBoxPlacement();
    this.#arranging = value;
    this.#gathering = false;
    this.#pressed = null;
    this.#setHovered(null);
    this.#arrangeHint.hidden = !value;
    this.#root.dataset.arranging = String(value);
    this.#updateHandHint();
    this.#arrangeHint.textContent = "상자 배치 모드 · 좌클릭 집기 / 놓기 · 휠 회전 · 우클릭·Esc 취소 · Ctrl+Z 되돌리기";
    for (const box of this.#boxes.values()) box.setTargeted(false);
    this.#root.dispatchEvent(new Event("arrangementchange"));
    return true;
  }

  cancelBoxPlacement() {
    if (this.#boxGhost) {
      this.#boxGhost.geometry.dispose();
      this.#boxGhost.material.dispose();
      this.#boxGhost.removeFromParent();
    }
    this.#heldBox = this.#boxGhost = this.#boxCandidate = null;
    this.sync();
    if (this.#arrangeHint) this.#arrangeHint.textContent = "상자 배치 모드 · 상자를 클릭해 집으세요 · Tab 파일 정리 모드";
    this.#root.dispatchEvent(new Event("arrangementchange"));
  }

  undoBoxPlacement() {
    this.cancelBoxPlacement();
    const move = this.#boxPlacement.lastMove;
    if (move && ![...this.#boxes.values()].some(box => box.id === move.folderId)) {
      this.#arrangeHint.textContent = "해당 상자가 있는 폴더/수납 구역에서 되돌려 주세요";
      return;
    }
    const error = this.#boxPlacement.undo(this.#placementContext(move?.from));
    this.sync();
    this.#arrangeHint.textContent = error ?? "상자 위치를 되돌렸습니다";
    this.#root.dispatchEvent(new Event("arrangementchange"));
  }

  #placementContext(pose) {
    const half = this.#kit.roomHalf;
    const pad = TUNING.room.wallThickness / 2 + 0.12;
    const support = !pose?.supportId && this.#shelfSlots.find((slot) =>
      Math.abs(slot.y - pose?.y) < 0.01 && Math.abs(slot.x - pose.x) < 0.01 && Math.abs(slot.z - pose.z) < 0.01);
    return {
      bounds: { minX: -half.x + pad, maxX: half.x - pad, minZ: -half.z + pad, maxZ: half.z - pad },
      support,
      maxHeight: TUNING.room.wallHeight - 0.2,
      obstacles: [...this.#kit.roomObstacles, ...this.#shelfObstacles.filter(obstacle => obstacle.slotId !== support?.slotId)],
      boxes: [...this.#boxes.values()].map((box) => ({ folderId: box.id, x: box.group.position.x,
        y: box.group.position.y, height: TUNING.box.height,
        supportId: this.#boxPlacement.get(box.id)?.supportId,
        z: box.group.position.z, width: box.width * box.group.scale.x, depth: box.depth, yaw: box.group.rotation.y })),
    };
  }

  #previewBox(event) {
    if (!this.#heldBox || this.#suspended) return;
    const aim = this.#aim(event);
    const point = this.#kit.worldAt(aim.x, aim.y, 0);
    // 빈 수납칸도 상자 부피에 조준할 수 있다. 바닥 평면만 쓰면 앞면을 겨눠도 벽 뒤로 투영된다.
    const slots = this.#shelfSlots.map(spot => {
      const matrix = new THREE.Matrix4().makeRotationY(spot.yaw);
      matrix.setPosition(spot.x, spot.y, spot.z);
      const ray = this.#kit.raycaster.ray.clone().applyMatrix4(matrix.clone().invert());
      const hit = ray.intersectBox(new THREE.Box3(
        new THREE.Vector3(-spot.width / 2, 0, -spot.depth / 2),
        new THREE.Vector3(spot.width / 2, TUNING.box.height, spot.depth / 2),
      ), new THREE.Vector3());
      return hit ? { spot, distance: hit.applyMatrix4(matrix).distanceTo(this.#kit.raycaster.ray.origin) } : null;
    }).filter(Boolean).sort((a, b) => a.distance - b.distance);
    const hit = this.#kit.pick(aim.x, aim.y, this.#hitTargets());
    const base = hit && [...this.#boxes.values()].find(box => box.id === hit.object.userData.folderId);
    const slot = slots[0]?.spot;
    const pose = point || slot || base ? { x: Math.round((point?.x ?? 0) * 10) / 10, z: Math.round((point?.z ?? 0) * 10) / 10, y: 0,
      width: this.#heldBox.from.width, depth: this.#heldBox.from.depth, height: TUNING.box.height, yaw: this.#heldBox.yaw } : null;
    if (pose && slot) Object.assign(pose, { x: slot.x, z: slot.z, y: slot.y });
    if (pose && base && (!slot || hit.distance <= slots[0].distance + 0.05)) {
      Object.assign(pose, { x: base.group.position.x, z: base.group.position.z,
        y: base.group.position.y + TUNING.box.height, supportId: base.id });
    }
    const error = validateBoxPlacement(pose, { ...this.#placementContext(pose), folderId: this.#heldBox.id });
    this.#boxCandidate = { pose, error };
    this.#boxGhost.visible = !!pose;
    if (pose) this.#boxGhost.position.set(pose.x, pose.y + TUNING.box.height / 2, pose.z);
    this.#boxGhost.rotation.y = this.#heldBox.yaw;
    this.#boxGhost.material.color.set(error ? "#d77563" : "#83bc79");
    const degrees = Math.round(this.#heldBox.yaw * 180 / Math.PI) % 360;
    this.#arrangeHint.textContent = `${this.#store.folder(this.#heldBox.id)?.name ?? "상자"} · ${degrees}° · 휠 회전 · ${error ?? (pose.supportId ? "좌클릭으로 상자 위에 쌓기" : "좌클릭으로 놓기")} · 우클릭·Esc 취소`;
  }

  #arrangePointerDown(event) {
    this.#boxPointer = { clientX: event.clientX, clientY: event.clientY };
    event.preventDefault();
    if (this.walking && !this.#aiming) { if (event.button === 0) this.#requestLock(); return; }
    if (event.button === 2 && this.#heldBox) { this.cancelBoxPlacement(); return; }
    if (event.button === 2 && this.#lockDenied) {
      this.#look = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      this.#capture(event);
      return;
    }
    if (event.button !== 0) return;
    if (this.#heldBox) {
      this.#previewBox(event);
      const candidate = this.#boxCandidate;
      if (!candidate || candidate.error) return;
      const error = this.#boxPlacement.commit(this.#heldBox.id, this.#heldBox.from, candidate.pose, this.#placementContext(candidate.pose));
      if (!error) this.cancelBoxPlacement();
      return;
    }
    const pick = this.#pickAt(event);
    if (pick.kind !== "box") return;
    const box = this.#boxes.get(pick.id) ?? this.#boxes.get(`self:${pick.id}`);
    if (this.#boxPlacement.supports(box.id) || supportsBox(box.id, this.#placementContext().boxes)) {
      this.#arrangeHint.textContent = "위에 놓인 상자를 먼저 옮겨 주세요";
      return;
    }
    const from = { x: box.group.position.x, y: box.group.position.y, z: box.group.position.z,
      height: TUNING.box.height, supportId: this.#boxPlacement.get(box.id)?.supportId,
      width: box.width * box.group.scale.x, depth: box.depth, yaw: box.group.rotation.y };
    this.#heldBox = { id: box.id, from, yaw: from.yaw, wheelDelta: 0 };
    this.#boxGhost = new THREE.Mesh(new THREE.BoxGeometry(from.width, TUNING.box.height, from.depth),
      new THREE.MeshBasicMaterial({ color: "#83bc79", transparent: true, opacity: 0.48, depthWrite: false }));
    this.#kit.world.add(this.#boxGhost);
    this.sync();
    this.#previewBox(event);
  }

  setCamera(id) {
    this.cancelBoxPlacement();
    this.#kit.setCameraPreset(id);
    this.#keys.clear();
    this.#gathering = false;
    this.#kit.setMoveInput({ forward: 0, strafe: 0, sprint: false });
    if (!this.#kit.isWalking && document.pointerLockElement) document.exitPointerLock?.();
    this.#updateLockUi();
    // 1인칭에서는 폴더가 앞에 있어야 한다. 발밑에 두면 넘겨다보게 된다.
    this.setPlacement(this.#kit.isWalking ? "far" : "bottom");
    this.#overlay.dataset.walking = String(this.#kit.isWalking);
    this.sync();
  }

  setPlacement(placement) {
    if (placement === this.#placement) return;
    this.#placement = placement;
    this.#kit.setPlacement(placement);
    this.#store.setBounds(playBoundsFor(placement));
    this.sync();
  }

  destroy() {
    this.cancelBoxPlacement();
    this.#unsubscribe?.();
    this.#resizeObserver?.disconnect();
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("keyup", this.#onKeyUp);
    window.removeEventListener("blur", this.#onBlur);
    document.removeEventListener("pointerlockchange", this.#onLockChange);
    document.removeEventListener("pointerlockerror", this.#onLockError);
    if (document.pointerLockElement === this.#kit.renderer.domElement) document.exitPointerLock?.();
    for (const card of this.#cards.values()) card.dispose();
    for (const box of this.#boxes.values()) box.dispose();
    this.#cards.clear();
    this.#boxes.clear();
    disposeSharedCardGeometry();
    this.#kit.dispose();
    this.#overlay.remove();
  }

  // ───────────────────────── DOM 덧판 ─────────────────────────

  #buildOverlay() {
    this.#overlay = document.createElement("div");
    this.#overlay.className = "board-overlay";

    this.#breadcrumb = document.createElement("div");
    this.#breadcrumb.className = "breadcrumb";

    this.#marquee = document.createElement("div");
    this.#marquee.className = "marquee";
    this.#marquee.hidden = true;

    this.#hoverLabel = document.createElement("div");
    this.#hoverLabel.className = "hover-label";
    this.#hoverLabel.hidden = true;

    // 1인칭에서는 커서가 사라지므로 조준선이 커서를 대신한다
    this.#crosshair = document.createElement("div");
    this.#crosshair.className = "crosshair";
    this.#crosshair.hidden = true;

    // 포인터 락은 사용자 제스처로만 켤 수 있다. Esc로 풀리면 다시 이 안내가 뜬다.
    this.#lockPrompt = document.createElement("button");
    this.#lockPrompt.type = "button";
    this.#lockPrompt.className = "lock-prompt";
    this.#lockPrompt.innerHTML = "<strong>방 둘러보기</strong><small>클릭해서 시작 · WASD 이동 · Esc 커서</small>";
    this.#lockPrompt.hidden = true;
    this.#lockPrompt.addEventListener("click", () => this.#requestLock());

    this.#handHint = document.createElement("div");
    this.#handHint.className = "hand-hint";
    this.#handHint.hidden = true;
    this.#arrangeHint = document.createElement("div");
    this.#arrangeHint.className = "arrange-hint";
    this.#arrangeHint.setAttribute("role", "status");
    this.#arrangeHint.hidden = true;

    this.#shelfPager = document.createElement("div");
    this.#shelfPager.className = "shelf-pager";

    this.#overlay.append(this.#breadcrumb, this.#marquee, this.#hoverLabel, this.#crosshair, this.#lockPrompt, this.#handHint, this.#arrangeHint, this.#shelfPager);
    this.#root.append(this.#overlay);
  }

  #buildPile() {
    this.#pile = new THREE.Group();
    const { width, height } = this.#store.card;
    this.pileCardSize = { w: toWorldSize(width) * 0.86, d: toWorldSize(height) * 0.86 };
    this.#kit.world.add(this.#pile);

    this.pileHit = new THREE.Mesh(
      new THREE.BoxGeometry(this.pileCardSize.w * 1.2, 0.7, this.pileCardSize.d * 1.2),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.pileHit.position.y = 0.3;
    this.pileHit.userData.pile = true;
    this.#pile.add(this.pileHit);

    this.pileLabelElement = document.createElement("div");
    this.pileLabelElement.className = "pile-label-3d";
    this.pileLabelObject = new CSS2DObject(this.pileLabelElement);
    this.pileLabelObject.position.set(0, 0.5, 0);
    this.#pile.add(this.pileLabelObject);

    this.pileMaterial = new THREE.MeshStandardMaterial({ color: TUNING.card.faceColor, roughness: 0.85, metalness: 0.02 });
    this.pileGeometry = new THREE.BoxGeometry(this.pileCardSize.w, TUNING.card.thickness, this.pileCardSize.d);
  }

  // ───────────────────────── 스토어 → 장면 ─────────────────────────

  #onStoreEvent(event) {
    if (event.reason === "supply" && Array.isArray(event.ids)) {
      this.#spillIndex = 0;
      for (const id of event.ids) this.#pendingSpill.add(id);
    }
    this.sync();

    // 몇 개가 들어갔는지 상자 위에 떠올린다. 결과를 기록 패널까지 안 가도 알 수 있게.
    if (event.reason === "batch:result" && event.result) {
      const { folderId, moved, failed } = event.result;
      if (moved.length) this.#popCount(folderId, `+${moved.length}`, "good");
      if (failed.length) this.#popCount(folderId, `막힘 ${failed.length}`, "bad", moved.length ? 30 : 0);
    }
    if (event.reason === "undo" && event.result?.restored.length) {
      // 되돌린 카드가 있던 상자 위에 띄운다. 어댑터가 폴더를 안 알려 주면 화면 가운데.
      const from = event.result.restored.find((move) => move.folderId && this.#store.folder(move.folderId));
      this.#popCount(from?.folderId ?? null, `↩ ${event.result.restored.length}`, "undo");
    }
  }

  /** 상자 위로 떠오르며 사라지는 숫자 */
  #popCount(folderId, text, tone, offsetY = 0) {
    const box = folderId ? (this.#boxes.get(folderId) ?? this.#boxes.get(`self:${folderId}`)) : null;
    const anchor = box
      ? box.group.position.clone().setY(TUNING.box.height + 0.55)
      : new THREE.Vector3(0, 0.6, 0);
    const screen = this.#kit.toScreen(anchor);
    if (screen.behind) return;
    const element = document.createElement("div");
    element.className = "count-pop";
    element.dataset.tone = tone;
    element.textContent = text;
    element.style.left = `${screen.x}px`;
    element.style.top = `${screen.y + offsetY}px`;
    element.style.animationDuration = `${TUNING.popup.riseMs}ms`;
    element.addEventListener("animationend", () => element.remove(), { once: true });
    this.#overlay.append(element);
  }

  sync() {
    this.#syncBoxes();
    this.#syncCards();
    this.#syncPile();
    this.#syncBreadcrumb();
  }

  #syncBoxes() {
    const store = this.#store;
    let targets = store.visibleTargets;
    const { size, slots } = boxSlots(this.#placement, targets.length);
    const seen = new Set();

    const shelf = this.walking && this.#placement === "far";
    const available = folderShelfSlots(this.#kit.roomHalf, this.#kit.roomObstacles, TUNING.room.shelfY, TUNING.box.height);
    const customPoses = new Map(targets.map(target => [target.id, this.#boxPlacement.get(target.id)]).filter(([, pose]) => pose));
    const assigned = this.#shelfAssignments.assign(targets.map(target => target.id), available, customPoses);
    const pages = Math.max(1, Math.ceil((Math.max(-1, ...assigned.values()) + 1) / available.length));
    this.#shelfPage = Math.min(this.#shelfPage, pages - 1);
    if (shelf) targets = targets.filter(target => Math.floor(assigned.get(target.id) / available.length) === this.#shelfPage);
    this.#shownTargets = targets;
    this.#shelfPager.hidden = !shelf || pages === 1;
    const pageSignature = `${this.#shelfPage}:${pages}`;
    if (this.#shelfPager.dataset.page !== pageSignature) {
      this.#shelfPager.dataset.page = pageSignature;
      const label = document.createElement("span");
      label.textContent = `수납 구역 ${this.#shelfPage + 1} / ${pages}`;
      const button = (text, delta) => {
        const el = document.createElement("button"); el.textContent = text; el.type = "button";
        el.disabled = this.#shelfPage + delta < 0 || this.#shelfPage + delta >= pages;
        el.addEventListener("click", () => { this.cancelBoxPlacement(); this.#shelfPage += delta; this.sync(); });
        return el;
      };
      this.#shelfPager.replaceChildren(button("이전 구역", -1), label, button("다음 구역", 1));
    }
    const shelfSlots = shelf ? targets.map(target => available[assigned.get(target.id) % available.length]) : [];
    // 두 번째 단만 사용하더라도 아래 칸의 가구가 받쳐 준다.
    for (const slot of [...shelfSlots]) {
      const lower = available.find(candidate => candidate.x === slot.x && candidate.z === slot.z && candidate.y < slot.y);
      if (lower && !shelfSlots.includes(lower)) shelfSlots.push(lower);
    }
    this.#shelfSlots = shelfSlots;
    this.#shelfObstacles = shelfSlots.map(slot => ({ ...slot, width: slot.width + 0.2, depth: slot.depth + 0.32,
      y: slot.y - 0.12, height: slot.height + 0.37 }));
    targets.forEach((target, index) => {
      const key = target.isSelf ? `self:${target.id}` : target.id;
      seen.add(key);
      const custom = this.#boxPlacement.get(target.id);
      const home = shelf ? available[assigned.get(target.id) % available.length] : null;
      const width = home?.width ?? toWorldSize(size.width);
      const depth = custom?.depth ?? home?.depth ?? toWorldSize(size.depth);
      let box = this.#boxes.get(key);
      if (box && Math.abs(box.depth - depth) > 0.001) { box.dispose(); box = null; }
      if (!box) {
        box = new BoxObject(THREE, {
          id: target.id,
          width,
          depth,
        });
        this.#kit.world.add(box.group);
        this.#boxes.set(key, box);
      }
      box.id = target.id;
      box.group.userData.folderId = target.id;
      box.catcher.userData.folderId = target.id;
      box.setWidth(custom?.width ?? width);
      const count = store.placedInTree(target.id).length;
      box.setInfo({
        index: index + 1,
        name: target.name,
        subtitle: target.isSelf
          ? count
            ? `여기에 바로 · ${count}개 ${this.#labels.verb}`
            : "여기에 바로 넣기"
          : count
            ? `${count}개 ${this.#labels.verb}`
            : target.virtual
              ? "새 폴더"
              : "비어 있음",
        isSelf: Boolean(target.isSelf),
        virtual: Boolean(target.virtual),
        canOpen: !target.isSelf && target.hasChildren !== false,
        fullPath: store.folderLabel(target.id),
      });
      const spot = home ?? toWorld(slots[index].cx, slots[index].cy);
      box.place(custom?.x ?? spot.x, custom?.z ?? spot.z, custom?.y ?? home?.y ?? 0);
      box.group.rotation.y = custom?.yaw ?? home?.yaw ?? 0;
      box.group.visible = this.#heldBox?.id !== box.id;
    });

    for (const [key, box] of this.#boxes) {
      if (seen.has(key)) continue;
      box.dispose();
      this.#boxes.delete(key);
    }
    this.#kit.setFolderShelf(shelfSlots);
    this.#kit.setWalkObstacles([...this.#kit.roomObstacles, ...this.#shelfObstacles,
      ...this.#placementContext().boxes.filter(box => box.folderId !== this.#heldBox?.id)]);
  }

  /**
   * 책상에 놓인 카드들의 높이. 겹치면 아래 카드 위에 얹힌다.
   *
   * 두께가 파일마다 다르므로 "한 장 = 일정 높이"로 계산할 수 없다. 아래에 깔린 카드의
   * 실제 윗면을 찾아 그 위에 올린다. 나중에 놓인 카드가 위로 간다 (stackSeq).
   * 손에 들고 있는 카드는 공중에 있으므로 빼고 계산한다 — 집어 올리면 밑의 카드가 내려앉는다.
   */
  #restHeights() {
    const dragging = this.#drag?.ids;
    const resting = this.#store.boardEntries
      .filter((entry) => entry.position && entry.status !== "moving" && !dragging?.has(entry.id))
      .sort((a, b) => (a.stackSeq ?? 0) - (b.stackSeq ?? 0))
      .map((entry) => ({ id: entry.id, x: entry.position.x, y: entry.position.y, size: entry.item.size }));
    return stackHeights(resting, this.#store.card);
  }

  /** 이 폴더 또는 가장 가까운 보이는 조상의 상자 */
  #visibleBoxFor(folderId) {
    let id = folderId;
    while (id) {
      const box = this.#boxes.get(id) ?? this.#boxes.get(`self:${id}`);
      if (box) return box;
      id = this.#store.folder(id)?.parentId ?? null;
    }
    return null;
  }

  #syncCards() {
    const store = this.#store;
    const seen = new Set();
    const cardWorld = { w: toWorldSize(store.card.width), d: toWorldSize(store.card.height) };
    const trayIndex = new Map();
    for (const folder of store.folders) {
      store.placedIn(folder.id).forEach((entry, index) => trayIndex.set(entry.id, index));
    }
    const pilePosition = this.#pile.position;
    const restHeights = this.#restHeights();

    for (const entry of store.files) {
      if (entry.status === "queued") continue;
      seen.add(entry.id);
      let card = this.#cards.get(entry.id);
      if (!card) {
        card = new CardObject(THREE, {
          id: entry.id,
          item: { ...entry.item, family: familyClass(entry.item.extension) },
          width: cardWorld.w,
          depth: cardWorld.d,
          loadThumbnail: this.#loadThumbnail,
        });
        this.#kit.world.add(card.group);
        this.#cards.set(entry.id, card);
        if (this.#pendingSpill.has(entry.id)) {
          card.spillFrom({ x: pilePosition.x, z: pilePosition.z }, this.#spillIndex * TUNING.supplyStagger);
          this.#spillIndex += 1;
        } else if (entry.position) {
          const spot = toWorld(entry.position.x + store.card.width / 2, entry.position.y + store.card.height / 2);
          card.place({ x: spot.x, z: spot.z, spin: (entry.position.rot * Math.PI) / 180 });
        }
        this.#pendingSpill.delete(entry.id);
      }
      this.#applyCardTarget(card, entry, trayIndex.get(entry.id) ?? 0, restHeights.get(entry.id) ?? 0);
    }

    for (const [id, card] of this.#cards) {
      if (seen.has(id)) continue;
      card.dispose();
      this.#cards.delete(id);
      if (this.#hoveredCardId === id) this.#hoveredCardId = null;
    }
  }

  #applyCardTarget(card, entry, trayIndex, restHeight = 0) {
    const store = this.#store;
    card.group.visible = true;
    const previous = card.status;
    card.setStatus(entry.status);
    card.setSelected(store.isSelected(entry.id));
    if (previous !== "conflict" && entry.status === "conflict") card.reject();

    if (this.#drag?.ids.has(entry.id)) return; // 손에 들려 있다

    if (entry.status === "moving" || entry.status === "placed") {
      const box = this.#visibleBoxFor(entry.folderId);
      if (!box || this.#heldBox?.id === box.id) { card.group.visible = false; return; }
      const spot = entry.status === "moving" ? box.dockPosition(entry.dockIndex) : box.slotPosition(trayIndex);
      card.spring = TUNING.card.spring;
      card.follow = 1;
      card.setTarget({
        x: spot.x,
        y: spot.y,
        z: spot.z,
        spin: box.group.rotation.y + (entry.status === "placed" ? (trayIndex % 2 ? 0.06 : -0.06) : 0),
        scale: entry.status === "placed" ? TUNING.card.placedScale : 0.94,
      });
      return;
    }

    if (!entry.position) return;
    const spot = toWorld(entry.position.x + store.card.width / 2, entry.position.y + store.card.height / 2);
    const hovered = this.#hoveredCardId === entry.id;
    card.spring = TUNING.card.spring;
    card.follow = 1;
    card.setTarget({
      x: spot.x,
      y: restHeight + (hovered ? TUNING.card.hoverHeight : TUNING.card.restHeight),
      z: spot.z,
      spin: (entry.position.rot * Math.PI) / 180,
      scale: 1,
    });
  }

  #syncPile() {
    const store = this.#store;
    const { pile } = boxSlots(this.#placement, store.visibleTargets.length);
    const spot = toWorld(pile.cx, pile.cy);
    this.#pile.position.set(spot.x, 0, spot.z);

    const queued = store.queuedCount;
    const visible = Math.min(TUNING.pile.maxVisible, queued);
    while (this.#pileCards.length < visible) {
      const card = new THREE.Mesh(this.pileGeometry, this.pileMaterial);
      card.castShadow = true;
      card.receiveShadow = true;
      const index = this.#pileCards.length;
      card.position.set(
        (Math.random() - 0.5) * TUNING.pile.jitter,
        TUNING.card.thickness / 2 + index * TUNING.pile.cardGap,
        (Math.random() - 0.5) * TUNING.pile.jitter,
      );
      card.rotation.y = (Math.random() - 0.5) * 0.08;
      this.#pile.add(card);
      this.#pileCards.push(card);
    }
    while (this.#pileCards.length > visible) {
      const card = this.#pileCards.pop();
      card.removeFromParent();
    }

    // 책상을 다 치우면 더미가 다음 차례임을 알린다 (바닥이 드러나는 순간)
    const ready = queued > 0 && store.unprocessedCount === 0;
    this.pileLabelElement.textContent = queued > 0 ? (ready ? `${Math.min(queued, store.capacity)}개 꺼내기` : `남은 ${queued}`) : "다 꺼냈음";
    this.pileLabelElement.dataset.empty = String(queued === 0);
    this.pileLabelElement.dataset.ready = String(ready);
    this.pileHit.visible = queued > 0;
  }

  #syncBreadcrumb() {
    const store = this.#store;
    const level = store.level;
    this.#breadcrumb.textContent =
      level === null
        ? store.visibleTargets.length
          ? "빈손으로 상자를 클릭하면 폴더가 열립니다"
          : "폴더가 없습니다 · 설정 패널의 '새 폴더'로 만드세요"
        : `${store.folderLabel(level)} · Esc 뒤로`;
    this.#breadcrumb.dataset.level = level === null ? "root" : "inner";
  }

  // ───────────────────────── 프레임 ─────────────────────────

  #frame(dt) {
    if (this.#arranging && !this.#suspended) this.#previewBox(this.#locked ? null : this.#boxPointer);
    if (this.#kit.isWalking) {
      if (this.#locked) {
        if (this.#gathering && !this.#arranging) this.#sweepGather();
        const pick = this.#pickAt(null);
        this.#setHovered(pick.kind === "card" ? pick.id : null);
        this.#crosshair.dataset.over = pick.kind;
        for (const box of this.#boxes.values()) box.setTargeted(pick.kind === "box" && box.id === pick.id, this.#arranging ? 0 : this.#store.selection.length);
      }
      this.#updateHandTargets();
      this.#updateHandHint();
    }
    for (const card of this.#cards.values()) card.update(dt);
    for (const box of this.#boxes.values()) box.update(dt);

    if (this.#drag?.moved) this.#stepDrag(dt);
    this.#updateHoverLabel();
  }

  #updateHoverLabel() {
    const dragging = this.#drag?.moved;
    const id = dragging ? this.#drag.leadId : this.#hoveredCardId;
    const card = id ? this.#cards.get(id) : null;
    const entry = id ? this.#store.entry(id) : null;
    if (!card || !entry) {
      this.#hoverLabel.hidden = true;
      return;
    }
    const screen = this.#kit.toScreen(card.position.clone().setY(card.position.y + 0.42));
    const count = dragging ? this.#drag.ids.size : 0;
    const stage = entry.status === "moving" ? STAGE_LABEL[entry.stage] ?? "옮기는 중" : null;
    this.#hoverLabel.hidden = false;
    this.#hoverLabel.style.transform = `translate(-50%, -100%) translate(${screen.x}px, ${screen.y}px)`;
    this.#hoverLabel.dataset.tone = entry.status === "conflict" ? "error" : entry.status === "error" ? "warn" : "info";
    this.#hoverLabel.innerHTML = "";
    const name = document.createElement("strong");
    name.textContent = entry.item.name;
    const meta = document.createElement("small");
    meta.textContent = count > 1
      ? `${count}장 집는 중`
      : stage ?? entry.message ?? `${formatSize(entry.item.size)} · ${entry.item.extension ? entry.item.extension.toUpperCase() : "확장자 없음"}`;
    this.#hoverLabel.append(name, meta);
  }

  // ───────────────────────── 포인터 ─────────────────────────

  #bindPointer() {
    const canvas = this.#kit.renderer.domElement;
    canvas.addEventListener("pointerdown", (event) => this.#onPointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.#onPointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.#onPointerUp(event));
    canvas.addEventListener("pointercancel", () => this.#cancelGestures());
    canvas.addEventListener("pointerleave", () => {
      if (!this.#drag && !this.#marqueeState) this.#setHovered(null);
    });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("wheel", (event) => {
      if (!this.#arranging || !this.#heldBox || this.#suspended || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      // 터치패드의 작은 연속 입력은 누적하고, 표준 휠 약 한 칸마다 15도씩 회전한다.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
      this.#heldBox.wheelDelta += event.deltaY * unit;
      const steps = Math.trunc(this.#heldBox.wheelDelta / 100);
      if (!steps) return;
      this.#heldBox.wheelDelta -= steps * 100;
      this.#heldBox.yaw = rotateBox(this.#heldBox.yaw, steps);
      this.#boxPointer = { clientX: event.clientX, clientY: event.clientY };
      this.#previewBox(this.#locked ? null : this.#boxPointer);
    }, { passive: false });

    // 포인터 락 중에는 clientX/Y가 멈추고 movementX/Y만 온다
    canvas.addEventListener("mousemove", (event) => {
      if (!this.#locked) return;
      this.#kit.look(event.movementX, event.movementY, true);
    });

    this.#onLockChange = () => {
      this.#pointerLock.changed(document.pointerLockElement === canvas);
      if (this.#locked && this.#suspended) { document.exitPointerLock(); return; }
      if (!this.#locked) {
        this.#gathering = false;
        this.#keys.clear();
        this.#pushMoveInput();
      }
    };
    document.addEventListener("pointerlockchange", this.#onLockChange);

    // 락이 거부되는 환경(iframe, 정책, 권한 거절)이 있다. 그때는 커서로 겨눈다.
    this.#onLockError = () => {
      this.#pointerLock.failed();
    };
    document.addEventListener("pointerlockerror", this.#onLockError);
  }

  #requestLock() {
    if (!this.#kit.isWalking || this.#suspended) return;
    this.#pointerLock.request(this.#kit.renderer.domElement);
  }

  /** 락이 안 되면 커서를 조준선 대신 쓴다. 조작은 같고 겨누는 방법만 다르다. */
  get #aiming() {
    return this.#locked || this.#lockDenied;
  }

  #updateLockUi() {
    const walking = this.#kit.isWalking;
    this.#kit.root.dataset.walking = String(walking);
    this.#crosshair.hidden = !walking || !this.#locked;
    this.#lockPrompt.hidden = !walking || this.#locked || this.#suspended;
    this.#lockPrompt.disabled = this.#pointerLock.pending;
    const title = this.#pointerLock.pending ? "시점 연결 중…" : this.#lockDenied ? "마우스 시점 다시 연결" : this.#pointerLock.hasLocked ? "게임으로 돌아가기" : "방 둘러보기";
    const detail = this.#lockDenied ? "클릭해서 재시도 · 안 되면 빈손 우클릭 드래그로 둘러보기" : "클릭하면 마우스 시점 복귀 · Esc 커서";
    this.#lockPrompt.querySelector("strong").textContent = title;
    this.#lockPrompt.querySelector("small").textContent = detail;
    if (!walking) this.#handHint.hidden = true;
    this.#kit.renderer.domElement.style.cursor = walking && this.#locked ? "none" : "default";
    this.#breadcrumb.dataset.fallback = String(this.#lockDenied);
  }

  /**
   * 지금 겨누고 있는 화면 좌표.
   * 포인터 락이면 커서가 없으므로 화면 한가운데(조준선)를 쓴다.
   */
  #aim(event) {
    if (this.#locked || !event) {
      const rect = this.#kit.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return { x: event.clientX, y: event.clientY };
  }

  // ───────────────────────── 1인칭 조작 ─────────────────────────

  /**
   * 조준선으로 집고, 폴더를 보고 넣는다.
   *
   * 커서가 없으므로 끌어다 놓기가 성립하지 않는다. 대신 두 박자로 나눈다.
   *   담기 — 카드를 보고 클릭. 누른 채 훑으면 닿는 대로 손에 담긴다 (§12의 "한 번에 집는 제스처")
   *   넣기 — 폴더를 보고 클릭. 숫자 키도 같다
   * 빈손으로 폴더를 클릭하면 폴더가 열린다. 오른쪽 버튼은 겨누는 자리에 그대로 내려놓는다.
   */
  #walkPointerDown(event) {
    if (!this.#aiming) {
      // 아직 마우스를 안 잡았다. 왼쪽 클릭이 곧 "시작"이다.
      if (event.button === 0) this.#requestLock();
      return;
    }
    // 락이 거부된 환경에서는 오른쪽 드래그로 둘러본다
    if (this.#lockDenied && event.button === 2 && this.#store.selection.length === 0) {
      this.#look = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      this.#capture(event);
      event.preventDefault();
      return;
    }

    const held = this.#store.selection;
    if (event.button === 2) {
      // 겨눈 자리에 그대로 떨어뜨린다. 원래 자리로 돌려보내면 옮긴 보람이 없다.
      if (held.length) this.#placeHeldAt(event);
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();

    const pick = this.#pickAt(event);
    if (pick.kind === "pile") {
      this.#onPullWave?.();
      return;
    }
    if (pick.kind === "box") {
      if (held.length) this.#onDropToFolder?.(held, pick.id);
      else this.#onOpenFolder?.(pick.id);
      return;
    }
    if (pick.kind === "card") {
      this.#store.select(pick.id, { additive: true });
      this.#gathering = TUNING.firstPerson.gather.sweep;
      return;
    }
    if (held.length) this.#placeHeldAt(event); // 빈 바닥에 내려놓기
  }

  #walkPointerUp(event) {
    if (this.#look && event.pointerId === this.#look.pointerId) {
      this.#look = null;
      this.#release(event);
      return;
    }
    this.#gathering = false;
  }

  /**
   * 누른 채 훑는 동안 겨눈 카드를 손에 담는다.
   * 락이면 조준선(화면 중앙)이 움직이니 매 프레임 보고, 커서 모드면 커서가 움직이니 이동할 때마다 본다.
   */
  #sweepGather(event = null) {
    const pick = this.#pickAt(event);
    if (pick.kind !== "card" || this.#store.isSelected(pick.id)) return;
    this.#store.select(pick.id, { additive: true });
  }

  /**
   * 들고 있던 카드를 겨눈 바닥에 내려놓는다.
   * 하늘이나 벽을 보고 있어 바닥을 못 맞히면 발 앞에 떨어뜨린다 — 아무 일도 안 일어나면 버그처럼 느껴진다.
   */
  #placeHeldAt(event) {
    const aim = this.#aim(event);
    let point = this.#kit.worldAt(aim.x, aim.y, 0);
    if (!point) {
      const flat = this.#kit.forwardFlat();
      const eye = this.#kit.eye;
      point = new THREE.Vector3(eye.x + flat.x * 3, 0, eye.z + flat.z * 3);
    }
    const store = this.#store;
    const center = toLogical(point.x, point.z);
    const GOLDEN_ANGLE = 2.399963;
    store.setPositions(
      store.selection.map((id, index) => {
        const radius = index === 0 ? 0 : 28 * Math.sqrt(index);
        const angle = index * GOLDEN_ANGLE;
        return {
          id,
          x: center.cx + Math.cos(angle) * radius - store.card.width / 2,
          y: center.cy + Math.sin(angle) * radius - store.card.height / 2,
        };
      }),
    );
    store.clearSelection();
  }

  /** 들고 있는 카드를 몸 앞에 쌓아 둔다. 카메라가 움직이므로 매 프레임 다시 잡는다. */
  #updateHandTargets() {
    const held = this.#store.selection;
    if (held.length === 0) return;
    const { hand } = TUNING.firstPerson;
    const camera = this.#kit.camera;
    const base = new THREE.Vector3(hand.side, hand.height, -hand.distance).applyQuaternion(camera.quaternion).add(camera.position);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const spin = this.#kit.yawRadians;

    held.forEach((id, index) => {
      const card = this.#cards.get(id);
      if (!card) return;
      card.group.visible = index < hand.maxVisible;
      if (!card.group.visible) return;
      const depth = Math.min(index, hand.maxVisible);
      // 부채꼴로 펴야 몇 장 들었는지 보인다. 겹쳐 두면 한 장처럼 읽힌다.
      const fan = (depth - Math.min(held.length - 1, hand.maxVisible) / 2) * hand.fan;
      card.spring = hand.spring;
      card.follow = 1;
      card.setTarget({
        x: base.x - forward.x * depth * hand.back + right.x * fan,
        y: base.y + depth * hand.rise,
        z: base.z - forward.z * depth * hand.back + right.z * fan,
        spin: spin + fan * 0.5,
        scale: hand.scale,
        facePitch: hand.pitch + camera.rotation.x,
      });
    });
  }

  #updateHandHint() {
    const held = this.#store.selection.length;
    const walking = this.#kit.isWalking;
    this.#handHint.hidden = this.#arranging || !walking || held === 0;
    if (held > 0 && walking) {
      const message = `<kbd>좌클릭</kbd> 상자에 넣기 <span>· ${held}장</span> <kbd>우클릭</kbd> 내려놓기`;
      if (this.#handHint.innerHTML !== message) this.#handHint.innerHTML = message;
    }
  }

  #hitTargets() {
    if (this.#arranging) return [...this.#boxes.values()].filter((box) => box.id !== this.#heldBox?.id).map((box) => box.catcher);
    const targets = [];
    for (const card of this.#cards.values()) {
      const entry = this.#store.entry(card.id);
      if (entry && SELECTABLE_STATUSES.has(entry.status) && !(this.walking && this.#store.isSelected(card.id))) targets.push(card.hitbox);
    }
    for (const box of this.#boxes.values()) targets.push(box.catcher);
    if (this.pileHit.visible) targets.push(this.pileHit);
    return targets;
  }

  #pickAt(event) {
    const aim = this.#aim(event);
    const hit = this.#kit.pick(aim.x, aim.y, this.#hitTargets());
    if (!hit) return { kind: "empty" };
    const data = hit.object.userData;
    if (data.cardId) return { kind: "card", id: data.cardId };
    if (data.folderId) return { kind: "box", id: data.folderId, object: hit.object };
    if (data.pile) return { kind: "pile" };
    return { kind: "empty" };
  }

  #boxUnder(event) {
    const catchers = [...this.#boxes.values()].map((box) => box.catcher);
    const hit = this.#kit.pick(event.clientX, event.clientY, catchers);
    return hit?.object.userData.folderId ?? null;
  }

  #setHovered(id) {
    if (this.#hoveredCardId === id) return;
    const previous = this.#hoveredCardId ? this.#cards.get(this.#hoveredCardId) : null;
    previous?.setHovered(false);
    this.#hoveredCardId = id;
    const next = id ? this.#cards.get(id) : null;
    next?.setHovered(true);
    const canvas = this.#kit.renderer.domElement;
    canvas.style.cursor = id ? "grab" : "default";
    this.sync();
  }

  #onPointerDown(event) {
    if (this.#suspended) return;
    if (this.#arranging) { this.#arrangePointerDown(event); return; }
    if (this.#kit.isWalking) {
      this.#walkPointerDown(event);
      return;
    }
    if (event.button !== 0) return;
    const pick = this.#pickAt(event);
    this.#kit.setPointer(event.clientX, event.clientY);

    if (pick.kind === "pile") {
      this.#pressed = { pointerId: event.pointerId, kind: "pile" };
      return;
    }
    if (pick.kind === "box") {
      const box = this.#boxes.get(pick.id) ?? this.#boxes.get(`self:${pick.id}`);
      this.#pressed = { pointerId: event.pointerId, kind: "box", id: pick.id, isSelf: Boolean(box?.isSelf) };
      return;
    }
    if (pick.kind === "card") {
      const store = this.#store;
      const entry = store.entry(pick.id);
      if (!entry || !SELECTABLE_STATUSES.has(entry.status)) return;
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      let pendingDeselect = null;
      if (!store.isSelected(pick.id)) store.select(pick.id, { additive });
      else if (additive) pendingDeselect = pick.id;

      const ids = new Set(store.selection);
      ids.add(pick.id);
      const lead = this.#cards.get(pick.id);
      const offsets = new Map();
      const origins = new Map();
      for (const id of ids) {
        const card = this.#cards.get(id);
        const other = store.entry(id);
        if (!card || !other?.position) continue;
        offsets.set(id, { x: card.position.x - lead.position.x, z: card.position.z - lead.position.z });
        origins.set(id, { x: other.position.x, y: other.position.y });
      }
      const grab = this.#kit.worldAt(event.clientX, event.clientY, 0);
      this.#drag = {
        pointerId: event.pointerId,
        leadId: pick.id,
        ids,
        offsets,
        origins,
        order: [pick.id, ...[...ids].filter((id) => id !== pick.id)],
        grabOffset: grab ? { x: lead.position.x - grab.x, z: lead.position.z - grab.z } : { x: 0, z: 0 },
        start: { x: event.clientX, y: event.clientY },
        pointer: { x: event.clientX, y: event.clientY },
        moved: false,
        targetFolder: null,
        springTimer: null,
        pendingDeselect,
      };
      this.#capture(event);
      event.preventDefault();
      return;
    }

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    this.#marqueeState = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      current: { x: event.clientX, y: event.clientY },
      additive,
      moved: false,
    };
    this.#capture(event);
    event.preventDefault();
  }

  #onPointerMove(event) {
    if (this.#suspended) return;
    this.#boxPointer = { clientX: event.clientX, clientY: event.clientY };
    this.#kit.setPointer(event.clientX, event.clientY);

    if (this.#look && event.pointerId === this.#look.pointerId) {
      this.#kit.look(event.clientX - this.#look.x, event.clientY - this.#look.y);
      this.#look.x = event.clientX;
      this.#look.y = event.clientY;
      return;
    }

    // 커서 모드에서 누른 채 훑기. 락일 때는 #frame이 조준선으로 본다.
    if (this.#arranging) { this.#previewBox(event); return; }
    if (this.#gathering && !this.#locked) {
      this.#sweepGather(event);
      return;
    }

    if (this.#drag && event.pointerId === this.#drag.pointerId) {
      const drag = this.#drag;
      drag.pointer = { x: event.clientX, y: event.clientY };
      if (!drag.moved) {
        const distance = Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y);
        if (distance < TUNING.dragThreshold) return;
        drag.moved = true;
        drag.pendingDeselect = null;
        for (const id of drag.ids) {
          const card = this.#cards.get(id);
          if (card) card.spring = TUNING.card.dragSpring;
        }
        this.#kit.renderer.domElement.style.cursor = "grabbing";
        this.sync(); // 들어 올린 카드를 빼고 높이를 다시 계산 — 밑에 깔렸던 카드가 내려앉는다
      }
      const folderId = this.#boxUnder(event);
      if (folderId !== drag.targetFolder) {
        this.#clearTarget();
        this.#clearSpring();
        drag.targetFolder = folderId;
        if (folderId) {
          const box = this.#boxes.get(folderId) ?? this.#boxes.get(`self:${folderId}`);
          box?.setTargeted(true, drag.ids.size);
          const folder = this.#store.folder(folderId);
          if (box && !box.isSelf && folder && folder.hasChildren !== false) {
            drag.springTimer = setTimeout(() => {
              drag.springTimer = null;
              if (this.#drag === drag && drag.targetFolder === folderId) this.#onOpenFolder?.(folderId);
            }, TUNING.springOpenMs);
          }
        }
      }
      return;
    }

    if (this.#marqueeState && event.pointerId === this.#marqueeState.pointerId) {
      const state = this.#marqueeState;
      state.current = { x: event.clientX, y: event.clientY };
      if (!state.moved) {
        const distance = Math.hypot(state.current.x - state.start.x, state.current.y - state.start.y);
        if (distance < TUNING.dragThreshold) return;
        state.moved = true;
      }
      const rect = this.#marqueeRect(state);
      const canvasRect = this.#kit.renderer.domElement.getBoundingClientRect();
      this.#marquee.hidden = false;
      this.#marquee.style.left = `${rect.x - canvasRect.left}px`;
      this.#marquee.style.top = `${rect.y - canvasRect.top}px`;
      this.#marquee.style.width = `${rect.width}px`;
      this.#marquee.style.height = `${rect.height}px`;
      const hits = new Set(this.#cardsIn(rect));
      for (const [id, card] of this.#cards) card.setHovered(hits.has(id));
      return;
    }

    if (!this.#pressed) {
      const pick = this.#pickAt(event);
      this.#setHovered(pick.kind === "card" ? pick.id : null);
      if (this.walking && !this.#locked) {
        for (const box of this.#boxes.values()) box.setTargeted(pick.kind === "box" && box.id === pick.id, this.#store.selection.length);
      }
    }
  }

  #onPointerUp(event) {
    if (this.#arranging) { this.#walkPointerUp(event); return; }
    if (this.#kit.isWalking) {
      this.#walkPointerUp(event);
      return;
    }

    if (this.#pressed && event.pointerId === this.#pressed.pointerId) {
      const pressed = this.#pressed;
      this.#pressed = null;
      const pick = this.#pickAt(event);
      if (pressed.kind === "pile" && pick.kind === "pile") this.#onPullWave?.();
      if (pressed.kind === "box" && pick.kind === "box" && pick.id === pressed.id) {
        if (pressed.isSelf) this.#onLeaveFolder?.();
        else this.#onOpenFolder?.(pressed.id);
      }
      return;
    }

    if (this.#drag && event.pointerId === this.#drag.pointerId) {
      const drag = this.#drag;
      this.#drag = null;
      this.#clearSpring();
      this.#release(event);
      this.#clearTarget();
      this.#kit.renderer.domElement.style.cursor = "default";
      for (const id of drag.ids) {
        const card = this.#cards.get(id);
        if (card) {
          card.spring = TUNING.card.spring;
          card.follow = 1;
        }
      }

      if (!drag.moved) {
        if (drag.pendingDeselect) this.#store.select(drag.pendingDeselect, { toggle: true });
        this.sync();
        return;
      }

      const folderId = this.#boxUnder(event);
      if (folderId) {
        this.sync(); // 실패하면 제자리로 튕겨 돌아가야 하므로 위치는 그대로 둔다
        this.#onDropToFolder?.([...drag.ids], folderId);
        return;
      }

      // 책상에 내려놓기: 월드 위치를 논리 좌표로 되돌려 스토어에 넘긴다
      const store = this.#store;
      const updates = [];
      for (const id of drag.ids) {
        const card = this.#cards.get(id);
        if (!card) continue;
        const logical = toLogical(card.position.x, card.position.z);
        updates.push({ id, x: logical.cx - store.card.width / 2, y: logical.cy - store.card.height / 2 });
      }
      store.setPositions(updates);
      return;
    }

    if (this.#marqueeState && event.pointerId === this.#marqueeState.pointerId) {
      const state = this.#marqueeState;
      this.#marqueeState = null;
      this.#release(event);
      this.#marquee.hidden = true;
      for (const card of this.#cards.values()) card.setHovered(false);
      this.#hoveredCardId = null;
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

  /** 손에 들린 카드들을 포인터로 끌어당긴다. 뒤 카드일수록 늦게 따라온다. */
  #stepDrag(dt) {
    const drag = this.#drag;
    const point = this.#kit.worldAt(drag.pointer.x, drag.pointer.y, TUNING.card.liftHeight);
    if (!point) return;
    const handX = point.x + drag.grabOffset.x;
    const handZ = point.z + drag.grabOffset.z;
    const overBox = Boolean(drag.targetFolder);

    drag.order.forEach((id, index) => {
      const card = this.#cards.get(id);
      const offset = drag.offsets.get(id);
      if (!card || !offset) return;
      // 손에 쥐면 더미가 살짝 모인다
      const gather = 0.55;
      card.follow = Math.max(0.45, 1 - index * 0.07);
      card.setTarget({
        x: handX + offset.x * gather,
        y: TUNING.card.liftHeight + (overBox ? -0.08 : 0) - index * 0.012,
        z: handZ + offset.z * gather,
        scale: TUNING.card.liftScale,
      });
    });
  }

  #clearTarget() {
    for (const box of this.#boxes.values()) box.setTargeted(false);
  }

  #clearSpring() {
    if (this.#drag?.springTimer) {
      clearTimeout(this.#drag.springTimer);
      this.#drag.springTimer = null;
    }
  }

  #cancelGestures() {
    this.#clearSpring();
    if (this.#drag) {
      for (const id of this.#drag.ids) {
        const card = this.#cards.get(id);
        if (card) card.spring = TUNING.card.spring;
      }
      this.#drag = null;
      this.#clearTarget();
      this.sync();
    }
    if (this.#marqueeState) {
      this.#marqueeState = null;
      this.#marquee.hidden = true;
    }
    this.#pressed = null;
  }

  /**
   * 걷기. WASD / 화살표, Shift로 빠르게.
   *
   * 입력칸에 타이핑 중이거나 Ctrl·Cmd가 눌린 동안에는 무시한다 (Ctrl+A가 왼쪽으로 걷게 하면 안 된다).
   * 창에서 포커스가 나가면 눌린 키를 전부 놓는다 — 안 그러면 돌아왔을 때 혼자 걸어간다.
   */
  #bindKeys() {
    const MOVE_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"]);
    const isEditing = (target) =>
      target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

    this.#onKeyDown = (event) => {
      if (this.#suspended) return;
      if (!this.#kit.isWalking || event.ctrlKey || event.metaKey || event.altKey || isEditing(event.target)) return;
      const key = movementKey(event);
      if (!MOVE_KEYS.has(key)) return;
      event.preventDefault();
      this.#keys.add(key);
      this.#pushMoveInput();
    };
    this.#onKeyUp = (event) => {
      if (!this.#keys.delete(movementKey(event))) return;
      this.#pushMoveInput();
    };
    this.#onBlur = () => {
      if (this.#keys.size === 0) return;
      this.#keys.clear();
      this.#pushMoveInput();
    };

    window.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("keyup", this.#onKeyUp);
    window.addEventListener("blur", this.#onBlur);
  }

  #pushMoveInput() {
    const has = (...names) => names.some((name) => this.#keys.has(name));
    this.#kit.setMoveInput({
      forward: (has("w", "arrowup") ? 1 : 0) - (has("s", "arrowdown") ? 1 : 0),
      strafe: (has("d", "arrowright") ? 1 : 0) - (has("a", "arrowleft") ? 1 : 0),
      sprint: has("shift"),
    });
  }

  #capture(event) {
    try {
      this.#kit.renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // 합성 이벤트이거나 이미 끝난 포인터. 캔버스 안에서는 캡처 없이도 동작한다.
    }
  }

  #release(event) {
    try {
      this.#kit.renderer.domElement.releasePointerCapture(event.pointerId);
    } catch {
      // 캡처가 없었다
    }
  }

  #marqueeRect(state) {
    const { start, current } = state;
    return {
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      width: Math.abs(current.x - start.x),
      height: Math.abs(current.y - start.y),
    };
  }

  /** 화면 사각형 안에 든 카드. 월드 좌표를 화면으로 투영해 판정한다. */
  #cardsIn(rect) {
    const canvasRect = this.#kit.renderer.domElement.getBoundingClientRect();
    const ids = [];
    for (const entry of this.#store.boardEntries) {
      if (!SELECTABLE_STATUSES.has(entry.status)) continue;
      const card = this.#cards.get(entry.id);
      if (!card) continue;
      const screen = this.#kit.toScreen(card.position);
      if (screen.behind) continue;
      const x = screen.x + canvasRect.left;
      const y = screen.y + canvasRect.top;
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) ids.push(entry.id);
    }
    return ids;
  }
}
