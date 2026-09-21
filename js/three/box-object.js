/**
 * box-object.js — 배송지 상자 하나. 뚜껑 없는 나무 상자.
 *
 * 앞면에 번호와 이름을 굽고, 위에 HTML 라벨을 띄운다. 카드가 조준되면 테두리가 밝아지고 살짝 뜬다.
 * `assets.js`의 MODEL_MANIFEST.box에 .glb를 넣으면 이 프리미티브 대신 들어간다.
 */
import { CSS2DObject } from "./scene-kit.js";
import { loadModel } from "./assets.js";
import { makeBoxTexture } from "./card-face.js";
import { TUNING, springStep } from "./tuning.js";

export class BoxObject {
  constructor(THREE, { id, width, depth }) {
    this.THREE = THREE;
    this.id = id;
    this.width = width;
    this.depth = depth;
    this.disposed = false;

    const { wall, height } = TUNING.box;
    this.group = new THREE.Group();
    this.group.userData.folderId = id;

    this.bodyMaterial = new THREE.MeshStandardMaterial({ color: TUNING.box.color, roughness: 0.88, metalness: 0.02 });
    this.rimMaterial = new THREE.MeshStandardMaterial({
      color: TUNING.box.rimColor,
      roughness: 0.6,
      metalness: 0.05,
      emissive: new THREE.Color("#000000"),
    });
    this.frontMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.85, metalness: 0 });

    this.parts = new THREE.Group();
    this.group.add(this.parts);

    // 바닥
    const floor = new THREE.Mesh(new THREE.BoxGeometry(width, wall, depth), this.bodyMaterial);
    floor.position.y = wall / 2;
    floor.receiveShadow = true;
    this.parts.add(floor);

    // 벽 넷. 앞벽(카메라 쪽, +Z)만 텍스처를 받는다.
    const sideGeometry = new THREE.BoxGeometry(wall, height, depth);
    for (const sign of [-1, 1]) {
      const side = new THREE.Mesh(sideGeometry, this.bodyMaterial);
      side.position.set((sign * (width - wall)) / 2, height / 2, 0);
      side.castShadow = true;
      side.receiveShadow = true;
      this.parts.add(side);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(width, height, wall), this.bodyMaterial);
    back.position.set(0, height / 2, -(depth - wall) / 2);
    back.castShadow = true;
    back.receiveShadow = true;
    this.parts.add(back);

    this.front = new THREE.Mesh(new THREE.BoxGeometry(width, height, wall), [
      this.bodyMaterial, this.bodyMaterial, this.bodyMaterial,
      this.bodyMaterial, this.frontMaterial, this.bodyMaterial,
    ]);
    this.front.position.set(0, height / 2, (depth - wall) / 2);
    this.front.castShadow = true;
    this.front.receiveShadow = true;
    this.parts.add(this.front);

    // Four separate rims leave the box genuinely OPEN (the old slab was a lid).
    this.rim = new THREE.Group();
    for (const sign of [-1, 1]) {
      const horizontal = new THREE.Mesh(new THREE.BoxGeometry(width + 0.02, 0.035, wall), this.rimMaterial);
      horizontal.position.set(0, height, sign * (depth - wall) / 2);
      const vertical = new THREE.Mesh(new THREE.BoxGeometry(wall, 0.035, depth), this.rimMaterial);
      vertical.position.set(sign * (width - wall) / 2, height, 0);
      this.rim.add(horizontal, vertical);
    }
    this.parts.add(this.rim);
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(width + 0.025, height + 0.025, depth + 0.025)),
      new THREE.LineBasicMaterial({ color: TUNING.box.targetRimColor, transparent: true, opacity: 0 }),
    );
    this.outline.position.y = height / 2;
    this.parts.add(this.outline);

    // 놓을 자리 하이라이트. 상자 안쪽 바닥이 밝아진다.
    this.innerGlowMaterial = new THREE.MeshBasicMaterial({
      color: TUNING.box.targetRimColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.innerGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(width - wall * 2.2, depth - wall * 2.2),
      this.innerGlowMaterial,
    );
    this.innerGlow.rotation.x = -Math.PI / 2;
    this.innerGlow.position.y = wall + 0.006;
    this.parts.add(this.innerGlow);

    // 쌓인 상자의 위·아래를 구분하도록 실제 부피에 맞춘 판정 영역.
    this.catcher = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.02, height + 0.02, depth + 0.02),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.catcher.position.y = height / 2;
    this.catcher.userData.folderId = id;
    this.group.add(this.catcher);

    this.label = document.createElement("div");
    this.label.className = "box-label-3d";
    this.labelObject = new CSS2DObject(this.label);
    this.labelObject.position.set(0, height + 0.34, 0);
    this.group.add(this.labelObject);

    this.state = { lift: 0, liftV: 0, glow: 0 };
    this.targeted = false;

    this.#swapInModel();
  }

  async #swapInModel() {
    const model = await loadModel(this.THREE, "box");
    if (!model || this.disposed) return;
    this.parts.visible = false;
    this.group.add(model);
    this.model = model;
  }

  /**
   * @param {object} info
   * @param {number} info.index      숫자 키 번호
   * @param {string} info.name
   * @param {string} info.subtitle
   * @param {boolean} info.isSelf    "← 여기에" 칸인가
   * @param {boolean} info.virtual
   * @param {boolean} info.canOpen
   */
  setInfo({ index, name, subtitle, isSelf, virtual, canOpen, fullPath }) {
    const accent = virtual ? TUNING.box.virtualRimColor : TUNING.box.targetRimColor;
    const palette = ["#a48d69", "#84876b", "#b2a285", "#737a60"];
    const bodyColor = palette[(index - 1) % palette.length];
    this.bodyMaterial.color.set(bodyColor);
    this.front.material[4] = this.frontMaterial;
    this.frontMaterial.map = makeBoxTexture(this.THREE, {
      index,
      name: isSelf ? `← ${name}` : name,
      subtitle,
      accent,
      bodyColor,
    });
    this.frontMaterial.needsUpdate = true;
    this.rimMaterial.color.set(virtual ? TUNING.box.virtualRimColor : TUNING.box.rimColor);
    this.isSelf = isSelf;

    this.baseLabel = isSelf ? `← ${name}` : name;
    this.label.textContent = this.baseLabel;
    this.label.dataset.self = String(Boolean(isSelf));
    this.label.dataset.virtual = String(Boolean(virtual));
    this.label.dataset.open = String(Boolean(canOpen));
    this.label.title = fullPath ?? name;
    this.label.dataset.subtitle = subtitle;
  }

  /** @param {number} [count] 지금 들고 있는 카드 수. 라벨에 "N장 넣기"로 보여 준다 */
  setTargeted(targeted, count = 0) {
    this.targeted = targeted;
    this.targetCount = count;
  }

  /** 폴더가 많아 한 줄에 다 못 들어갈 때 가로로 줄인다. 지오메트리는 그대로 두고 스케일만 바꾼다. */
  setWidth(width) {
    const ratio = width / this.width;
    if (Math.abs(this.group.scale.x - ratio) < 0.001) return;
    this.group.scale.x = ratio;
  }

  place(x, z, y = 0) {
    this.group.position.set(x, y, z);
  }

  update(dt) {
    const target = this.targeted ? TUNING.box.lift : 0;
    [this.state.lift, this.state.liftV] = springStep(this.state.lift, this.state.liftV, target, dt, TUNING.box.spring);
    this.parts.position.y = this.state.lift;
    if (this.model) this.model.position.y = this.state.lift;

    const glowTarget = this.targeted ? 1 : 0;
    this.state.glow += (glowTarget - this.state.glow) * Math.min(1, dt * 12);
    if (this.state.glow > 0.002) {
      this.rimMaterial.emissive.set(TUNING.box.targetRimColor).multiplyScalar(this.state.glow * 0.75);
    } else if (this.rimMaterial.emissive.r > 0) {
      this.rimMaterial.emissive.setScalar(0);
    }
    this.innerGlowMaterial.opacity = this.state.glow * TUNING.box.innerGlow;
    this.outline.material.opacity = this.state.glow * 0.95;

    this.label.dataset.targeted = String(this.targeted);
    const wanted = this.targeted && this.targetCount > 0 ? `${this.baseLabel} · ${this.targetCount}장 넣기` : this.baseLabel;
    if (this.label.textContent !== wanted) this.label.textContent = wanted;
  }

  /** 상자 안에 카드가 놓일 자리 */
  slotPosition(index) {
    const slot = index % 6;
    return this.group.localToWorld(new this.THREE.Vector3(
      (slot - 2.5) * 0.03, TUNING.box.wall + 0.03 + index * TUNING.card.placedStack,
      slot % 2 === 0 ? 0.02 : -0.02,
    ));
  }

  /** 옮기는 중인 카드가 잠깐 머무는 자리 (손에 붙어 있는 연출) */
  dockPosition(index) {
    const column = index % 3;
    const row = Math.floor(index / 3);
    return this.group.localToWorld(new this.THREE.Vector3(
      (column - 1) * 0.16, TUNING.box.height + 0.42 + row * 0.05, 0.1 + row * 0.04,
    ));
  }

  dispose() {
    this.disposed = true;
    this.labelObject.removeFromParent();
    this.label.remove();
    this.group.removeFromParent();
    this.bodyMaterial.dispose();
    this.rimMaterial.dispose();
    this.frontMaterial.dispose();
    this.innerGlowMaterial.dispose();
    this.outline.geometry.dispose();
    this.outline.material.dispose();
  }
}
