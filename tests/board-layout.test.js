import assert from "node:assert/strict";
import test from "node:test";

import {
  BOARD_SIZE,
  FAMILIES,
  boxZoneFor,
  familyClass,
  familyColor,
  formatSize,
  playBoundsFor,
  truncateMiddle,
} from "../js/ui/board-layout.js";
import { SAMPLE_FILES } from "../js/providers/sample-desktop.js";
import { extensionOf } from "../js/ui/layout.js";

// 2D 보드와 3D 장면이 같은 좌표계·분류를 쓴다. 어긋나면 두 화면이 다르게 읽힌다.

test("play area and box zone tile the board without overlapping", () => {
  for (const placement of ["bottom", "right", "far"]) {
    const play = playBoundsFor(placement);
    const zone = boxZoneFor(placement);
    assert.equal(play.width * play.height + zone.width * zone.height, BOARD_SIZE.width * BOARD_SIZE.height, placement);
    const overlapX = Math.min(play.x + play.width, zone.x + zone.width) - Math.max(play.x, zone.x);
    const overlapY = Math.min(play.y + play.height, zone.y + zone.height) - Math.max(play.y, zone.y);
    assert.ok(overlapX <= 0 || overlapY <= 0, `${placement}: 두 영역이 겹친다`);
    for (const rect of [play, zone]) {
      assert.ok(rect.x >= 0 && rect.y >= 0);
      assert.ok(rect.x + rect.width <= BOARD_SIZE.width && rect.y + rect.height <= BOARD_SIZE.height);
    }
  }
});

test("far places folders at the top of the board so a first-person player faces them", () => {
  const zone = boxZoneFor("far");
  const play = playBoundsFor("far");
  assert.equal(zone.y, 0, "폴더 띠가 먼 쪽(논리 y=0)에 있어야 한다");
  assert.equal(play.y, zone.height, "카드 영역은 그 뒤부터");
  // bottom과 정확히 위아래가 뒤집힌 관계여야 한다
  assert.equal(zone.height, boxZoneFor("bottom").height);
  assert.equal(play.height, playBoundsFor("bottom").height);
});

test("familyClass covers every sample file and only returns known families", () => {
  const known = new Set(FAMILIES);
  const seen = new Set();
  for (const file of SAMPLE_FILES) {
    const family = familyClass(extensionOf(file.name));
    assert.ok(known.has(family), `${file.name} → ${family}`);
    seen.add(family);
  }
  assert.ok(seen.size >= 8, `샘플이 ${seen.size}개 계열만 덮는다 — 색 구분 검증이 약하다`);
  assert.equal(familyClass("PNG"), "image", "대문자도 같은 계열");
  assert.equal(familyClass(""), "other");
  assert.equal(familyClass(undefined), "other");
  assert.equal(familyClass("lnk"), "shortcut");
});

test("familyColor returns a hex color for every family without a DOM", () => {
  for (const family of FAMILIES) {
    assert.match(familyColor(family), /^#[0-9a-f]{6}$/i, family);
  }
  assert.equal(familyColor("존재하지않음"), familyColor("other"));
});

test("truncateMiddle keeps the extension and never exceeds the budget", () => {
  const long = "아주_긴_파일_이름을_가진_문서_예시_정말로_길게_써본_파일.docx";
  const short = truncateMiddle(long, 28);
  assert.ok(short.length <= 28, short);
  assert.ok(short.endsWith(".docx"));
  assert.ok(short.includes("…"));
  assert.equal(truncateMiddle("노트.txt", 28), "노트.txt", "짧으면 그대로");
  assert.equal(truncateMiddle("확장자없음", 28), "확장자없음");
});

test("formatSize switches units and keeps at most one decimal", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(20 * 1024 * 1024), "20 MB");
  assert.equal(formatSize(1024 ** 4), "1.0 TB");
});
