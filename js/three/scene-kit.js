/**
 * scene-kit.js — 렌더러, 카메라, 조명, 방, 좌표 변환.
 *
 * board-3d.js가 "무엇을 놓을지"를 정하고, 이 파일이 "어떻게 보일지"를 맡는다.
 * 논리 좌표(1280×720)와 월드 좌표를 오가는 변환도 여기 있다. layout.js가 만든 배치가
 * 2D 보드와 3D 장면에서 똑같이 읽히는 이유다.
 *
 * 카메라는 두 모드다.
 *   walk  — 1인칭. 방 안에 서서 둘러본다. 기본값. (§2-1)
 *   orbit — 바깥에서 내려다보는 고정 사선. 0-C 때 검증한 것이고 비교용으로 남겼다.
 */
import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

import { BOARD_SIZE, boxZoneFor, playBoundsFor } from "../ui/board-layout.js";
import { loadModel } from "./assets.js";
import { furnishRoom, buildShelfCells, disposeRoomGroup } from "./cozy-room.js";
import { moveWalker, safeWalkPosition } from "./walk-collision.js";
import { TUNING, UNIT, directionFromAngles, springStep } from "./tuning.js";

export { THREE, CSS2DObject };

const HALF_W = BOARD_SIZE.width / 2;
const HALF_H = BOARD_SIZE.height / 2;
const DEG = Math.PI / 180;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** 논리 좌표의 한 점(중심 기준) → 월드 XZ */
export function toWorld(cx, cy) {
  return { x: (cx - HALF_W) * UNIT, z: (cy - HALF_H) * UNIT };
}

/** 월드 XZ → 논리 좌표(중심 기준) */
export function toLogical(x, z) {
  return { cx: x / UNIT + HALF_W, cy: z / UNIT + HALF_H };
}

export function toWorldSize(logical) {
  return logical * UNIT;
}

/**
 * 나무 널 결. 카드를 다 치우면 드러나는 바닥이 밋밋한 색판이면 치운 보람이 없다.
 * 텍스처를 코드로 굽는다 — 이미지 파일을 늘리지 않는다.
 */
function makePlankTexture(baseColor, { plank = 86, seam = 0.09, grain = 0.025 } = {}) {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const base = new THREE.Color(baseColor);

  for (let y = 0; y < size; y += plank) {
    const shade = 1 + (Math.sin(y * 12.9898) * 0.5 + 0.5 - 0.5) * 0.16;
    const row = base.clone().multiplyScalar(shade);
    ctx.fillStyle = `#${row.getHexString()}`;
    ctx.fillRect(0, y, size, plank);

    ctx.strokeStyle = `rgba(0,0,0,${grain})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i += 1) {
      const gy = y + ((i + 1) * plank) / 8;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      for (let x = 0; x <= size; x += 32) ctx.lineTo(x, gy + Math.sin((x + y) * 0.03) * 1.6);
      ctx.stroke();
    }

    ctx.fillStyle = `rgba(0,0,0,${seam})`;
    ctx.fillRect(0, y, size, 2);
    // Offset the short joints so this reads as floorboards, not continuous stripes.
    ctx.fillRect((Math.floor(y / plank) % 3) * 170, y, 2, plank);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

export class SceneKit {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.clock = new THREE.Clock();
    this.pointerNdc = new THREE.Vector2(0, 0);
    this.parallax = new THREE.Vector2(0, 0);
    this.placement = "bottom";
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // 궤도 카메라 (0-C의 고정 사선)
    this.presetId = "diagonal";
    this.orbit = { elevation: 0, azimuth: 0, distance: 12, targetZ: 0, fov: 34 };
    this.orbitVel = { elevation: 0, azimuth: 0, distance: 0, targetZ: 0, fov: 0 };

    // 1인칭
    this.mode = "orbit";
    this.walk = { x: 0, z: 0, yaw: 0, pitch: TUNING.firstPerson.pitch, vx: 0, vz: 0, bob: 0 };
    this.pendingLook = { yaw: 0, pitch: 0 };
    this.moveInput = { forward: 0, strafe: 0, sprint: false };

    this.#buildRenderer();
    this.#buildScene();
    this.#buildLights();
    this.#buildDesk();
    this.#buildRoom();

    Object.assign(this.orbit, this.#orbitTarget(TUNING.camera.presets[this.presetId]));
    this.setCameraPreset(TUNING.camera.default);
    this.#applyCamera();
  }

  // ───────────────────────── 구성 ─────────────────────────

  #buildRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = TUNING.light.exposure;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.classList.add("board-canvas");

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.classList.add("board-labels");

    this.root.append(this.renderer.domElement, this.labelRenderer.domElement);
  }

  #buildScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(TUNING.desk.background);
    this.scene.fog = new THREE.Fog(this.scene.background, 20, 46);

    this.camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.1, 100);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);

    this.world = new THREE.Group();
    this.scene.add(this.world);
  }

  #buildLights() {
    const { key, fill, hemi, shadow } = TUNING.light;

    this.scene.add(new THREE.HemisphereLight(hemi.sky, hemi.ground, hemi.intensity));

    this.keyLight = new THREE.DirectionalLight(key.color, key.intensity);
    const keyDir = directionFromAngles(key.elevation, key.azimuth);
    this.keyLight.position.set(keyDir.x * key.distance, keyDir.y * key.distance, keyDir.z * key.distance);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(shadow.mapSize, shadow.mapSize);
    this.keyLight.shadow.radius = shadow.radius;
    this.keyLight.shadow.bias = shadow.bias;
    this.keyLight.shadow.normalBias = shadow.normalBias;
    const extent = Math.max(BOARD_SIZE.width, BOARD_SIZE.height) * UNIT * 0.62;
    const shadowCamera = this.keyLight.shadow.camera;
    shadowCamera.left = -extent;
    shadowCamera.right = extent;
    shadowCamera.top = extent;
    shadowCamera.bottom = -extent;
    shadowCamera.near = 1;
    shadowCamera.far = key.distance * 2.4;
    shadowCamera.updateProjectionMatrix();
    this.scene.add(this.keyLight, this.keyLight.target);

    const fillLight = new THREE.DirectionalLight(fill.color, fill.intensity);
    const fillDir = directionFromAngles(fill.elevation, fill.azimuth);
    fillLight.position.set(fillDir.x * fill.distance, fillDir.y * fill.distance, fillDir.z * fill.distance);
    this.scene.add(fillLight);
  }

  #buildDesk() {
    this.deskGroup = new THREE.Group();
    this.world.add(this.deskGroup);

    const margin = toWorldSize(TUNING.desk.margin);
    const deskWidth = BOARD_SIZE.width * UNIT + margin * 2;
    const deskDepth = BOARD_SIZE.height * UNIT + margin * 2;

    this.deskTexture = makePlankTexture(TUNING.desk.color);
    this.deskTexture.repeat.set(deskWidth / 2.6, deskDepth / 2.6);
    this.desk = new THREE.Mesh(
      new THREE.BoxGeometry(deskWidth, 0.4, deskDepth),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.deskTexture, roughness: 0.94, metalness: 0 }),
    );
    this.desk.position.y = -0.2;
    this.desk.receiveShadow = true;
    this.deskGroup.add(this.desk);

    this.playTexture = makePlankTexture(TUNING.desk.playColor);
    this.playTexture.repeat.set((BOARD_SIZE.width * UNIT) / 2.6, (BOARD_SIZE.height * UNIT) / 2.6);
    this.playMat = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.playTexture, roughness: 0.98, metalness: 0 }),
    );
    this.playMat.rotation.x = -Math.PI / 2;
    this.playMat.position.y = 0.002;
    this.playMat.receiveShadow = true;

    this.boxMat = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: TUNING.desk.boxZoneColor, roughness: 0.98, metalness: 0 }),
    );
    this.boxMat.rotation.x = -Math.PI / 2;
    this.boxMat.position.y = 0.0015;
    this.boxMat.receiveShadow = true;

    this.deskGroup.add(this.playMat, this.boxMat);
    // One continuous wood floor in the room; no darker rectangular play mat.
    this.playMat.visible = false;
    this.boxMat.visible = false;
    this.setPlacement("bottom");

    loadModel(THREE, "desk").then((model) => {
      if (!model) return;
      this.desk.visible = false;
      this.deskGroup.add(model);
    });
  }

  /** 1인칭에서만 세우는 벽. 궤도 카메라에서는 시야를 막으므로 숨긴다. */
  #buildRoom() {
    const { wallHeight, wallThickness, color, trimColor, margin } = TUNING.room;
    this.roomGroup = new THREE.Group();
    this.roomGroup.visible = false;
    this.world.add(this.roomGroup);

    this.roomHalf = {
      x: (BOARD_SIZE.width * UNIT) / 2 + toWorldSize(margin),
      z: (BOARD_SIZE.height * UNIT) / 2 + toWorldSize(margin),
    };

    const wallMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 });
    const trimMaterial = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.8, metalness: 0 });
    const spans = [
      { w: this.roomHalf.x * 2 + wallThickness * 2, d: wallThickness, x: 0, z: -this.roomHalf.z },
      { w: this.roomHalf.x * 2 + wallThickness * 2, d: wallThickness, x: 0, z: this.roomHalf.z },
      { w: wallThickness, d: this.roomHalf.z * 2, x: -this.roomHalf.x, z: 0 },
      { w: wallThickness, d: this.roomHalf.z * 2, x: this.roomHalf.x, z: 0 },
    ];
    for (const span of spans) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(span.w, wallHeight, span.d), wallMaterial);
      wall.position.set(span.x, wallHeight / 2, span.z);
      wall.receiveShadow = true;
      this.roomGroup.add(wall);

      // 걸레받이 — 벽과 바닥이 만나는 선이 있어야 방으로 읽힌다
      const trim = new THREE.Mesh(new THREE.BoxGeometry(span.w * 1.001, 0.34, span.d * 1.6), trimMaterial);
      trim.position.set(span.x, 0.17, span.z);
      trim.receiveShadow = true;
      this.roomGroup.add(trim);
    }
    this.roomObstacles = furnishRoom(this.roomGroup, this.roomHalf);
    this.shelfGroup = new THREE.Group();
    this.world.add(this.shelfGroup);
  }

  setFolderShelf(slots) {
    const active = this.isWalking && this.placement === "far";
    this.shelfGroup.visible = active;
    if (!active) return;
    const signature = JSON.stringify(slots);
    if (signature === this.shelfSignature) return;
    this.shelfSignature = signature;
    disposeRoomGroup(this.shelfGroup);
    buildShelfCells(this.shelfGroup, slots);
  }

  /** 카드 영역과 상자 띠의 크기를 배치에 맞춘다 */
  setPlacement(placement) {
    this.placement = placement;
    const play = playBoundsFor(placement);
    const zone = boxZoneFor(placement);
    for (const [mesh, rect] of [
      [this.playMat, play],
      [this.boxMat, zone],
    ]) {
      mesh.scale.set(rect.width * UNIT, rect.height * UNIT, 1);
      const center = toWorld(rect.x + rect.width / 2, rect.y + rect.height / 2);
      mesh.position.x = center.x;
      mesh.position.z = center.z;
    }
    if (this.mode === "walk") this.#clampWalk();
  }

  // ───────────────────────── 카메라 ─────────────────────────

  get cameraPresets() {
    return [
      { id: "walk", label: TUNING.firstPerson.label },
      ...Object.entries(TUNING.camera.presets).map(([id, preset]) => ({ id, label: preset.label })),
    ];
  }

  get isWalking() {
    return this.mode === "walk";
  }

  setCameraPreset(id) {
    if (id === "walk") {
      if (this.mode !== "walk") this.resetWalk();
      this.mode = "walk";
      this.roomGroup.visible = true;
      this.camera.fov = this.#walkFov();
      this.camera.updateProjectionMatrix();
      return;
    }
    if (!TUNING.camera.presets[id]) return;
    this.mode = "orbit";
    this.roomGroup.visible = false;
    this.presetId = id;
  }

  #walkFov() {
    // Narrow app panels retain enough horizontal context to see the room, not only the shelf.
    const aspect = this.camera.aspect || 16 / 9;
    return Math.min(92, 2 * Math.atan(Math.tan(TUNING.firstPerson.fov * DEG / 2) * Math.max(1, 1.5 / aspect)) / DEG);
  }

  /** 보드 가까운 쪽에 서서 먼 쪽을 본다 */
  resetWalk() {
    const bounds = this.#walkBounds();
    this.walk.x = clamp(0, bounds.minX, bounds.maxX);
    this.walk.z = bounds.maxZ;
    this.walk.yaw = 0; // yaw 0 = -Z 방향
    this.walk.pitch = TUNING.firstPerson.pitch;
    this.walk.vx = 0;
    this.walk.vz = 0;
    this.walk.bob = 0;
    this.#recoverWalk();
  }

  /** 옆·맞은편 수납장에도 다가갈 수 있도록 방 전체를 사용한다. */
  #walkBounds() {
    const fp = TUNING.firstPerson;
    const wall = TUNING.room.wallThickness + fp.bodyRadius;
    return {
      minX: -this.roomHalf.x + wall,
      maxX: this.roomHalf.x - wall,
      minZ: -this.roomHalf.z + wall,
      maxZ: this.roomHalf.z - wall,
    };
  }

  #clampWalk() {
    const bounds = this.#walkBounds();
    this.walk.x = clamp(this.walk.x, bounds.minX, bounds.maxX);
    this.walk.z = clamp(this.walk.z, bounds.minZ, bounds.maxZ);
  }

  #walkContext() {
    return { bounds: this.#walkBounds(), radius: TUNING.firstPerson.bodyRadius,
      obstacles: this.walkObstacles ?? this.roomObstacles };
  }

  #recoverWalk() {
    const safe = safeWalkPosition({ x: this.walk.x, z: this.walk.z }, this.#walkContext());
    if (!safe || (safe.x === this.walk.x && safe.z === this.walk.z)) return;
    Object.assign(this.walk, safe, { vx: 0, vz: 0 });
  }

  setWalkObstacles(obstacles) {
    this.walkObstacles = obstacles;
    if (!this.isWalking) return;
    this.#recoverWalk();
    this.#applyCamera();
  }

  /**
   * 둘러보기. 입력을 바로 반영하지 않고 쌓아 두었다가 프레임마다 일부만 소화한다.
   * 마우스 이벤트가 듬성듬성 들어오면 그대로 반영할 때 시점이 확확 튀고, 그게 멀미를 부른다.
   */
  look(dx, dy, locked = false) {
    if (this.mode !== "walk") return;
    const fp = TUNING.firstPerson;
    const sensitivity = locked ? fp.lockedSensitivity : fp.lookSensitivity;
    this.pendingLook.yaw -= dx * sensitivity;
    this.pendingLook.pitch -= dy * sensitivity;
  }

  #stepLook() {
    const fp = TUNING.firstPerson;
    const take = Math.min(1, Math.max(0.05, fp.lookSmoothing));
    const yawStep = this.pendingLook.yaw * take;
    const pitchStep = this.pendingLook.pitch * take;
    if (Math.abs(yawStep) < 1e-4 && Math.abs(pitchStep) < 1e-4) {
      this.pendingLook.yaw = 0;
      this.pendingLook.pitch = 0;
      return;
    }
    this.pendingLook.yaw -= yawStep;
    this.pendingLook.pitch -= pitchStep;
    this.walk.yaw += yawStep;
    this.walk.pitch = clamp(this.walk.pitch + pitchStep, fp.pitchRange[0], fp.pitchRange[1]);
  }

  /** 몸 앞 수평 방향 (시선 각도는 빼고) */
  forwardFlat() {
    const yaw = this.walk.yaw * DEG;
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  }

  /** 지금 서 있는 자리 */
  get eye() {
    return this.camera.position;
  }

  get yawRadians() {
    return this.walk.yaw * DEG;
  }

  /** @param {{forward?: number, strafe?: number, sprint?: boolean}} input */
  setMoveInput(input) {
    Object.assign(this.moveInput, input);
  }

  #orbitTarget(preset) {
    const vFov = (preset.fov * Math.PI) / 180;
    const aspect = this.camera.aspect || 16 / 9;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const elevation = preset.elevation * DEG;

    const width = BOARD_SIZE.width * UNIT;
    const depth = BOARD_SIZE.height * UNIT;
    const forWidth = width / 2 / Math.tan(hFov / 2);
    const forDepth = (depth * Math.sin(elevation)) / 2 / Math.tan(vFov / 2);

    return {
      elevation: preset.elevation,
      azimuth: preset.azimuth,
      distance: Math.max(forWidth, forDepth) * preset.fit,
      fov: preset.fov,
      targetZ: toWorldSize(preset.targetBias * 100),
    };
  }

  #applyCamera() {
    if (this.mode === "walk") {
      const fp = TUNING.firstPerson;
      const bob = fp.headBob > 0 ? Math.sin(this.walk.bob) * fp.headBob : 0;
      this.camera.position.set(this.walk.x, fp.eyeHeight + bob, this.walk.z);
      this.camera.rotation.set(this.walk.pitch * DEG, this.walk.yaw * DEG, 0);
      this.keyLight.target.position.set(0, 0, -1);
      this.keyLight.target.updateMatrixWorld();
      return;
    }

    const { elevation, azimuth, distance, targetZ, fov } = this.orbit;
    const dir = directionFromAngles(elevation, azimuth + this.parallax.x * TUNING.camera.parallax * 12);
    const target = new THREE.Vector3(0, 0, targetZ);
    this.camera.rotation.set(0, 0, 0);
    this.camera.position.set(target.x + dir.x * distance, target.y + dir.y * distance, target.z + dir.z * distance);
    this.camera.lookAt(target);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.keyLight.target.position.copy(target);
    this.keyLight.target.updateMatrixWorld();
  }

  #stepWalk(dt) {
    const fp = TUNING.firstPerson;
    this.#stepLook();
    const yaw = this.walk.yaw * DEG;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const { forward, strafe } = this.moveInput;

    let dirX = -sin * forward + cos * strafe;
    let dirZ = -cos * forward - sin * strafe;
    const length = Math.hypot(dirX, dirZ);
    if (length > 1) {
      dirX /= length;
      dirZ /= length;
    }

    const speed = fp.moveSpeed * (this.moveInput.sprint ? fp.sprintMultiplier : 1);
    const smoothing = Math.min(1, dt * fp.moveSmoothing);
    this.walk.vx += (dirX * speed - this.walk.vx) * smoothing;
    this.walk.vz += (dirZ * speed - this.walk.vz) * smoothing;

    Object.assign(this.walk, moveWalker({ x: this.walk.x, z: this.walk.z },
      { x: this.walk.vx * dt, z: this.walk.vz * dt }, this.#walkContext()));
    this.#clampWalk();

    const pace = Math.hypot(this.walk.vx, this.walk.vz);
    this.walk.bob = pace > 0.15 ? this.walk.bob + dt * fp.headBobSpeed * (pace / fp.moveSpeed) : this.walk.bob * 0.86;
    this.#applyCamera();
  }

  #stepOrbit(dt) {
    const preset = TUNING.camera.presets[this.presetId];
    const target = this.#orbitTarget(preset);
    const spring = { freq: TUNING.camera.moveSpring, damping: 1 };
    let moved = false;
    for (const key of ["elevation", "azimuth", "distance", "targetZ", "fov"]) {
      const [value, velocity] = springStep(this.orbit[key], this.orbitVel[key], target[key], dt, spring);
      if (Math.abs(value - this.orbit[key]) > 1e-5) moved = true;
      this.orbit[key] = value;
      this.orbitVel[key] = velocity;
    }
    const smoothing = Math.min(1, dt * TUNING.camera.parallaxSmoothing);
    const before = this.parallax.x;
    this.parallax.x += (this.pointerNdc.x - this.parallax.x) * smoothing;
    if (Math.abs(this.parallax.x - before) > 1e-5) moved = true;
    if (moved) this.#applyCamera();
  }

  // ───────────────────────── 크기 / 포인터 ─────────────────────────

  /**
   * 크기는 컨테이너가 정한다. 예전에는 여기서 16:9로 높이를 박았는데,
   * 전체 화면 모드에서는 뷰포트를 채워야 하므로 CSS(aspect-ratio 또는 height:100%)에 맡긴다.
   */
  resize() {
    const width = this.root.clientWidth || 1280;
    const height = this.root.clientHeight || Math.round((width * BOARD_SIZE.height) / BOARD_SIZE.width);
    this.camera.aspect = width / height;
    if (this.isWalking) this.camera.fov = this.#walkFov();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);
    if (this.mode === "orbit") Object.assign(this.orbit, this.#orbitTarget(TUNING.camera.presets[this.presetId]));
    this.#applyCamera();
  }

  /** 화면 좌표 → NDC */
  ndcFrom(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /**
   * 화면 좌표 → 높이 y의 수평면 위 월드 점.
   * 1인칭에서 지평선 위를 가리키면 광선이 바닥을 안 만난다. 그때는 null이다.
   */
  worldAt(clientX, clientY, height = 0) {
    const ndc = this.ndcFrom(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.groundPlane.constant = -height;
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, point)) return null;
    // 카메라 뒤나 지나치게 먼 곳은 버린다
    if (point.distanceTo(this.camera.position) > 200) return null;
    return point;
  }

  /**
   * 화면 좌표에서 오브젝트 집기.
   *
   * 월드 행렬을 먼저 갱신한다. 렌더 사이에 스토어가 바뀌어 오브젝트가 옮겨졌을 수 있고,
   * 그때 낡은 행렬로 레이캐스트하면 엉뚱한 것을 집는다. (배경 탭에서는 렌더가 아예 멈춘다.)
   */
  pick(clientX, clientY, objects) {
    if (objects.length === 0) return null;
    this.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndcFrom(clientX, clientY), this.camera);
    return this.raycaster.intersectObjects(objects, true)[0] ?? null;
  }

  /**
   * 월드 점 → 캔버스 안 화면 좌표(px). 마퀴 판정과 라벨 위치에 쓴다.
   *
   * 카메라 행렬을 먼저 갱신한다. project()는 matrixWorldInverse를 쓰는데 그것은 render()에서만
   * 갱신되므로, 그냥 부르면 **직전 프레임의 카메라**로 투영된다. 1인칭에서는 그 한 프레임이 눈에 띈다.
   */
  toScreen(worldPoint) {
    this.camera.updateMatrixWorld();
    const projected = worldPoint.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((1 - projected.y) / 2) * rect.height,
      behind: projected.z > 1,
    };
  }

  setPointer(clientX, clientY) {
    this.pointerNdc.copy(this.ndcFrom(clientX, clientY));
  }

  // ───────────────────────── 루프 ─────────────────────────

  start(onFrame) {
    this.renderer.setAnimationLoop(() => {
      const dt = Math.min(this.clock.getDelta(), 0.05);
      if (this.mode === "walk") this.#stepWalk(dt);
      else this.#stepOrbit(dt);
      onFrame(dt);
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
    });
  }

  /** 배경 탭에서는 렌더 루프가 멈춘다. 테스트가 손으로 한 프레임 돌릴 때 쓴다. */
  step(dt) {
    if (this.mode === "walk") this.#stepWalk(dt);
    else this.#stepOrbit(dt);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.scene.traverse((object) => {
      if (object.isMesh) {
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material?.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }
}
