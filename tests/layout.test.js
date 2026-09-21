import assert from "node:assert/strict";
import test from "node:test";

import { SAMPLE_FILES } from "../js/providers/sample-desktop.js";
import {
  LAYOUT_DEFAULTS,
  extensionOf,
  familyOf,
  groupItems,
  placeItems,
  prefixOf,
  rectsOverlap,
  slotCount,
} from "../js/ui/layout.js";

const BOUNDS = { x: 0, y: 0, width: 1280, height: 570 };
const { card } = LAYOUT_DEFAULTS;

function items(names) {
  return names.map((name, index) => ({ id: `f${index}`, name, extension: extensionOf(name) }));
}

function rects(placed) {
  return [...placed.entries()].map(([id, spot]) => ({ id, ...spot, width: card.width, height: card.height }));
}

function assertNoOverlap(list, gap = 0) {
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      assert.equal(rectsOverlap(list[i], list[j], gap), false, `${list[i].id}와 ${list[j].id}가 겹친다`);
    }
  }
}

function assertInside(list, bounds) {
  for (const rect of list) {
    assert.ok(rect.x >= bounds.x && rect.x + rect.width <= bounds.x + bounds.width, `${rect.id} x 범위 밖`);
    assert.ok(rect.y >= bounds.y && rect.y + rect.height <= bounds.y + bounds.height, `${rect.id} y 범위 밖`);
  }
}

test("prefixOf and familyOf read name patterns", () => {
  assert.equal(prefixOf("렌더_0412.png"), "렌더");
  assert.equal(prefixOf("스크린샷 2026-04-12 143201.png"), "스크린샷");
  assert.equal(prefixOf("KakaoTalk_20260501_123101.jpg"), "kakaotalk");
  assert.equal(prefixOf("3D모델링_과제3.blend"), "", "숫자로 시작하면 접두어 없음");
  assert.equal(prefixOf("새 텍스트 문서.txt"), "", "한 글자는 접두어가 아니다");
  assert.equal(familyOf("blend"), "model3d");
  assert.equal(familyOf("PSD"), "design");
  assert.equal(familyOf("weird"), "other");
});

test("groupItems uses a shared prefix first and falls back to the extension family", () => {
  const groups = groupItems(items(["렌더_01.png", "렌더_02.png", "노트.txt", "수업계획서.pdf", "main.js"]));
  assert.deepEqual([...groups.keys()].sort(), ["f:code", "f:document", "p:렌더"]);
  assert.equal(groups.get("f:document").length, 2);
});

test("placeItems keeps 16 cards inside bounds, non-overlapping, and lightly rotated", () => {
  const list = rects(placeItems({ items: items(SAMPLE_FILES.slice(0, 16).map((file) => file.name)), bounds: BOUNDS }));
  assert.equal(list.length, 16);
  assertInside(list, BOUNDS);
  assertNoOverlap(list);
  for (const rect of list) assert.ok(Math.abs(rect.rot) <= LAYOUT_DEFAULTS.maxRotation, `${rect.id} 회전 ${rect.rot}`);
});

test("placeItems fills every slot at the board's physical limit and leaves the rest unplaced", () => {
  const limit = slotCount(BOUNDS);
  assert.ok(limit >= 16, `슬롯 ${limit}개 — 기본 정원 16을 담을 수 있어야 한다`);
  const placed = placeItems({ items: items(SAMPLE_FILES.slice(0, limit + 6).map((file) => file.name)), bounds: BOUNDS });
  assert.equal(placed.size, limit, "슬롯 수만큼만 놓는다");
  const list = rects(placed);
  assertInside(list, BOUNDS);
  assertNoOverlap(list);
});

test("cards that share a name pattern end up nearer their own cluster than other clusters", () => {
  const names = [
    "렌더_01.png", "렌더_02.png", "렌더_03.png", "렌더_04.png",
    "과제_a.pdf", "과제_b.pdf", "과제_c.pdf", "과제_d.pdf",
    "스크린샷 1.png", "스크린샷 2.png", "스크린샷 3.png", "스크린샷 4.png",
  ];
  const placed = placeItems({ items: items(names), bounds: BOUNDS });
  const centroids = new Map();
  for (const spot of placed.values()) {
    const sum = centroids.get(spot.group) ?? { x: 0, y: 0, n: 0 };
    sum.x += spot.x;
    sum.y += spot.y;
    sum.n += 1;
    centroids.set(spot.group, sum);
  }
  assert.equal(centroids.size, 3);
  for (const spot of placed.values()) {
    const own = centroids.get(spot.group);
    const ownDistance = Math.hypot(spot.x - own.x / own.n, spot.y - own.y / own.n);
    for (const [group, sum] of centroids) {
      if (group === spot.group) continue;
      const otherDistance = Math.hypot(spot.x - sum.x / sum.n, spot.y - sum.y / sum.n);
      assert.ok(ownDistance < otherDistance, `${spot.group} 카드가 ${group} 군집에 더 가깝다`);
    }
  }
});

test("placement is deterministic for the same set and changes with the seed", () => {
  const set = items(SAMPLE_FILES.slice(0, 12).map((file) => file.name));
  const first = placeItems({ items: set, bounds: BOUNDS });
  const second = placeItems({ items: set, bounds: BOUNDS });
  const reseeded = placeItems({ items: set, bounds: BOUNDS, seed: 42 });
  assert.deepEqual([...first.entries()], [...second.entries()]);
  assert.notDeepEqual([...first.entries()], [...reseeded.entries()]);
});

test("a later wave avoids cards already on the board and joins its own cluster", () => {
  const firstWave = items(["렌더_01.png", "렌더_02.png", "과제_a.pdf", "과제_b.pdf", "노트.txt", "main.js"]);
  const first = placeItems({ items: firstWave, bounds: BOUNDS });
  const existing = rects(first);

  const secondWave = ["렌더_03.png", "렌더_04.png", "과제_c.pdf", "KakaoTalk_1.jpg"].map((name, index) => ({
    id: `s${index}`,
    name,
    extension: extensionOf(name),
  }));
  const second = placeItems({ items: secondWave, bounds: BOUNDS, existing });
  const all = [...existing, ...rects(second)];

  assertInside(all, BOUNDS);
  assertNoOverlap(all);

  const render01 = first.get("f0");
  const render03 = second.get("s0");
  const task03 = second.get("s2");
  assert.ok(
    Math.hypot(render03.x - render01.x, render03.y - render01.y) < Math.hypot(task03.x - render01.x, task03.y - render01.y),
    "새 렌더 카드는 기존 렌더 카드 근처에 놓인다",
  );
});
