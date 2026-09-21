/** Procedural room dressing. Decorative objects never participate in file hit testing. */
import * as THREE from "three";

const materials = new Map();
function material(color) {
  if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.92 }));
  return materials.get(color);
}

function roundedGeometry(w, h, d, r) {
  r = Math.min(r, w / 3, h / 3, d / 3);
  const shape = new THREE.Shape();
  const x = -w / 2 + r, y = -h / 2 + r;
  shape.moveTo(x, -h / 2);
  shape.lineTo(w / 2 - r, -h / 2);
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, y);
  shape.lineTo(w / 2, h / 2 - r);
  shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  shape.lineTo(x, h / 2);
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  shape.lineTo(-w / 2, y);
  shape.quadraticCurveTo(-w / 2, -h / 2, x, -h / 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: d - r, bevelEnabled: true, bevelSize: r / 2, bevelThickness: r / 2,
    bevelSegments: 2, steps: 1, curveSegments: 3,
  });
  geo.translate(0, 0, -(d - r) / 2);
  return geo;
}

export function roomBox(parent, size, position, color, radius = 0.04) {
  const geometry = radius ? roundedGeometry(...size, radius) : new THREE.BoxGeometry(...size);
  const mesh = new THREE.Mesh(geometry, material(color));
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(parent, top, bottom, height, position, color, segments = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, height, segments), material(color));
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function plant(parent, x, y, z, size = 1) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.scale.setScalar(size);
  parent.add(group);
  cylinder(group, 0.26, 0.19, 0.4, [0, 0.2, 0], "#d9cfba");
  cylinder(group, 0.235, 0.235, 0.018, [0, 0.4, 0], "#5e5842");
  cylinder(group, 0.025, 0.035, 0.78, [0, 0.76, 0], "#66724a", 6);
  for (let i = 0; i < 9; i++) {
    const a = i * 2.4;
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 7, 5), material(i % 2 ? "#798555" : "#596d43"));
    leaf.position.set(Math.cos(a) * 0.22, 0.57 + i * 0.068, Math.sin(a) * 0.22);
    leaf.scale.set(0.26, 0.1, 0.14);
    leaf.rotation.set(0.25, -a, 0.45);
    leaf.castShadow = true;
    group.add(leaf);
  }
}

function books(parent, x, y, z, count = 3) {
  const colors = ["#889071", "#d0bda0", "#b39177", "#e4d6bb"];
  for (let i = 0; i < count; i++) {
    const cover = roomBox(parent, [0.64 - i * 0.035, 0.105, 0.42], [x + (i % 2) * 0.04, y + i * 0.12 + 0.06, z], colors[i % colors.length], 0.015);
    cover.rotation.y = i % 2 ? 0.1 : -0.04;
    roomBox(cover, [0.55 - i * 0.035, 0.065, 0.025], [0, 0, 0.21], "#f0e8d6", 0);
  }
}

function lamp(parent, x, y, z, size = 1) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.scale.setScalar(size);
  parent.add(group);
  cylinder(group, 0.24, 0.28, 0.06, [0, 0.03, 0], "#937959");
  cylinder(group, 0.035, 0.035, 0.58, [0, 0.33, 0], "#937959");
  const shade = cylinder(group, 0.22, 0.4, 0.4, [0, 0.73, 0], "#efdfb6");
  shade.material = new THREE.MeshStandardMaterial({ color: "#f4e4c1", emissive: "#edd8a5", emissiveIntensity: 0.32, roughness: 1 });
  const light = new THREE.PointLight("#ffe2ac", 1.6, 3.5, 2);
  light.position.set(0, 0.62, 0);
  group.add(light);
}

function wallArt(parent, x, y, z, w, h, variant = 0) {
  roomBox(parent, [w, h, 0.075], [x, y, z], "#a48a66");
  const canvas = document.createElement("canvas");
  canvas.width = 384; canvas.height = 512;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#eee7d7"; ctx.fillRect(0, 0, 384, 512);
  if (variant === 0) {
    ctx.fillStyle = "#d7ba7a"; ctx.beginPath(); ctx.arc(260, 147, 52, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = ["#a7ae8c", "#829171", "#596c52"][i];
      ctx.beginPath(); ctx.moveTo(0, 320 + i * 38);
      ctx.quadraticCurveTo(160, 110 + i * 65, 384, 330 + i * 38);
      ctx.lineTo(384, 512); ctx.lineTo(0, 512); ctx.fill();
    }
  } else {
    ctx.strokeStyle = "#637654"; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(192, 438); ctx.lineTo(192, 88); ctx.stroke();
    ctx.fillStyle = "#788668";
    for (let i = 0; i < 7; i++) {
      ctx.beginPath(); ctx.ellipse(192 + (i % 2 ? 43 : -43), 135 + i * 40, 53, 21, i % 2 ? -0.55 : 0.55, 0, Math.PI * 2); ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const art = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.12, h - 0.12), new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }));
  art.position.set(x, y, z + 0.045);
  parent.add(art);
}

/** Room props stay outside the existing walking/card rectangle. */
export function furnishRoom(parent, half) {
  const left = -half.x + 1.48;
  const right = half.x - 1.12;
  const back = -half.z + 0.25;
  const wood = "#b9946d";

  // Bed along the left wall, clear of the playable floor.
  roomBox(parent, [2.55, 0.35, 4.05], [left, 0.36, -0.9], wood, 0.09);
  roomBox(parent, [2.6, 1.65, 0.18], [left, 0.95, -2.92], wood, 0.12);
  roomBox(parent, [2.43, 0.45, 3.85], [left, 0.73, -0.87], "#f1eadd", 0.16);
  roomBox(parent, [2.4, 0.23, 2.7], [left, 1.0, -0.26], "#a0a286", 0.1);
  roomBox(parent, [2.42, 0.11, 0.4], [left, 1.14, -1.55], "#b7b59b", 0.06);
  for (const dx of [-0.59, 0.59]) {
    const pillow = roomBox(parent, [1.04, 0.26, 0.65], [left + dx, 1.07, -2.13], "#ece3cd", 0.12);
    pillow.rotation.y = dx * 0.1;
  }
  // A narrow checked rug under the bed, never under file cards.
  roomBox(parent, [2.9, 0.025, 4.7], [left + 0.1, 0.015, -0.55], "#d4c9af", 0.01);
  for (let row = 0; row < 7; row++) for (let col = 0; col < 4; col++) {
    if ((row + col) % 2 === 0) roomBox(parent, [0.7, 0.009, 0.65], [left - 0.95 + col * 0.7, 0.031, -2.45 + row * 0.65], "#9b9e84", 0);
  }

  // Window on the back wall: daylight surface, wooden mullions and curtains.
  const window = new THREE.Group();
  window.position.set(-4.9, 3.12, back + 0.03);
  parent.add(window);
  roomBox(window, [3.25, 2.58, 0.13], [0, 0, 0], wood);
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(3.03, 2.36), new THREE.MeshBasicMaterial({ color: "#c4dae2" }));
  sky.position.z = 0.073; window.add(sky);
  for (let i = 0; i < 6; i++) {
    const block = roomBox(window, [0.33, 0.36 + i % 3 * 0.16, 0.015], [-1.18 + i * 0.46, -0.94 + i % 3 * 0.07, 0.086], i % 2 ? "#a1b6b0" : "#b5c1bc", 0);
    block.castShadow = false;
  }
  roomBox(window, [0.085, 2.4, 0.12], [0, 0, 0.13], "#e3d2b7", 0.02);
  roomBox(window, [3.18, 0.085, 0.12], [0, -0.16, 0.13], "#e3d2b7", 0.02);
  roomBox(window, [3.55, 0.13, 0.48], [0, -1.31, 0.2], wood);
  for (const sign of [-1, 1]) for (let i = 0; i < 4; i++) {
    roomBox(window, [0.17, 2.96, 0.13], [sign * (1.49 + i * 0.12), -0.13, 0.25 + Math.sin(i * 2) * 0.04], i % 2 ? "#e8dfca" : "#f2e9d6", 0.06);
  }
  plant(window, -1, -1.24, 0.25, 0.55);

  // Right-side work desk, monitor, chair and an open walking aisle.
  roomBox(parent, [1.85, 0.13, 3.5], [right, 1.6, -0.3], wood);
  for (const dx of [-0.72, 0.72]) for (const dz of [-1.45, 1.45]) roomBox(parent, [0.12, 1.5, 0.12], [right + dx, 0.78, -0.3 + dz], wood);
  const screenGroup = new THREE.Group();
  screenGroup.position.set(right + 0.32, 1.68, -1.0); screenGroup.rotation.y = -Math.PI / 2;
  parent.add(screenGroup);
  roomBox(screenGroup, [1.05, 0.72, 0.07], [0, 0.56, 0], "#4c5147");
  roomBox(screenGroup, [0.94, 0.59, 0.008], [0, 0.56, 0.04], "#84938a", 0);
  roomBox(screenGroup, [0.08, 0.3, 0.09], [0, 0.12, 0], "#4c5147");
  roomBox(screenGroup, [0.46, 0.025, 0.3], [0, 0, 0], "#4c5147");
  roomBox(parent, [0.85, 0.14, 0.86], [right - 0.9, 0.9, 0.6], "#808b6d", 0.07);
  roomBox(parent, [0.85, 0.9, 0.12], [right - 0.9, 1.3, 1.02], "#808b6d", 0.08);
  for (const dx of [-0.32, 0.32]) for (const dz of [-0.31, 0.31]) roomBox(parent, [0.07, 0.8, 0.07], [right - 0.9 + dx, 0.42, 0.6 + dz], "#6e624d", 0.015);
  books(parent, right, 1.68, 0.4);
  lamp(parent, right + 0.25, 1.68, 1.12, 0.75);

  wallArt(parent, -0.5, 3.5, back + 0.04, 1.7, 2.12);
  wallArt(parent, 2.0, 3.38, back + 0.04, 1.05, 1.48, 1);
  wallArt(parent, 5.0, 3.5, back + 0.04, 1.2, 1.7, 1);
  plant(parent, left + 0.05, 0, -4.35, 1.35);
  plant(parent, right - 0.03, 0, -3.7, 1.6);

  // Soft sun patches: low-opacity floor shapes, no screen-space postprocessing.
  const sunMaterial = new THREE.MeshBasicMaterial({ color: "#fff0cb", transparent: true, opacity: 0.14, depthWrite: false });
  for (let i = 0; i < 3; i++) {
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 3.0), sunMaterial);
    sun.rotation.set(-Math.PI / 2, 0, -0.52);
    sun.position.set(-3.8 + i * 1.35, 0.009, -0.7 + i * 0.55);
    parent.add(sun);
  }
  // 바닥 배치 충돌용 보수적인 가구 발자국. 위 가구 모델과 함께 갱신한다.
  return [
    { x: left, z: -0.9, width: 2.65, depth: 4.25 },
    { x: right, z: -0.3, width: 1.95, depth: 3.6 },
    { x: right - 0.9, z: 0.65, width: 0.95, depth: 1.1 },
    { x: left + 0.05, z: -4.35, width: 1.2, depth: 1.2 },
    { x: right - 0.03, z: -3.7, width: 1.4, depth: 1.4 },
  ];
}

/** Shelves are rebuilt only when target layout changes, not on selection updates. */
export function buildFolderShelf(parent, slots, width, depth, shelfY, height) {
  if (!slots.length) return;
  const min = Math.min(...slots.map(p => p.x)) - width / 2 - 0.12;
  const max = Math.max(...slots.map(p => p.x)) + width / 2 + 0.12;
  const z = slots[0].z;
  const center = (min + max) / 2;
  const total = max - min;
  const wood = "#a78058";
  roomBox(parent, [total + 0.16, 0.14, depth + 0.3], [center, shelfY - 0.07, z], wood);
  roomBox(parent, [total + 0.24, 0.13, depth + 0.37], [center, shelfY + height + 0.16, z], "#ba9468");
  roomBox(parent, [total, height + 0.22, 0.1], [center, shelfY + height / 2, z - depth / 2 - 0.13], "#917451", 0);
  const boundaries = [min, ...slots.slice(1).map((slot, i) => (slot.x + slots[i].x) / 2), max];
  for (const x of boundaries) roomBox(parent, [0.095, height + 0.24, depth + 0.3], [x, shelfY + height / 2, z], wood, 0.015);
  for (const x of [min + 0.12, max - 0.12]) roomBox(parent, [0.16, shelfY - 0.14, depth * 0.8], [x, (shelfY - 0.14) / 2, z], "#876c4e", 0.02);
  const top = shelfY + height + 0.225;
  books(parent, min + 0.5, top, z, 3);
  plant(parent, max - 0.45, top, z, 0.72);
}

/** 고정 크기의 수납칸. 벽 방향과 단 높이를 포함하며 위 칸에 장식이 끼지 않는다. */
export function buildShelfCells(parent, slots) {
  for (const slot of slots) {
    const group = new THREE.Group();
    group.position.set(slot.x, slot.y, slot.z);
    group.rotation.y = slot.yaw;
    parent.add(group);
    const { width: w, depth: d, height: h } = slot;
    roomBox(group, [w + 0.2, 0.12, d + 0.32], [0, -0.06, 0], "#a78058", 0.02);
    roomBox(group, [w + 0.2, 0.12, d + 0.32], [0, h + 0.19, 0], "#ba9468", 0.02);
    roomBox(group, [w + 0.2, h + 0.25, 0.08], [0, h / 2 + 0.065, -d / 2 - 0.12], "#917451", 0);
    for (const sign of [-1, 1]) {
      roomBox(group, [0.08, h + 0.25, d + 0.32], [sign * (w / 2 + 0.06), h / 2 + 0.065, 0], "#a78058", 0.015);
      if (slot.y < 0.5) roomBox(group, [0.12, slot.y - 0.12, d * 0.8], [sign * (w / 2 - 0.08), -(slot.y + 0.12) / 2, 0], "#876c4e", 0.02);
    }
  }
}

export function disposeRoomGroup(group) {
  const geometries = new Set();
  group.traverse(object => { if (object.geometry) geometries.add(object.geometry); });
  for (const geometry of geometries) geometry.dispose();
  group.clear();
}
