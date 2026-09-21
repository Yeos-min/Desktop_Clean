import { overlaps } from "./box-placement.js";

export function walkBlocked(point, { obstacles = [], radius, bounds }) {
  return point.x < bounds.minX || point.x > bounds.maxX || point.z < bounds.minZ || point.z > bounds.maxZ ||
    obstacles.some(obstacle => overlaps({ ...point, width: radius * 2, depth: radius * 2 }, obstacle, 0.02));
}

/** 배치 변경/스폰으로 가구 안에 들어간 경우 가장 가까운 빈 보행 위치를 찾는다. */
export function safeWalkPosition(point, context) {
  if (!walkBlocked(point, context)) return { ...point };
  const { bounds } = context;
  let best = null, distance = Infinity;
  const step = 0.2;
  for (let x = bounds.minX; x <= bounds.maxX; x += step) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += step) {
      const d = (x - point.x) ** 2 + (z - point.z) ** 2;
      if (d >= distance || walkBlocked({ x, z }, context)) continue;
      best = { x, z }; distance = d;
    }
  }
  return best;
}

export function moveWalker(point, delta, context) {
  const safe = safeWalkPosition(point, context);
  if (!safe) return { ...point };
  const result = { ...safe };
  // 낮은 프레임 속도/달리기에서도 얇은 장애물을 건너뛰지 않는다.
  const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.z) / Math.min(0.2, context.radius / 2)));
  for (let i = 0; i < steps; i++) {
    const x = result.x + delta.x / steps;
    if (!walkBlocked({ x, z: result.z }, context)) result.x = x;
    const z = result.z + delta.z / steps;
    if (!walkBlocked({ x: result.x, z }, context)) result.z = z;
  }
  return result;
}

/** 한글 입력 상태에서도 물리적인 WASD 키로 이동한다. */
export function movementKey(event) {
  const code = event.code ?? "";
  if (/^Key[WASD]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Shift(Left|Right)$/.test(code)) return "shift";
  return event.key.toLowerCase();
}
