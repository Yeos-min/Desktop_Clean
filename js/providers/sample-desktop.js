/**
 * MemoryProvider용 샘플 바탕화면. 학기 말 바탕화면에 흔히 쌓이는 파일을 흉내 낸다.
 * 실제 파일이 아니다. 디스크를 건드리지 않는다.
 *
 * - SAMPLE_FOLDERS 바탕화면의 폴더(배송지). `children`은 하위 폴더, `existing`은 이미 들어 있는 항목 이름.
 * - SAMPLE_FILES   바탕화면의 loose 파일.
 * 일부 파일명은 폴더의 `existing`과 일부러 겹친다 → 동명 충돌(§5-2) 검증용.
 */

const KB = 1024;
const MB = 1024 * KB;
const DAY = 24 * 60 * 60 * 1000;

export const SAMPLE_FOLDERS = [
  {
    name: "과제",
    existing: ["발표자료_중간.pptx", "수업계획서.pdf"],
    children: [
      {
        name: "3D모델링",
        existing: ["3D모델링_과제3.blend"],
        children: [{ name: "과제3" }, { name: "과제4" }],
      },
      { name: "인터랙션디자인" },
      { name: "졸업연구" },
    ],
  },
  { name: "렌더", existing: ["렌더_0412.png"] },
  { name: "참고자료", children: [{ name: "논문" }, { name: "이미지" }] },
  {
    name: "졸업전시",
    existing: ["졸업전시_포스터_시안.psd"],
    children: [{ name: "포스터" }, { name: "리플렛" }],
  },
];

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  js: "text/javascript",
  mp4: "video/mp4",
  m4a: "audio/mp4",
  zip: "application/zip",
};

// [name, size, daysAgo]
const RAW_FILES = [
  ["렌더_0412.png", 2.4 * MB, 50],
  ["렌더_0413.png", 2.6 * MB, 49],
  ["렌더_0413_v2.png", 2.7 * MB, 49],
  ["렌더_0420_final.png", 3.1 * MB, 42],
  ["렌더_0421.png", 2.9 * MB, 41],
  ["3D모델링_과제3.blend", 18 * MB, 55],
  ["3D모델링_과제3_final.blend", 21 * MB, 48],
  ["3D모델링_과제3_final_v2.blend", 21.5 * MB, 47],
  ["3D모델링_과제4_초안.blend", 9 * MB, 20],
  ["졸업전시_포스터_시안.psd", 140 * MB, 30],
  ["졸업전시_포스터_시안2.psd", 152 * MB, 27],
  ["졸업전시_리플렛_앞면.ai", 12 * MB, 25],
  ["졸업전시_리플렛_뒷면.ai", 11 * MB, 25],
  ["발표자료_중간.pptx", 8.2 * MB, 60],
  ["발표자료_기말.pptx", 14 * MB, 5],
  ["발표자료_기말_수정.pptx", 14.3 * MB, 3],
  ["수업계획서.pdf", 420 * KB, 100],
  ["참고논문_인터랙션디자인.pdf", 1.8 * MB, 70],
  ["참고논문_공간인지.pdf", 2.2 * MB, 68],
  ["참고논문_게임화_동기부여_연구.pdf", 3.4 * MB, 66],
  ["스크린샷 2026-04-12 143201.png", 540 * KB, 50],
  ["스크린샷 2026-04-12 150822.png", 610 * KB, 50],
  ["스크린샷 2026-05-02 091533.png", 480 * KB, 30],
  ["스크린샷 2026-05-19 221004.png", 720 * KB, 13],
  ["KakaoTalk_20260501_123101.jpg", 1.1 * MB, 31],
  ["KakaoTalk_20260514_181940.jpg", 980 * KB, 18],
  ["KakaoTalk_20260514_181952.jpg", 1.0 * MB, 18],
  ["레퍼런스_01.jpg", 2.0 * MB, 80],
  ["레퍼런스_02.jpg", 1.7 * MB, 80],
  ["레퍼런스_03_무드보드.jpg", 4.1 * MB, 78],
  ["출석표_5월.xlsx", 38 * KB, 12],
  ["예산안_졸전.xlsx", 52 * KB, 22],
  ["노트.txt", 3 * KB, 9],
  ["새 텍스트 문서.txt", 0, 2],
  ["untitled.txt", 1 * KB, 40],
  ["main.js", 6 * KB, 35],
  ["로고_시안.svg", 88 * KB, 26],
  ["녹음_인터뷰_0503.m4a", 34 * MB, 29],
  ["영상_편집본_v3.mp4", 600 * MB, 8],
  ["과제제출_최종_진짜최종.zip", 96 * MB, 4],
  ["폰트_Pretendard.zip", 22 * MB, 90],
  ["명함_앞면.pdf", 1.2 * MB, 15],
  ["명함_뒷면.pdf", 1.1 * MB, 15],
  ["사진_전시장_답사.heic", 3.3 * MB, 24],
  ["아주_긴_파일_이름을_가진_문서_예시_정말로_길게_써본_파일.docx", 240 * KB, 7],
];

const BASE_TIME = Date.UTC(2026, 5, 20, 9, 0, 0); // 2026-06-20 학기 말

/** 샘플 모드에서 가짜 미리보기를 만들어 줄 확장자 */
export const SAMPLE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

function hashName(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * **개발용 대역.** 샘플 모드에는 실제 파일이 없으니 이름에서 만든 그림을 미리보기 대신 돌려준다.
 * 실제 모드(웹 드롭 / Helper)에서는 진짜 파일 바이트를 쓴다. 이 함수는 그쪽에서 호출되지 않는다.
 */
export function makeSampleImage(name) {
  const seed = hashName(name);
  const hue = seed % 360;
  const canvas = document.createElement("canvas");
  canvas.width = 360;
  canvas.height = 240;
  const ctx = canvas.getContext("2d");

  const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, `hsl(${hue} 62% 68%)`);
  sky.addColorStop(1, `hsl(${(hue + 40) % 360} 55% 38%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 사진처럼 보이도록 덩어리 몇 개
  for (let i = 0; i < 4; i += 1) {
    const n = (seed >> (i * 5)) & 0xff;
    ctx.fillStyle = `hsla(${(hue + 120 + i * 35) % 360} 70% ${35 + (n % 40)}% / 0.5)`;
    ctx.beginPath();
    ctx.ellipse(
      (n / 255) * canvas.width,
      canvas.height * (0.45 + ((n >> 3) % 10) / 20),
      40 + (n % 70),
      30 + (n % 50),
      (n / 255) * Math.PI,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fillRect(0, canvas.height * 0.62, canvas.width, 3);

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

export const SAMPLE_FILES = RAW_FILES.map(([name, size, daysAgo]) => {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return {
    name,
    size: Math.round(size),
    type: MIME[extension] ?? "",
    lastModified: BASE_TIME - daysAgo * DAY,
  };
});
