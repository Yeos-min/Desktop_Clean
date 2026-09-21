import { overlaps } from "./box-placement.js";

// 이름을 읽을 수 있는 고정 크기. 가구 사이 빈 벽을 따라 확장하고 두 단까지만 쓴다.
export const SHELF_BOX = { width: 1.7, depth: 1.12 };
export function folderShelfSlots(half, obstacles, shelfY = 0.34, height = 1.08) {
  const { width, depth } = SHELF_BOX;
  const pitch = width + 0.24;
  const edgeX = half.x - depth / 2 - 0.42, edgeZ = half.z - depth / 2 - 0.42;
  const candidates = [];
  const add = (x, z, yaw) => {
    const footprint = { x, z, yaw, width: width + 0.22, depth: depth + 0.34 };
    if (obstacles.some(obstacle => overlaps(footprint, obstacle, 0.08))) return;
    if (candidates.some(slot => overlaps(footprint, { ...slot, width: width + 0.22, depth: depth + 0.34 }, 0.01))) return;
    candidates.push({ x, z, yaw, width, depth });
  };
  // 중앙 네 칸부터 시작. 폴더 수가 바뀌어도 기존 칸의 좌표는 변하지 않는다.
  const columns = [-1.5, -0.5, 0.5, 1.5];
  for (let n = 2.5; n * pitch + width / 2 < half.x - 0.4; n++) columns.push(-n, n);
  for (const n of columns) add(n * pitch, -edgeZ, 0);
  for (let z = -edgeZ + pitch; z < edgeZ - width / 2; z += pitch) {
    add(-edgeX, z, Math.PI / 2);
    add(edgeX, z, -Math.PI / 2);
  }
  for (const n of columns) add(n * pitch, edgeZ, Math.PI);
  return [0, 1].flatMap(level => candidates.map((slot, index) => ({
    ...slot, y: shelfY + level * (height + 0.25), height,
    slotId: `${level}:${index}`,
  })));
}

/** 같은 폴더는 같은 슬롯을 유지한다. 직접 놓은 상자와 겹치는 신규 슬롯은 건너뛴다. */
export class FolderShelfAssignments {
  #indices = new Map();
  assign(ids, slots, custom = new Map()) {
    if (!slots.length) return new Map();
    const used = new Set(ids.filter(id => this.#indices.has(id)).map(id => this.#indices.get(id)));
    for (const id of ids) {
      if (this.#indices.has(id)) continue;
      let index = 0;
      while (used.has(index) || [...custom].some(([customId, pose]) => {
        if (Math.floor((this.#indices.get(customId) ?? -1) / slots.length) !== Math.floor(index / slots.length)) return false;
        const slot = slots[index % slots.length];
        return pose.y < slot.y + slot.height + 0.25 && pose.y + slot.height > slot.y - 0.12 && overlaps(pose, slot);
      })) {
        index++;
      }
      this.#indices.set(id, index);
      used.add(index);
    }
    return new Map(ids.map(id => [id, this.#indices.get(id)]));
  }
}
