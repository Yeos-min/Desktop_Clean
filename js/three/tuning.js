/**
 * tuning.js — 3D 장면의 모든 숫자. 전부 `[임시]`다. 손맛은 여기를 고치며 찾는다.
 *
 * 코드 곳곳에 숫자를 흩뿌리지 않는다. 값 하나를 바꾸려고 파일 세 개를 열지 않기 위해서다.
 * 브라우저 콘솔에서 `window.__tuning`으로 실시간으로 만질 수 있다 (board-3d.js가 걸어 둔다).
 */

export const UNIT = 0.01; // 논리 1px → 월드 0.01. 보드 1280×720 → 12.8×7.2

export const TUNING = {
  camera: {
    /** 프리셋: elevation은 수평선 기준 각도(90 = 완전 탑다운), azimuth는 좌우 회전 */
    presets: {
      diagonal: { label: "사선", elevation: 52, azimuth: 0, fov: 34, fit: 0.97, targetBias: -0.3 },
      low: { label: "낮은 사선", elevation: 38, azimuth: 0, fov: 32, fit: 1.08, targetBias: -0.8 },
      top: { label: "탑다운", elevation: 84, azimuth: 0, fov: 34, fit: 0.99, targetBias: 0 },
    },
    default: "walk",
    /** 포인터를 따라 아주 살짝 흔들리는 시차. 0이면 완전 고정. 1인칭에서는 안 쓴다 */
    parallax: 0.16,
    parallaxSmoothing: 5,
    moveSpring: 3.2, // 프리셋 전환 속도
  },

  /**
   * 1인칭. 방 안에 서서 둘러본다. `[임시]`
   * 참고 게임 둘 다 1인칭이고, 몰입의 대부분이 "방 안에 있다"에서 나온다 (§2-1).
   */
  firstPerson: {
    label: "1인칭",
    eyeHeight: 3.1,
    /**
     * 시야각. 넓을수록 주변 시야의 흐름이 커져 멀미가 심해진다.
     * 방의 가구와 중앙 정리 공간이 함께 보이는 초기값. `[임시]`
     */
    fov: 66,
    /**
     * 시작할 때 바닥을 내려다보는 각도.
     * 수납장과 방을 먼저 보여주고, 가까운 파일은 시점을 내려 확인한다.
     */
    pitch: -19,
    pitchRange: [-78, 24],
    moveSpeed: 7.0,
    sprintMultiplier: 1.9,
    lookSensitivity: 0.10, // 픽셀당 도 (커서 드래그용)
    /**
     * 이동 가속·감속. 크면 즉각적이고 작으면 미끄러진다.
     * 미끄러지는 느낌은 멀미의 큰 원인이다 — 눈이 보는 움직임과 몸이 예상하는 것이 어긋난다.
     */
    moveSmoothing: 18,
    /**
     * 보드 가까운 쪽 가장자리에서 이만큼 물러나 선다.
     * 너무 붙으면 발 앞의 카드가 화면 아래로 잘린다.
     */
    spawnBack: 2.6,
    bodyRadius: 0.7, // 벽과 상자에 파고들지 않게

    /**
     * ── 멀미 관련 `[임시]` ──
     * 머리 흔들림은 멀미의 대표적인 원인이라 기본은 꺼 둔다. 손맛이 아쉬우면 0.02쯤부터 올려 본다.
     */
    headBob: 0,
    headBobSpeed: 9,
    /** 포인터 락 감도. 픽셀당 도 — 락에서는 movementX가 오므로 커서 드래그와 값이 다르다 */
    lockedSensitivity: 0.075,
    /**
     * 시점 부드럽게. 1이면 즉시(마우스 이벤트가 듬성듬성하면 확확 튄다), 낮을수록 미끄럽다.
     * 너무 낮추면 입력 지연이 생겨 그것대로 멀미를 부른다. 0.3~0.5 사이가 무난하다.
     */
    lookSmoothing: 0.38,

    /**
     * 손. 집은 카드가 시야 앞에 들려 있는 자리.
     * 카메라 오른쪽 아래를 따라가며, 카드 앞면이 보이도록 세운다.
     */
    hand: {
      distance: 2.05,
      height: -0.64, // 카메라 기준 아래쪽
      side: 0.92,
      pitch: 1.12,
      scale: 0.65,
      rise: 0.025, // 한 장 쌓일 때마다
      back: 0.018, // 뒤 카드가 물러나는 정도
      fan: 0.04, // 옆으로 펴지는 정도. 몇 장 들었는지 보이게
      spring: { freq: 7.5, damping: 0.85 },
      maxVisible: 5, // 나머지는 HUD의 개수로 표시한다
    },

    /** 조준선으로 쓸어 담기 */
    gather: {
      /** 버튼을 누른 채 훑으면 조준선에 닿는 카드가 손으로 온다 */
      sweep: true,
    },
  },

  /** 1인칭에서만 세우는 방 */
  room: {
    wallHeight: 5.8,
    wallThickness: 0.4,
    color: "#e3d8c5",
    trimColor: "#bc9f7c",
    margin: 220,
    shelfY: 0.34,
    shelfBack: 1.55,
  },

  /**
   * 따뜻한 나무 책상. 정리 시뮬레이터들은 예외 없이 밝고 채도가 높다.
   * 어두운 무채색은 "작업 도구"로 읽히고, 따뜻한 나무는 "물건이 놓인 곳"으로 읽힌다.
   */
  desk: {
    // 따뜻한 나무와 밝은 종이의 대비.
    color: "#ba966e",
    playColor: "#ba966e",
    boxZoneColor: "#ba966e",
    background: "#e5ddce",
    edgeColor: "#7a5c3a",
    margin: 260, // 책상이 보드 밖으로 뻗는 논리 여백
  },

  light: {
    key: { color: "#fff0d8", intensity: 2.8, elevation: 48, azimuth: -55, distance: 18 },
    fill: { color: "#dae4ed", intensity: 0.7, elevation: 35, azimuth: 130, distance: 14 },
    hemi: { sky: "#fff5e2", ground: "#a38d70", intensity: 1.65 },
    exposure: 1.02,
    shadow: { mapSize: 2048, radius: 3.5, bias: -0.0012, normalBias: 0.02 },
  },

  card: {
    thickness: 0.055, // 기준 두께. 실제 두께는 파일 크기로 곱해진다
    /**
     * 파일 크기 = 두께. 600MB 영상은 두툼하고 3KB 메모는 얇다.
     * 물건성을 주면서 정보도 같이 준다. 참고한 두 게임에 없는 우리만의 수단이다.
     */
    thicknessRange: { min: 0.45, max: 4.2 },
    thicknessReferenceKb: 700 * 1024, // 이 크기에서 max에 닿는다
    corner: 0.09,
    bevel: 0.012,
    faceColor: "#f5efdf",
    edgeTint: 0.16,
    /**
     * 쌓기. 겹친 면적이 카드 넓이의 이 비율을 넘으면 아래 카드 위에 얹힌다.
     * 살짝 스친 것만으로 떠오르면 책상이 들썩여 보인다.
     */
    stackOverlap: 0.16,
    stackGap: 0.004, // 얹힌 카드 사이의 아주 얇은 틈

    /** 상태별 높이 */
    restHeight: 0,
    hoverHeight: 0.09,
    liftHeight: 0.62,
    /** 스프링: freq가 클수록 빠르고, damping 1이면 오버슛 없음 */
    spring: { freq: 4.4, damping: 0.78 },
    dragSpring: { freq: 9.5, damping: 0.9 },
    /** 더미로 집을 때 뒤 카드가 따라오는 지연 (장당 초) */
    pileLag: 0.028,
    pileLagMax: 0.34,
    /** 드래그 방향으로 기우는 정도 */
    tiltPerSpeed: 0.085,
    tiltMax: 0.42,
    /** 집을 때 살짝 커짐 */
    liftScale: 1.06,
    /** 상자에 들어간 뒤 */
    placedScale: 0.62,
    placedStack: 0.05, // 한 장 쌓일 때마다 올라가는 높이
    /** 충돌로 튕겨 돌아올 때 */
    rejectHop: 0.5,
    rejectWobble: 0.5,
    selectGlow: 0.12,
    /** 충돌·실패 카드의 옆면 색. 섬광이 지나간 뒤에도 남는다 */
    conflictColor: "#ff8276",
    errorColor: "#ffcf6b",
  },

  label: {
    /** 카드 윗면에 굽는 텍스처 해상도 */
    texture: { width: 400, height: 244, dpi: 1 },
    /** 항상 떠 있는 HTML 라벨 대신, 가리키는 카드에만 크게 띄운다 */
    hoverDelay: 0,
  },

  box: {
    wall: 0.075,
    height: 1.08,
    innerPad: 0.06,
    // 나무 상자. 책상보다 밝아야 "담는 그릇"으로 읽힌다
    color: "#a99775",
    rimColor: "#c2b28f",
    targetRimColor: "#f5e7a3",
    virtualRimColor: "#8ee6a5",
    lift: 0.025,
    innerGlow: 0.12,
    spring: { freq: 6.5, damping: 0.7 },
  },

  pile: {
    cardGap: 0.014,
    maxVisible: 14,
    jitter: 0.02,
    spring: { freq: 5.5, damping: 0.8 },
  },

  /** 상자 위에 더미를 올려 두면 열리는 시간(ms) */
  springOpenMs: 650,
  /** 몇 개 들어갔는지 상자 위에 떠오르는 숫자 */
  popup: { riseMs: 1100 },
  /** 클릭과 드래그를 가르는 화면 이동량(px) */
  dragThreshold: 5,
  /** 파동으로 카드가 쏟아질 때 장당 지연(초) */
  supplyStagger: 0.045,
  supplyRise: 0.9,
};

/** 각도 → 방향 벡터 성분. elevation 0 = 수평, 90 = 바로 위 */
export function directionFromAngles(elevationDeg, azimuthDeg) {
  const el = (elevationDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  const horizontal = Math.cos(el);
  return { x: horizontal * Math.sin(az), y: Math.sin(el), z: horizontal * Math.cos(az) };
}

/**
 * 임계 감쇠 스프링 한 스텝. 큰 dt에서도 터지지 않게 나눠 적분한다.
 * @returns {[number, number]} [새 위치, 새 속도]
 */
export function springStep(value, velocity, target, dt, { freq, damping }) {
  const omega = 2 * Math.PI * freq;
  const steps = Math.min(4, Math.max(1, Math.ceil(dt / 0.016)));
  const h = dt / steps;
  let x = value;
  let v = velocity;
  for (let i = 0; i < steps; i += 1) {
    v += (-2 * damping * omega * v - omega * omega * (x - target)) * h;
    x += v * h;
  }
  return [x, v];
}
