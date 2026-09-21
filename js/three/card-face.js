/**
 * card-face.js — 카드 윗면에 구워 넣는 텍스처.
 *
 * 3D는 정보량을 줄이는 방향으로 작동한다. 그래서 파일명은 오브젝트 자체에 박아 둔다. (CLAUDE.md §12)
 * 가리키거나 고른 카드에는 board-3d가 별도의 HTML 라벨을 더 크게 띄운다.
 *
 * 이미지 파일은 종이 여백 안에 실제 미리보기를 넣는다. 파일명은 사진 밖에 인쇄한다.
 *
 * 나중에 실제 모델로 바꿔도 이 텍스처는 그대로 쓸 수 있다. 모델의 윗면 머티리얼 map에 넣으면 된다.
 */
import { formatSize } from "../ui/board-layout.js";
import { TUNING } from "./tuning.js";

/** 브라우저가 실제로 디코딩할 수 있는 것만. heic·tiff 등은 시도하지 않는다. */
export const THUMBNAIL_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"]);
const MAX_THUMBNAIL_BYTES = 25 * 1024 * 1024;

const cache = new Map();

export function canPreview(item) {
  return THUMBNAIL_EXTENSIONS.has((item.extension ?? "").toLowerCase()) && item.size > 0 && item.size <= MAX_THUMBNAIL_BYTES;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 폭에 맞춰 줄바꿈. 긴 단어는 글자 단위로 자른다 (파일명은 공백이 없을 때가 많다). */
function wrap(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let line = "";
  for (const char of text) {
    const next = line + char;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = char;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (ctx.measureText(last).width > maxWidth - 14) {
      lines[maxLines - 1] = `${last.slice(0, Math.max(1, last.length - 2))}…`;
    }
  }
  return lines;
}

function extLabel(item) {
  return item.extension ? item.extension.toUpperCase().slice(0, 5) : "FILE";
}

/** 미리보기가 없을 때: 종이에 인쇄된 라벨 */
function drawPaperFace(ctx, item, color, width, height) {
  ctx.fillStyle = TUNING.card.faceColor;
  ctx.fillRect(0, 0, width, height);

  // A printed document glyph, not a synthetic preview of the user's file.
  ctx.fillStyle = "#e0dbc9";
  roundRect(ctx, 143, 22, 114, 102, 6); ctx.fill();
  ctx.fillStyle = "#a3a28f";
  for (let line = 0; line < 5; line++) ctx.fillRect(159, 41 + line * 14, line === 4 ? 48 : 82, 5);
  ctx.fillStyle = "#3b3c32";
  ctx.textBaseline = "middle";
  ctx.font = "600 25px 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif";
  wrap(ctx, item.name, width - 40, 2).forEach((line, index) => ctx.fillText(line, 20, 153 + index * 29));
  const ext = extLabel(item);
  ctx.font = "700 17px 'Segoe UI', system-ui, sans-serif";
  const chipWidth = ctx.measureText(ext).width + 16;
  ctx.fillStyle = color;
  roundRect(ctx, width - chipWidth - 20, height - 32, chipWidth, 24, 4); ctx.fill();
  ctx.fillStyle = "#494935";
  ctx.fillText(ext, width - chipWidth - 12, height - 19);
  ctx.fillStyle = "#888575";
  ctx.font = "16px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(formatSize(item.size), 20, height - 19);
}

/** 미리보기가 있을 때: 사진을 채우고 글자를 그 위에 얹는다 */
function drawPhotoFace(ctx, item, color, bitmap, width, height) {
  ctx.fillStyle = TUNING.card.faceColor;
  ctx.fillRect(0, 0, width, height);
  const inset = 20;
  const photoWidth = width - inset * 2;
  const photoHeight = height - 94;
  const scale = Math.max(photoWidth / bitmap.width, photoHeight / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  ctx.save();
  roundRect(ctx, inset, inset, photoWidth, photoHeight, 5);
  ctx.clip();
  ctx.drawImage(bitmap, (width - drawWidth) / 2, inset + (photoHeight - drawHeight) / 2, drawWidth, drawHeight);
  ctx.restore();
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#3b3c32";
  ctx.font = "600 24px 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif";
  ctx.fillText(wrap(ctx, item.name, width - 40, 1)[0] ?? item.name, 20, height - 47);
  ctx.fillStyle = "#637c96";
  roundRect(ctx, width - 83, height - 31, 63, 24, 4); ctx.fill();
  ctx.fillStyle = "#fff9ed";
  ctx.font = "700 16px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(extLabel(item), width - 77, height - 18);
  ctx.fillStyle = "#888575";
  ctx.font = "16px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(formatSize(item.size), 20, height - 18);
}

/**
 * @param {object} THREE
 * @param {{ id?: string, name: string, extension: string, size: number }} item
 * @param {string} color  계열 색
 * @param {(item: object) => Promise<Blob|null>} [loadThumbnail]
 *   이미지 바이트를 가져오는 함수. 없으면 종이 얼굴로 남는다.
 *   비동기라 텍스처를 먼저 돌려주고, 도착하면 같은 캔버스에 다시 그려 needsUpdate만 올린다.
 */
export function makeCardTexture(THREE, item, color, loadThumbnail) {
  const key = `${item.id ?? ""}|${item.name}|${item.extension}|${item.size}|${color}`;
  if (cache.has(key)) return cache.get(key);

  const { width, height } = TUNING.label.texture;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  drawPaperFace(ctx, item, color, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  cache.set(key, texture);

  if (loadThumbnail && canPreview(item)) {
    loadThumbnail(item)
      .then(async (blob) => {
        if (!blob) return null;
        // 6000px 사진을 원본 크기로 디코딩하지 않는다
        return createImageBitmap(blob, { resizeWidth: width, resizeQuality: "medium" }).catch(() =>
          createImageBitmap(blob),
        );
      })
      .then((bitmap) => {
        if (!bitmap || texture.image !== canvas) return;
        drawPhotoFace(ctx, item, color, bitmap, width, height);
        texture.needsUpdate = true;
        bitmap.close?.();
      })
      .catch(() => {
        // 못 읽는 이미지는 종이 얼굴 그대로 둔다. 장면은 죽지 않는다.
      });
  }

  return texture;
}

/** 상자 앞면에 붙일 번호 + 이름 */
export function makeBoxTexture(THREE, { index, name, subtitle, accent, bodyColor = "#a99775" }) {
  const key = `box|${index}|${name}|${subtitle}|${accent}|${bodyColor}`;
  if (cache.has(key)) return cache.get(key);

  const width = 512;
  const height = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = bodyColor;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.09)";
  ctx.fillRect(0, 0, width, 6);

  ctx.fillStyle = "#383a2b";
  roundRect(ctx, 199, 31, 114, 22, 7);
  ctx.fill();
  ctx.fillStyle = "#e9dfc6";
  roundRect(ctx, 54, 107, 404, 103, 6);
  ctx.fill();
  ctx.fillStyle = "#484737";
  ctx.font = "700 34px 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(wrap(ctx, name, 368, 1)[0] ?? name, width / 2, 143);
  ctx.fillStyle = "#827b65";
  ctx.font = "500 20px 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif";
  ctx.fillText(`${index} · ${subtitle}`, width / 2, 180);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  cache.set(key, texture);
  return texture;
}

export function disposeCardTextures() {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}
