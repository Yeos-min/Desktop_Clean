/**
 * board-layout.js — 2D 보드와 3D 장면이 공유하는 좌표계·분류·표기.
 *
 * 좌표는 "논리 단위"다. 보드는 언제나 1280 × 720이고, 화면 크기와 무관하다.
 * 2D는 CSS scale로 줄이고, 3D는 UNIT(0.01)을 곱해 월드 좌표로 옮긴다.
 * layout.js가 만든 카드 위치가 두 장면에서 똑같이 읽히는 이유가 이것이다.
 */

export const BOARD_SIZE = Object.freeze({ width: 1280, height: 720 });

/** 배송지 상자가 차지하는 띠. 나머지가 카드가 놓이는 책상이다. */
export const BOX_ZONE = Object.freeze({ bottom: 150, right: 300 });

/**
 * placement:
 *   "bottom" 화면 아래 한 줄 (사선 카메라 기본)
 *   "right"  화면 오른쪽 세로열
 *   "far"    보드 **먼 쪽** 한 줄. 1인칭에서 쓴다 — 플레이어는 가까운 쪽에 서고 폴더는 앞에 있어야 한다.
 */
export function playBoundsFor(placement) {
  if (placement === "right") {
    return { x: 0, y: 0, width: BOARD_SIZE.width - BOX_ZONE.right, height: BOARD_SIZE.height };
  }
  if (placement === "far") {
    return { x: 0, y: BOX_ZONE.bottom, width: BOARD_SIZE.width, height: BOARD_SIZE.height - BOX_ZONE.bottom };
  }
  return { x: 0, y: 0, width: BOARD_SIZE.width, height: BOARD_SIZE.height - BOX_ZONE.bottom };
}

/** 상자 띠의 논리 사각형 */
export function boxZoneFor(placement) {
  if (placement === "right") {
    return { x: BOARD_SIZE.width - BOX_ZONE.right, y: 0, width: BOX_ZONE.right, height: BOARD_SIZE.height };
  }
  if (placement === "far") {
    return { x: 0, y: 0, width: BOARD_SIZE.width, height: BOX_ZONE.bottom };
  }
  return { x: 0, y: BOARD_SIZE.height - BOX_ZONE.bottom, width: BOARD_SIZE.width, height: BOX_ZONE.bottom };
}

const FAMILY_TABLE = [
  ["image", ["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "svg", "tif", "tiff"]],
  ["design", ["psd", "ai", "xd", "fig", "sketch", "indd"]],
  ["model3d", ["blend", "fbx", "obj", "glb", "gltf", "stl", "max", "c4d"]],
  ["document", ["pdf", "doc", "docx", "hwp", "hwpx", "txt", "md", "rtf"]],
  ["slides", ["ppt", "pptx", "key"]],
  ["sheet", ["xls", "xlsx", "csv"]],
  ["video", ["mp4", "mov", "avi", "mkv", "webm"]],
  ["audio", ["mp3", "wav", "m4a", "flac", "aac"]],
  ["archive", ["zip", "7z", "rar", "tar", "gz"]],
  ["code", ["js", "ts", "py", "html", "css", "json", "c", "cpp", "java", "cs", "sh"]],
  ["shortcut", ["lnk", "url"]],
];

const FAMILY_BY_EXTENSION = new Map(FAMILY_TABLE.flatMap(([family, list]) => list.map((ext) => [ext, family])));

export const FAMILIES = [...FAMILY_TABLE.map(([family]) => family), "other"];

export function familyClass(extension) {
  return FAMILY_BY_EXTENSION.get((extension ?? "").toLowerCase()) ?? "other";
}

/**
 * 계열 색은 CSS 변수(--family-*)가 원본이다. 3D도 같은 값을 읽어 쓴다.
 * 테마를 바꾸려면 styles.css만 고치면 된다.
 */
const FALLBACK_COLORS = {
  image: "#7fd1ff",
  design: "#d6a3ff",
  model3d: "#ffb36b",
  document: "#f1f0e8",
  slides: "#ff9e9e",
  sheet: "#8ee6a5",
  video: "#ffd66b",
  audio: "#a7b8ff",
  archive: "#c9c4a7",
  code: "#9fe8d8",
  shortcut: "#989e91",
  other: "#989e91",
};

let cssColorCache = null;

export function familyColor(family) {
  if (!cssColorCache) {
    cssColorCache = {};
    const styles = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
    for (const name of FAMILIES) {
      const fromCss = styles?.getPropertyValue(`--family-${name}`)?.trim();
      cssColorCache[name] = fromCss || FALLBACK_COLORS[name] || FALLBACK_COLORS.other;
    }
  }
  return cssColorCache[family] ?? cssColorCache.other;
}

/** 가운데 생략. 확장자는 남긴다. */
export function truncateMiddle(name, max = 28) {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const base = dot > 0 ? name.slice(0, dot) : name;
  const keep = Math.max(4, max - ext.length - 1);
  const head = base.slice(0, Math.max(2, keep - 4));
  const tail = base.slice(-4);
  return `${head}…${tail}${ext}`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export const STAGE_LABEL = Object.freeze({
  queued: "대기",
  moving: "옮기는 중",
  placed: "완료",
  failed: "실패",
});
