/**
 * stacking.js — 카드의 두께와 "누가 누구 위에 얹히는가".
 *
 * 순수 함수만 있다. three를 부르지 않으므로 Node에서 그대로 테스트한다.
 *
 * 왜 필요한가: 두께가 파일마다 다르므로 "한 장 = 일정 높이"로 계산할 수 없다.
 * 겹친 카드는 아래 카드의 **실제 윗면**을 찾아 그 위에 올려야 무더기로 읽힌다.
 * 그냥 겹쳐만 두면 얇은 카드가 두꺼운 카드 속을 뚫고 지나간다.
 */
import { TUNING } from "./tuning.js";

/**
 * 파일 크기 → 두께 배율. 로그 척도라 3KB와 600MB가 둘 다 알아볼 수 있게 벌어진다.
 * 선형으로 하면 큰 파일 하나가 나머지를 전부 종이처럼 만든다.
 */
export function thicknessMultiplier(size) {
  const kb = Math.max(0, size ?? 0) / 1024;
  const { min, max } = TUNING.card.thicknessRange;
  const span = Math.log10(1 + TUNING.card.thicknessReferenceKb);
  const t = Math.min(1, Math.log10(1 + kb) / span);
  return min + (max - min) * t;
}

/** 파일 크기 → 월드 두께 */
export function thicknessOf(size) {
  return TUNING.card.thickness * thicknessMultiplier(size);
}

/**
 * 책상에 놓인 카드들의 높이를 구한다.
 *
 * @param {Array<{id: string, x: number, y: number, size: number}>} entries
 *   논리 좌표(카드 좌상단)와 파일 크기. **아래에 깔릴 것부터** 순서대로 넘긴다 (stackSeq 순).
 * @param {{width: number, height: number}} card  논리 카드 크기
 * @returns {Map<string, number>} id → 얹힐 월드 높이 (책상이 0)
 */
export function stackHeights(entries, card) {
  const minOverlap = card.width * card.height * TUNING.card.stackOverlap;
  const heights = new Map();
  const laid = [];

  for (const entry of entries) {
    let rest = 0;
    for (const other of laid) {
      const overlapX = Math.min(entry.x + card.width, other.x + card.width) - Math.max(entry.x, other.x);
      const overlapY = Math.min(entry.y + card.height, other.y + card.height) - Math.max(entry.y, other.y);
      // 살짝 스친 것만으로 떠오르면 책상이 들썩여 보인다
      if (overlapX <= 0 || overlapY <= 0 || overlapX * overlapY < minOverlap) continue;
      rest = Math.max(rest, other.top);
    }
    heights.set(entry.id, rest);
    laid.push({ x: entry.x, y: entry.y, top: rest + thicknessOf(entry.size) + TUNING.card.stackGap });
  }

  return heights;
}
