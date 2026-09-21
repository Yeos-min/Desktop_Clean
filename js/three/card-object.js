/**
 * card-object.js — 파일 카드 하나.
 *
 * 프리미티브는 모서리를 둥글린 얇은 판이다. 윗면에 파일명 텍스처를 굽는다 (card-face.js).
 * `assets.js`의 MODEL_MANIFEST.card에 .glb를 넣으면 이 판 대신 그 모델이 들어간다.
 * 스프링·기울기·그림자 같은 손맛 코드는 모델이 바뀌어도 그대로 쓰인다.
 */
import { familyColor } from "../ui/board-layout.js";
import { loadModel } from "./assets.js";
import { makeCardTexture } from "./card-face.js";
import { thicknessMultiplier } from "./stacking.js";
import { TUNING, springStep } from "./tuning.js";

let sharedGeometry = null;

/** 모서리 둥근 직사각형을 눕혀서 판으로. UV는 0..1로 정규화한다. */
function buildCardGeometry(THREE, width, depth, thickness) {
  const w = width;
  const h = depth;
  const r = Math.min(TUNING.card.corner, Math.min(w, h) / 2 - 0.01);
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 + r, -h / 2);
  shape.lineTo(w / 2 - r, -h / 2);
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  shape.lineTo(w / 2, h / 2 - r);
  shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  shape.lineTo(-w / 2 + r, h / 2);
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  shape.lineTo(-w / 2, -h / 2 + r);
  shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);

  const bevel = TUNING.card.bevel;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, thickness - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 6,
    UVGenerator: {
      generateTopUV(_geometry, vertices, indexA, indexB, indexC) {
        return [indexA, indexB, indexC].map((index) => {
          const x = vertices[index * 3];
          const y = vertices[index * 3 + 1];
          return new THREE.Vector2((x + w / 2) / w, (y + h / 2) / h);
        });
      },
      generateSideWallUV(_geometry, vertices, indexA, indexB, indexC, indexD) {
        return [indexA, indexB, indexC, indexD].map((index) => {
          const x = vertices[index * 3];
          const z = vertices[index * 3 + 2];
          return new THREE.Vector2((x + w / 2) / w, z / Math.max(thickness, 0.001));
        });
      },
    },
  });
  geometry.translate(0, 0, -thickness / 2 + bevel);
  geometry.rotateX(-Math.PI / 2); // 눕힌다: 판의 앞면이 위를 본다
  geometry.computeVertexNormals();
  return geometry;
}

export class CardObject {
  /**
   * @param {object} THREE
   * @param {object} args
   * @param {string} args.id
   * @param {{name:string,extension:string,size:number}} args.item
   * @param {number} args.width  월드 단위
   * @param {number} args.depth
   */
  constructor(THREE, { id, item, width, depth, loadThumbnail }) {
    this.THREE = THREE;
    this.id = id;
    this.item = item;
    this.width = width;
    this.depth = depth;
    this.color = familyColor(item.family);
    this.disposed = false;

    if (!sharedGeometry) sharedGeometry = buildCardGeometry(THREE, width, depth, TUNING.card.thickness);
    this.geometry = sharedGeometry;

    const tint = new THREE.Color(this.color).lerp(new THREE.Color(TUNING.card.faceColor), 1 - TUNING.card.edgeTint);
    this.baseSideColor = tint.clone();
    this.statusColors = {
      conflict: new THREE.Color(TUNING.card.conflictColor),
      error: new THREE.Color(TUNING.card.errorColor),
    };
    this.faceMaterial = new THREE.MeshStandardMaterial({
      map: makeCardTexture(THREE, item, this.color, loadThumbnail),
      roughness: 0.82,
      metalness: 0.02,
      emissive: new THREE.Color("#000000"),
      emissiveIntensity: 1,
    });
    this.sideMaterial = new THREE.MeshStandardMaterial({
      color: tint,
      roughness: 0.7,
      metalness: 0.04,
      emissive: new THREE.Color("#000000"),
      emissiveIntensity: 1,
    });

    this.group = new THREE.Group();
    this.group.userData.cardId = id;

    this.mesh = new THREE.Mesh(this.geometry, [this.faceMaterial, this.sideMaterial]);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData.cardId = id;
    // 파일 크기만큼 두꺼워지고, 책상 위에 얹힌다 (지오메트리는 y=0을 중심으로 만들어져 있다)
    this.thicknessScale = thicknessMultiplier(item.size);
    this.thickness = TUNING.card.thickness * this.thicknessScale;
    this.mesh.scale.y = this.thicknessScale;
    this.mesh.position.y = this.thickness / 2;
    this.group.add(this.mesh);

    // 집기 판정을 너그럽게 하는 보이지 않는 상자
    this.hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(width * 1.04, 0.34, depth * 1.04),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.hitbox.position.y = 0.12;
    this.hitbox.userData.cardId = id;
    this.group.add(this.hitbox);

    this.state = {
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      spin: 0, spinV: 0,
      tiltX: 0, tiltXV: 0,
      tiltZ: 0, tiltZV: 0,
      scale: 1, scaleV: 0,
      facePitch: 0, facePitchV: 0,
    };
    this.target = { x: 0, y: 0, z: 0, spin: 0, scale: 1, facePitch: 0 };
    this.spring = TUNING.card.spring;
    this.follow = 1;
    this.selected = false;
    this.hovered = false;
    this.status = "idle";
    this.glow = 0;
    this.flash = 0;

    this.#swapInModel();
  }

  async #swapInModel() {
    const model = await loadModel(this.THREE, "card", this.item.family);
    if (!model || this.disposed) return;
    this.mesh.visible = false;
    model.scale.y *= this.thicknessScale; // 모델도 파일 크기만큼 두꺼워진다
    this.group.add(model);
    this.model = model;
  }

  /** 애니메이션 없이 그 자리에 놓는다 (첫 등장) */
  place({ x, y = 0, z, spin = 0, scale = 1 }) {
    Object.assign(this.state, { x, y, z, spin, scale, vx: 0, vy: 0, vz: 0, spinV: 0, scaleV: 0 });
    Object.assign(this.target, { x, y, z, spin, scale });
    this.#apply();
  }

  setTarget({ x, y, z, spin, scale, facePitch = 0 }) {
    if (x !== undefined) this.target.x = x;
    if (y !== undefined) this.target.y = y;
    if (z !== undefined) this.target.z = z;
    if (spin !== undefined) this.target.spin = spin;
    if (scale !== undefined) this.target.scale = scale;
    this.target.facePitch = facePitch;
  }

  setStatus(status) {
    this.status = status;
  }

  setSelected(selected) {
    this.selected = selected;
  }

  setHovered(hovered) {
    this.hovered = hovered;
  }

  /** 충돌로 튕겨 돌아올 때 */
  reject() {
    this.state.vy += TUNING.card.rejectHop * 4;
    this.state.tiltZV += (Math.random() > 0.5 ? 1 : -1) * TUNING.card.rejectWobble * 12;
    this.flash = 1;
  }

  /** 더미에서 쏟아져 나올 때 */
  spillFrom({ x, z }, delay = 0) {
    this.state.x = x;
    this.state.z = z;
    this.state.y = TUNING.supplyRise;
    this.state.scale = 0.55;
    this.state.vy = 0;
    this.delay = delay;
    this.#apply();
  }

  update(dt) {
    if (this.delay > 0) {
      this.delay -= dt;
      if (this.delay > 0) return;
      this.delay = 0;
    }
    const s = this.state;
    const spring = this.spring;
    const scaled = { freq: spring.freq * this.follow, damping: spring.damping };

    [s.x, s.vx] = springStep(s.x, s.vx, this.target.x, dt, scaled);
    [s.z, s.vz] = springStep(s.z, s.vz, this.target.z, dt, scaled);
    [s.y, s.vy] = springStep(s.y, s.vy, this.target.y, dt, { freq: scaled.freq * 1.15, damping: spring.damping });
    [s.spin, s.spinV] = springStep(s.spin, s.spinV, this.target.spin, dt, scaled);
    [s.scale, s.scaleV] = springStep(s.scale, s.scaleV, this.target.scale, dt, { freq: 7, damping: 0.85 });
    [s.facePitch, s.facePitchV] = springStep(s.facePitch, s.facePitchV, this.target.facePitch, dt, { freq: 7, damping: 1 });

    // 움직이는 방향으로 기운다. 속도가 곧 손의 관성이다.
    const tiltZTarget = Math.max(-TUNING.card.tiltMax, Math.min(TUNING.card.tiltMax, -s.vx * TUNING.card.tiltPerSpeed));
    const tiltXTarget = Math.max(-TUNING.card.tiltMax, Math.min(TUNING.card.tiltMax, s.vz * TUNING.card.tiltPerSpeed));
    [s.tiltZ, s.tiltZV] = springStep(s.tiltZ, s.tiltZV, tiltZTarget, dt, { freq: 6, damping: 0.7 });
    [s.tiltX, s.tiltXV] = springStep(s.tiltX, s.tiltXV, tiltXTarget, dt, { freq: 6, damping: 0.7 });

    const glowTarget = this.selected ? TUNING.card.selectGlow : this.hovered ? TUNING.card.selectGlow * 0.4 : 0;
    this.glow += (glowTarget - this.glow) * Math.min(1, dt * 14);
    this.flash = Math.max(0, this.flash - dt * 2.2);

    // 충돌·실패는 섬광이 지나간 뒤에도 옆면 색으로 남는다. 왜 안 들어갔는지 계속 보여야 한다.
    const statusColor = this.statusColors[this.status];
    this.sideMaterial.color.lerp(statusColor ?? this.baseSideColor, Math.min(1, dt * 9));

    this.#apply();
  }

  #apply() {
    const s = this.state;
    this.group.position.set(s.x, s.y, s.z);
    this.group.rotation.set(s.facePitch + s.tiltX, s.spin, s.tiltZ, "YXZ");
    this.group.scale.setScalar(s.scale);

    const emissive = this.faceMaterial.emissive;
    if (this.flash > 0.001) {
      emissive.setRGB(this.flash * 0.55, 0, 0);
      this.sideMaterial.emissive.setRGB(this.flash * 0.55, 0, 0);
    } else if (this.glow > 0.001) {
      const c = new this.THREE.Color("#d9ff57").multiplyScalar(this.glow * 0.5);
      emissive.copy(c);
      this.sideMaterial.emissive.copy(c);
    } else if (emissive.r + emissive.g + emissive.b > 0) {
      emissive.setScalar(0);
      this.sideMaterial.emissive.setScalar(0);
    }
  }

  get position() {
    return this.group.position;
  }

  dispose() {
    this.disposed = true;
    this.faceMaterial.dispose();
    this.sideMaterial.dispose();
    this.hitbox.geometry.dispose();
    this.hitbox.material.dispose();
    this.group.removeFromParent();
  }
}

export function disposeSharedCardGeometry() {
  sharedGeometry?.dispose();
  sharedGeometry = null;
}
