# 3D 모델 넣는 법

지금 장면은 코드가 만든 프리미티브다. 여기에 `.glb`를 넣고 [`js/three/assets.js`](../js/three/assets.js)의 경로를 채우면 그 모델로 바뀐다.
**고칠 파일은 `assets.js` 하나다.** 다른 코드는 손대지 않는다.

```js
// js/three/assets.js
export const MODEL_MANIFEST = {
  card: {
    url: "./models/card.glb",            // 모든 카드에 같은 모델
    byFamily: {
      image: "./models/card-photo.glb",  // 계열별로 다르게 하고 싶으면
      model3d: "./models/card-blend.glb",
    },
  },
  box: { url: "./models/box.glb" },
  pile: { url: null },
  desk: { url: "./models/desk.glb", fit: false, scale: 1 },
};
```

파일이 없거나 깨져도 장면은 죽지 않는다. 콘솔에 한 줄 남기고 프리미티브로 되돌아간다.

## 규격

| 슬롯 | 자동으로 맞춰지는 크기 (월드 단위) | 실제 비유 |
|---|---|---|
| `card` | 1.72 × 0.055 × 1.04 | 눕힌 A4 한 장 |
| `box` | 2.0 × 0.66 × 1.12 | 뚜껑 없는 상자 |
| `pile` | 1.5 × 0.5 × 0.92 | 쌓인 종이 더미 |

- **축**: +Y가 위. 카드는 **눕혀서** 윗면이 +Y를 보게. 상자는 열린 쪽이 +Y.
- **정면**: +Z가 카메라 쪽이다. 상자 앞면(번호와 이름이 붙는 면)을 +Z로.
- **원점**: 바닥 중앙. 자동 정규화가 이 위치로 옮겨 주므로 크게 신경 쓰지 않아도 된다.
- **크기**: `fit`이 기본 `true`라 위 표에 맞춰 자동 축소된다. 비율은 유지된다. 자동 맞춤이 싫으면 `fit: false`로 두고 `scale`로 직접 맞춘다.
- **축이 90도 틀어졌을 때**: `rotation: [Math.PI / 2, 0, 0]` 처럼 라디안으로 보정한다.

## 만들 때 주의

- **삼각형 수**: 카드는 화면에 최대 20장 정도가 동시에 뜬다. 한 장당 500 삼각형 아래를 권한다.
- **머티리얼**: glTF PBR(baseColor, roughness, metallic)이면 그대로 나온다. 텍스처는 모델에 포함(embedded)하는 편이 편하다.
- **파일명·미리보기 텍스처**: 카드 윗면은 `js/three/card-face.js`가 캔버스로 그린다. 이미지 파일이면 실제 미리보기가 채워지고 파일명이 그 위에 얹힌다. 모델을 쓰면 그 텍스처는 자동으로 붙지 않는다.
  파일명을 모델 위에 그대로 쓰려면 윗면 머티리얼의 이름을 `face`로 두고 `card-object.js`에서 그 머티리얼의 `map`에 텍스처를 꽂으면 된다.
  (지금은 프리미티브 판의 윗면에 바로 굽는다.)
- **그림자**: 불러온 모든 메시에 `castShadow`/`receiveShadow`가 자동으로 켜진다.
- **용량**: GitHub Pages로 나가므로 한 파일 2MB 아래를 권한다. Blender에서 내보낼 때 Draco 압축은 **쓰지 말 것** — 디코더를 따로 실어야 한다.

## Blender에서 내보내기

1. 오브젝트를 원점에 두고 스케일을 적용한다 (`Ctrl+A` → Scale).
2. `File > Export > glTF 2.0 (.glb)`
3. Format: **glTF Binary (.glb)**
4. Include: Selected Objects만 체크
5. Transform: **+Y Up** 체크 (기본값)
6. Compression: 끄기

## 손맛은 모델과 별개다

카드가 손에 붙어 따라오는 지연, 기우는 각도, 상자가 뜨는 높이 같은 것은 전부
[`js/three/tuning.js`](../js/three/tuning.js)에 있다. 모델을 바꿔도 그 숫자는 그대로 쓰인다.
브라우저 콘솔에서 `__tuning.card.spring.freq = 6` 처럼 바로 만져 볼 수 있다.
