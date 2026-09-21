/** 폴더 ID와 방 안 위치만 관리한다. 파일/폴더 이동 API와 무관하다. */
export function rotatedSize(pose) {
  const c = Math.abs(Math.cos(pose.yaw ?? 0)), s = Math.abs(Math.sin(pose.yaw ?? 0));
  return { width: pose.width * c + pose.depth * s, depth: pose.width * s + pose.depth * c };
}

function axes(pose) {
  const c = Math.cos(pose.yaw ?? 0), s = Math.sin(pose.yaw ?? 0);
  return [{ x: c, z: -s }, { x: s, z: c }];
}

export function overlaps(a, b, gap = 0.06) {
  const aa = axes(a), ba = axes(b);
  const dot = (u, v) => u.x * v.x + u.z * v.z;
  const radius = (pose, basis, axis) => Math.abs(dot(basis[0], axis)) * pose.width / 2 + Math.abs(dot(basis[1], axis)) * pose.depth / 2;
  // 분리축 검사: 회전한 직사각형 네 축 모두 겹칠 때만 충돌한다.
  return [...aa, ...ba].every((axis) => Math.abs((a.x - b.x) * axis.x + (a.z - b.z) * axis.z) < radius(a, aa, axis) + radius(b, ba, axis) + gap);
}

export function rotateBox(yaw, steps) {
  const turn = Math.PI * 2;
  const angle = yaw + steps * Math.PI / 12;
  return ((angle % turn) + turn) % turn;
}

/** 회전한 위 상자의 네 모서리가 받침 면 안에 들어오는지 검사한다. */
export function fitsOn(pose, support, tolerance = 0.015) {
  const local = axes(support), basis = axes(pose);
  return [-1, 1].every(sx => [-1, 1].every(sz => {
    const x = pose.x - support.x + sx * pose.width / 2 * basis[0].x + sz * pose.depth / 2 * basis[1].x;
    const z = pose.z - support.z + sx * pose.width / 2 * basis[0].z + sz * pose.depth / 2 * basis[1].z;
    return Math.abs(x * local[0].x + z * local[0].z) <= support.width / 2 + tolerance &&
      Math.abs(x * local[1].x + z * local[1].z) <= support.depth / 2 + tolerance;
  }));
}

export function supportsBox(folderId, boxes) {
  return boxes.some(box => box.supportId === folderId);
}

function verticalOverlap(a, b) {
  return (a.y ?? 0) < (b.y ?? 0) + (b.height ?? 1.08) - 0.01 &&
    (b.y ?? 0) < (a.y ?? 0) + (a.height ?? 1.08) - 0.01;
}

export function validateBoxPlacement(pose, { bounds, obstacles = [], boxes = [], folderId, support, maxHeight = Infinity }) {
  if (!pose || ![pose.x, pose.z, pose.y ?? 0, pose.width, pose.depth, pose.yaw ?? 0].every(Number.isFinite)) return "바닥을 가리켜 주세요";
  if ((pose.y ?? 0) < 0 || (pose.y ?? 0) + (pose.height ?? 1.08) > maxHeight) return "방 높이를 넘는 위치예요";
  const size = rotatedSize(pose);
  if (pose.x - size.width / 2 < bounds.minX || pose.x + size.width / 2 > bounds.maxX ||
      pose.z - size.depth / 2 < bounds.minZ || pose.z + size.depth / 2 > bounds.maxZ) return "벽과 겹치는 위치예요";
  if (support && !fitsOn(pose, { x: pose.x, z: pose.z, ...support })) return "회전한 상자가 수납칸보다 커요";
  if (pose.supportId) {
    const base = boxes.find(box => box.folderId === pose.supportId && box.folderId !== folderId);
    if (!base || Math.abs(pose.y - ((base.y ?? 0) + (base.height ?? 1.08))) > 0.01) return "받쳐 줄 상자가 없어요";
    if (!fitsOn(pose, base)) return "아래 상자 밖으로 튀어나와요 · 휠로 방향을 맞춰 주세요";
  } else if (pose.y > 0.01 && !support) return "받침이 없는 공중에는 놓을 수 없어요";
  if (obstacles.some((obstacle) => overlaps(pose, obstacle) && (obstacle.height == null || verticalOverlap(pose, obstacle)))) return "가구와 겹치는 위치예요";
  if (boxes.some((box) => box.folderId !== folderId && verticalOverlap(pose, box) && overlaps(pose, box))) return "다른 상자와 겹치는 위치예요";
  return null;
}

export class BoxPlacementState {
  #positions = new Map();
  #history = [];
  get(folderId) { const pose = this.#positions.get(folderId); return pose ? { ...pose } : null; }
  supports(folderId) { return [...this.#positions.values()].some(pose => pose.supportId === folderId); }
  get lastMove() { const move = this.#history.at(-1); return move ? { ...move, from: { ...move.from } } : null; }
  commit(folderId, from, to, context) {
    if (this.supports(folderId) || supportsBox(folderId, context.boxes ?? [])) return "위에 놓인 상자를 먼저 옮겨 주세요";
    const error = validateBoxPlacement(to, { ...context, folderId });
    if (error) return error;
    this.#history.push({ folderId, from: { ...from } });
    this.#positions.set(folderId, { ...to });
    return null;
  }
  undo(context) {
    const move = this.lastMove;
    if (!move) return "되돌릴 상자 배치가 없습니다";
    if (this.supports(move.folderId) || supportsBox(move.folderId, context.boxes ?? [])) return "위에 놓인 상자를 먼저 옮겨 주세요";
    const error = validateBoxPlacement(move.from, { ...context, folderId: move.folderId });
    if (error) return error;
    this.#positions.set(move.folderId, { ...move.from });
    this.#history.pop();
    return null;
  }
}
