import assert from "node:assert/strict";
import test from "node:test";

import { SAMPLE_FILES } from "../js/providers/sample-desktop.js";
import { stackHeights, thicknessMultiplier, thicknessOf } from "../js/three/stacking.js";
import { TUNING } from "../js/three/tuning.js";

const CARD = { width: 172, height: 104 };
const KB = 1024;
const MB = 1024 * KB;

function heightsOf(entries) {
  return stackHeights(entries, CARD);
}

test("thickness grows with file size on a log scale and stays inside the configured range", () => {
  const { min, max } = TUNING.card.thicknessRange;
  assert.equal(thicknessMultiplier(0), min, "빈 파일은 가장 얇다");
  assert.ok(thicknessMultiplier(700 * MB) <= max + 1e-9);
  const sizes = [0, 3 * KB, 500 * KB, 10 * MB, 150 * MB, 600 * MB];
  const values = sizes.map(thicknessMultiplier);
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] > values[i - 1], `${sizes[i]}가 ${sizes[i - 1]}보다 얇다`);
    assert.ok(values[i] >= min && values[i] <= max);
  }
  // 로그라서 작은 파일들끼리도 구분이 되어야 한다. 선형이면 여기가 전부 뭉갠다.
  assert.ok(values[1] - values[0] > 0.15, "3KB와 0바이트가 구분되지 않는다");
  assert.ok(thicknessOf(600 * MB) / thicknessOf(0) > 5, "가장 두꺼운 것과 얇은 것의 차이가 너무 작다");
});

test("cards that do not overlap all rest on the desk", () => {
  const heights = heightsOf([
    { id: "a", x: 0, y: 0, size: MB },
    { id: "b", x: 400, y: 0, size: MB },
    { id: "c", x: 0, y: 300, size: MB },
  ]);
  assert.deepEqual([...heights.values()], [0, 0, 0]);
});

test("a card dropped on another rests on its top face, not inside it", () => {
  const heights = heightsOf([
    { id: "under", x: 100, y: 100, size: 150 * MB }, // 두꺼운 카드
    { id: "over", x: 110, y: 105, size: 3 * KB }, // 얇은 카드가 그 위로
  ]);
  assert.equal(heights.get("under"), 0);
  const expected = thicknessOf(150 * MB) + TUNING.card.stackGap;
  assert.ok(Math.abs(heights.get("over") - expected) < 1e-9, `${heights.get("over")} != ${expected}`);
  assert.ok(heights.get("over") > thicknessOf(3 * KB), "얇은 카드가 두꺼운 카드 속을 뚫고 있다");
});

test("stacks accumulate: the third card sits above the first two", () => {
  const entries = [
    { id: "a", x: 100, y: 100, size: MB },
    { id: "b", x: 104, y: 102, size: MB },
    { id: "c", x: 108, y: 104, size: MB },
  ];
  const heights = heightsOf(entries);
  assert.equal(heights.get("a"), 0);
  assert.ok(heights.get("b") > heights.get("a"));
  assert.ok(heights.get("c") > heights.get("b"));
  const step = thicknessOf(MB) + TUNING.card.stackGap;
  assert.ok(Math.abs(heights.get("c") - step * 2) < 1e-9);
});

test("a card that merely grazes another stays on the desk", () => {
  // 가로로 8px만 겹친다 — 카드 넓이의 0.5%
  const heights = heightsOf([
    { id: "a", x: 100, y: 100, size: MB },
    { id: "b", x: 264, y: 100, size: MB },
  ]);
  assert.equal(heights.get("b"), 0, "스치기만 해도 떠오르면 책상이 들썩인다");

  // 절반 넘게 겹치면 얹힌다
  const solid = heightsOf([
    { id: "a", x: 100, y: 100, size: MB },
    { id: "b", x: 180, y: 100, size: MB },
  ]);
  assert.ok(solid.get("b") > 0);
});

test("order decides who is on top; the same layout in reverse flips the stack", () => {
  const layout = [
    { id: "first", x: 100, y: 100, size: MB },
    { id: "second", x: 110, y: 100, size: MB },
  ];
  const forward = heightsOf(layout);
  const reversed = heightsOf([...layout].reverse());
  assert.equal(forward.get("first"), 0);
  assert.ok(forward.get("second") > 0);
  assert.equal(reversed.get("second"), 0);
  assert.ok(reversed.get("first") > 0);
});

test("a card bridging two stacks rests on the taller one", () => {
  const heights = heightsOf([
    { id: "low", x: 0, y: 100, size: 3 * KB },
    { id: "high", x: 200, y: 100, size: 600 * MB },
    { id: "bridge", x: 120, y: 100, size: MB }, // 둘 다와 크게 겹친다
  ]);
  const expected = thicknessOf(600 * MB) + TUNING.card.stackGap;
  assert.ok(Math.abs(heights.get("bridge") - expected) < 1e-9, "낮은 쪽에 맞춰 파묻혔다");
});

test("a realistic desk of sample files never leaves a card floating or buried", () => {
  // 격자 배치(겹침 없음)에서는 전부 책상 높이여야 한다
  const grid = SAMPLE_FILES.slice(0, 12).map((file, index) => ({
    id: `f${index}`,
    x: (index % 4) * 190,
    y: Math.floor(index / 4) * 122,
    size: file.size,
  }));
  const heights = heightsOf(grid);
  assert.deepEqual([...heights.values()].filter((y) => y !== 0), []);

  // 한 점에 쏟아부으면 계단처럼 쌓인다
  const heap = SAMPLE_FILES.slice(0, 6).map((file, index) => ({
    id: `h${index}`,
    x: 300 + index * 6,
    y: 200 + index * 4,
    size: file.size,
  }));
  const stacked = [...heightsOf(heap).values()];
  for (let i = 1; i < stacked.length; i += 1) {
    assert.ok(stacked[i] > stacked[i - 1], `${i}번째가 아래 카드를 뚫었다`);
  }
});
