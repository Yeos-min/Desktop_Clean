# 정리대 Desktop Helper

바탕화면 전용 최소 파일 작업 서버. 웹 앱(GitHub Pages)이 실제 바탕화면을 읽고, 옮기고, 되돌리고, 새 폴더를 만들 수 있게 한다.
Electron이 아니다. 창도 없다. 실행하면 콘솔 하나가 뜨고 브라우저가 열린다.

## 실행

Node 20 이상.

```bash
node helper/desktop-helper.mjs
```

실행하면 랜덤 포트와 일회용 토큰을 만들고 브라우저를 `https://…/?helper=PORT&token=…`로 연다. 웹 페이지는 주소창에서 토큰을 지우고 메모리에만 둔다.
브라우저가 안 열리면 콘솔의 포트와 토큰을 페이지에 직접 넣는다.

개발용(localhost:5173 페이지 + 가짜 바탕화면):

```bash
node helper/desktop-helper.mjs --dev --app http://localhost:5173 --desktop "C:\Users\me\Desktop\_test" --no-open
```

| 옵션 | 뜻 |
|---|---|
| `--desktop <경로>` | 바탕화면 대신 쓸 폴더. **테스트는 반드시 이걸로.** 기본은 레지스트리의 `User Shell Folders\Desktop` (OneDrive 리디렉션 대응), 없으면 `%USERPROFILE%\Desktop` |
| `--origin <url>` | 허용할 페이지 출처. 여러 번 가능. 기본은 배포 origin |
| `--dev` | `http://localhost:5173`, `http://127.0.0.1:5173`도 허용 |
| `--app <url>` | 브라우저로 열 페이지. 기본은 첫 허용 출처 |
| `--port <n>` | 고정 포트. 기본 0 = 랜덤 |
| `--no-open` | 브라우저를 열지 않음 |
| `--idle-minutes <n>` | 요청 없이 이 시간이 지나면 종료. 기본 15 |

## API (전부 `/v1`, `Authorization: Bearer <token>`, Origin 허용 목록)

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/hello` | 버전, 바탕화면 이름 |
| GET | `/scan` | 바탕화면 바로 아래 파일·폴더. id만 준다 |
| GET | `/folders/:id/children` | 하위 폴더 한 단계 |
| GET | `/files/:id/content` | 이미지 바이트 (25MB 이하). 썸네일용 |
| POST | `/move` `{ fileIds, folderId }` | 같은 볼륨 안에서 이동. 항목별 결과. 덮어쓰기 없음 |
| POST | `/undo` `{ batchId }` | 이동의 역방향. 원래 자리에 뭔가 생겼거나 그 파일이 아니면 그 항목만 남김 |
| POST | `/folders` `{ parentId, name }` | 바탕화면 안에 새 폴더 |
| POST | `/bye` | 종료 |

없는 것: 삭제, 임의 경로, 프로그램·셸 실행, 레지스트리 쓰기, 원격 접속. 필요해져도 여기에 넣지 않는다.

### 이동은 왜 `rename`이 아닌가

`exists(dest)`로 확인한 뒤 `rename()`을 부르면 **그 사이에 생긴 파일을 덮어쓴다.** Windows의 rename은 기존 파일의 자리를 뺏기 때문이다.
확인과 이동이 한 동작이어야 하므로, 판정을 파일 시스템에 맡긴다 — 하드 링크 만들기는 이름이 이미 있으면 원자적으로 EEXIST로 실패한다.
링크를 건 뒤 원본 이름을 지우면 결과가 이동과 같고(같은 inode), 하드 링크는 같은 볼륨에서만 되므로 "같은 볼륨만" 규칙도 저절로 지켜진다.
링크를 못 만드는 파일 시스템에서는 빈 파일로 이름을 선점(`wx`)한 뒤 우리가 만든 그 빈 파일만 덮어쓰며 rename 한다. `moveNoOverwrite` 한 함수다.

되돌리기는 경로만 보지 않는다. 옮길 때 `dev + ino`(못 읽으면 크기·수정 시각)를 적어 두고 대조한다.
밖에서 그 파일을 치우고 같은 이름의 다른 파일을 놓아 두면 경로만 보는 되돌리기는 남의 파일을 끌고 오기 때문이다. 다르면 그 항목만 `WRONG_FILE`.

## 보안

- `127.0.0.1`에만 listen. 포트는 매번 랜덤.
- 세션마다 랜덤 토큰. 상수 시간 비교.
- `Origin`이 없거나 허용 목록에 없으면 403. curl도 막힌다.
- 웹은 절대경로를 보내지도 받지도 않는다. id ↔ 경로 대응표는 프로세스 안에만 있다.
- 모든 경로는 `realpath` 후 바탕화면 아래인지 검사한다. 바로가기·정션(reparse point)은 목록에서 빼고, 요청이 와도 거부한다. `..` 같은 traversal은 realpath에서 풀린다.
- 요청 본문 64KB 제한, 배치 500개 제한.
- 요청이 없으면 스스로 꺼진다.

## 테스트

```bash
npm test
```

`helper/desktop-helper.test.mjs`는 임시 폴더를 바탕화면인 척 쓴다. 실제 바탕화면은 건드리지 않는다.
정션 스킵, 동명 충돌, 되돌리기, 원래 자리에 새 파일이 생긴 경우, 이름 규칙, Origin·토큰·본문 크기 거부를 확인한다.
덮어쓰기 금지는 같은 이름을 동시에 노리는 12개를 한 틱에 출발시켜 정확히 하나만 성공하는지로 확인하고,
되돌리기의 정체 대조는 옮긴 파일을 밖에서 빼내고 같은 이름의 다른 파일을 놓아 재현한다.

## 배포

지금은 `.mjs` 파일 하나다. Node가 없는 사람을 위한 단일 exe(Node SEA)와 SmartScreen·코드 서명은 다음 단계다.
GitHub Releases에 올린다.
