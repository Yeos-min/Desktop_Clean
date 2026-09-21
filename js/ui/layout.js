/**
 * layout.js — 초기 배치. 순수 함수. DOM 없음.
 *
 * 문자열 유사도(확장자 계열, 이름 접두어)는 여기서만, 시각적 배치에만 쓴다. (CLAUDE.md §11)
 * 목적지 추천이나 자동 이동에는 쓰지 않는다.
 *
 * 방식: 카드+간격 크기의 격자 슬롯을 만들고, 군집이 연속 슬롯(2행 띠 단위)을 차지하게 한 뒤
 * 간격 절반 이하의 지터와 작은 회전만 준다. → 겹침 0, 화면 밖 0이 구조적으로 보장된다.
 * 보드에 놓을 수 있는 카드 수는 슬롯 수로 제한된다. (slotCount)
 *
 * 아래 수치는 전부 [임시] — 0-C에서 검증할 가설이다. 확정 사양이 아니다.
 */

export const LAYOUT_DEFAULTS = Object.freeze({
  card: Object.freeze({ width: 172, height: 104 }),
  gap: 18, // 슬롯 사이 간격. 지터 최대치는 gap/2 - 1 이라 겹치지 않는다
  maxRotation: 4, // 도. "작은 회전값"
  separators: true, // 여유 슬롯이 있으면 군집 사이에 빈 슬롯을 하나 둔다
});

const FAMILY_TABLE = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic", "svg"],
  design: ["psd", "ai", "xd", "fig", "sketch", "indd"],
  model3d: ["blend", "fbx", "obj", "glb", "gltf", "stl", "max", "c4d"],
  document: ["pdf", "doc", "docx", "hwp", "hwpx", "txt", "md", "rtf", "pages"],
  slides: ["ppt", "pptx", "key"],
  sheet: ["xls", "xlsx", "csv", "numbers"],
  video: ["mp4", "mov", "avi", "mkv", "webm"],
  audio: ["mp3", "wav", "m4a", "flac", "aac"],
  archive: ["zip", "7z", "rar", "tar", "gz"],
  code: ["js", "ts", "py", "html", "css", "json", "c", "cpp", "java", "cs", "sh"],
};

const FAMILY_BY_EXTENSION = new Map(
  Object.entries(FAMILY_TABLE).flatMap(([family, extensions]) => extensions.map((ext) => [ext, family])),
);

export function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function familyOf(extension) {
  return FAMILY_BY_EXTENSION.get((extension ?? "").toLowerCase()) ?? "other";
}

/** 이름 앞의 글자 연속(2자 이상). "렌더_0412" → "렌더", "스크린샷 2026-..." → "스크린샷", "3D모델링" → "" */
export function prefixOf(name) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const match = base.match(/^\p{L}{2,}/u);
  return match ? match[0].toLowerCase() : "";
}

/**
 * 같은 접두어가 2개 이상이면 접두어 군집, 아니면 확장자 계열 군집.
 * @returns {Map<string, Array<{id:string,name:string,extension?:string}>>}
 */
export function groupItems(items) {
  const prefixCounts = new Map();
  for (const item of items) {
    const prefix = prefixOf(item.name);
    if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const groups = new Map();
  for (const item of items) {
    const prefix = prefixOf(item.name);
    const key =
      prefix && (prefixCounts.get(prefix) ?? 0) >= 2
        ? `p:${prefix}`
        : `f:${familyOf(item.extension ?? extensionOf(item.name))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

export function hashString(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32. 같은 시드 → 같은 배치. */
export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rectsOverlap(a, b, gap = 0) {
  return (
    a.x < b.x + b.width + gap &&
    b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap &&
    b.y < a.y + a.height + gap
  );
}

function resolveConfig(config = {}) {
  return { ...LAYOUT_DEFAULTS, ...config, card: { ...LAYOUT_DEFAULTS.card, ...(config.card ?? {}) } };
}

function gridOf(bounds, cfg) {
  const cellW = cfg.card.width + cfg.gap;
  const cellH = cfg.card.height + cfg.gap;
  const cols = Math.max(0, Math.floor((bounds.width - cfg.gap) / cellW));
  const rows = Math.max(0, Math.floor((bounds.height - cfg.gap) / cellH));
  return {
    cols,
    rows,
    cellW,
    cellH,
    originX: bounds.x + cfg.gap + (bounds.width - cfg.gap - cols * cellW) / 2,
    originY: bounds.y + cfg.gap + (bounds.height - cfg.gap - rows * cellH) / 2,
  };
}

/** 이 영역에 놓을 수 있는 카드 수 */
export function slotCount(bounds, config) {
  const { cols, rows } = gridOf(bounds, resolveConfig(config));
  return cols * rows;
}

/**
 * 슬롯을 "2행 띠, 띠 안에서는 열 우선, 띠마다 방향 교대" 순서로 나열한다.
 * 연속 슬롯이 2×N 덩어리가 되므로 군집이 블록처럼 보인다.
 */
function bandOrderedSlots(grid, card) {
  const slots = [];
  for (let band = 0; band < grid.rows; band += 2) {
    const bandRows = [band, band + 1].filter((row) => row < grid.rows);
    const leftToRight = (band / 2) % 2 === 0;
    for (let c = 0; c < grid.cols; c += 1) {
      const col = leftToRight ? c : grid.cols - 1 - c;
      for (const row of bandRows) {
        slots.push({
          x: grid.originX + col * grid.cellW,
          y: grid.originY + row * grid.cellH,
          width: card.width,
          height: card.height,
          used: false,
        });
      }
    }
  }
  return slots;
}

/**
 * 카드를 군집별로 느슨하게 모아 놓는다.
 *
 * @param {object} args
 * @param {Array<{id:string,name:string,extension?:string}>} args.items  새로 놓을 카드
 * @param {{x:number,y:number,width:number,height:number}} args.bounds  놓을 수 있는 영역
 * @param {Array<{x:number,y:number,width:number,height:number,group?:string}>} [args.existing]  이미 놓인 카드 (움직이지 않음)
 * @param {number} [args.seed]  없으면 이름 목록에서 만든다 → 같은 세트는 같은 배치
 * @param {Partial<typeof LAYOUT_DEFAULTS>} [args.config]
 * @returns {Map<string, {x:number,y:number,rot:number,group:string}>}  자리가 없는 카드는 빠진다
 */
export function placeItems({ items, bounds, existing = [], seed, config = {} }) {
  const cfg = resolveConfig(config);
  const { card, gap } = cfg;
  const result = new Map();
  if (!items || items.length === 0) return result;

  const grid = gridOf(bounds, cfg);
  if (grid.cols === 0 || grid.rows === 0) return result;

  const random = createRandom(seed ?? hashString(items.map((item) => item.name).sort().join("|")));
  const jitterMax = Math.max(0, Math.floor(gap / 2) - 1);
  const slots = bandOrderedSlots(grid, card);

  // 이미 놓인 카드(드래그로 옮겨진 것 포함)에 지터 거리 안까지 닿는 슬롯은 막는다
  for (const slot of slots) {
    slot.used = existing.some((obstacle) => rectsOverlap(slot, obstacle, jitterMax));
  }

  const groups = groupItems(items);
  const keys = [...groups.keys()].sort(
    (a, b) => groups.get(b).length - groups.get(a).length || (a < b ? -1 : 1),
  );

  // 이미 보드에 있는 같은 군집의 무게중심 → 새 카드는 그 근처 슬롯부터 채운다
  const centroids = new Map();
  for (const rect of existing) {
    if (!rect.group) continue;
    const sum = centroids.get(rect.group) ?? { x: 0, y: 0, n: 0 };
    sum.x += rect.x;
    sum.y += rect.y;
    sum.n += 1;
    centroids.set(rect.group, sum);
  }

  let separators = cfg.separators ? Math.max(0, slots.filter((slot) => !slot.used).length - items.length) : 0;

  keys.forEach((key, index) => {
    let candidates = slots.filter((slot) => !slot.used);
    const known = centroids.get(key);
    if (known) {
      const cx = known.x / known.n;
      const cy = known.y / known.n;
      candidates = [...candidates].sort(
        (a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy),
      );
    }

    for (const item of groups.get(key)) {
      const slot = candidates.shift();
      if (!slot) break; // 자리가 없다. 호출자가 대기 더미에 남긴다
      slot.used = true;
      result.set(item.id, {
        x: Math.round(slot.x + (random() * 2 - 1) * jitterMax),
        y: Math.round(slot.y + (random() * 2 - 1) * jitterMax),
        rot: Math.round((random() * 2 - 1) * cfg.maxRotation * 10) / 10,
        group: key,
      });
    }

    if (separators > 0 && !known && index < keys.length - 1) {
      const spacer = slots.find((slot) => !slot.used);
      if (spacer) {
        spacer.used = true;
        separators -= 1;
      }
    }
  });

  return result;
}
