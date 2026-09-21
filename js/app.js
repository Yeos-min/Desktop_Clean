/**
 * app.js — 조립만 한다.
 *
 * Provider(파일 시스템) ↔ 세션 스토어 ↔ 보드/온보딩/기록을 연결하고, 단축키와 pagehide를 건다.
 * 보드는 Provider가 무엇인지 모른다. capabilities로 라벨만 바뀐다.
 *
 * URL 파라미터:
 *   ?helper=PORT&token=…    Desktop Helper가 브라우저를 열 때 붙여 준다 → 자동 연결
 *   ?storage=memory         디스크를 건드리지 않는 샘플 (개발용)
 *   &capacity=16&refill=6   보드 정원 / 파동 임계 [임시]
 *   &seed=123               배치 시드
 *   &delay=0                (memory) 이동 지연 시뮬레이션 끄기
 */
import { MemoryProvider } from "./providers/memory-provider.js";
import { SAMPLE_FOLDERS } from "./providers/sample-desktop.js";
import { NativeHelperProvider } from "./providers/native-helper-provider.js";
import { WebDropProvider } from "./providers/web-drop-provider.js";
import { SessionStore } from "./state/session-store.js";
import { Board3D } from "./three/board-3d.js";
import { Board } from "./ui/board.js";
import { playBoundsFor } from "./ui/board-layout.js";
import { Onboarding } from "./ui/onboarding.js";
import { StatusPanel } from "./ui/status.js";
import { FolderInterior } from "./ui/folder-interior.js";

const params = new URLSearchParams(location.search);
const memoryMode = params.get("storage") === "memory";

function intParam(name, fallback, min, max) {
  const value = Number.parseInt(params.get(name) ?? "", 10);
  if (Number.isNaN(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

const $ = (selector) => document.querySelector(selector);
const elements = {
  modePill: $("#mode-pill"),
  onboarding: $("#onboarding"),
  stage: $("#stage"),
  boardRoot: $("#board-root"),
  summary: $("#stage-summary"),
  newFolderForm: $("#new-folder-form"),
  newFolderName: $("#new-folder-name"),
  placement: $("#placement"),
  camera: $("#camera"),
  undoButton: $("#undo-button"),
  planTitle: $("#plan-title"),
  plan: $("#plan"),
  panelToggle: $("#panel-toggle"),
  arrangeToggle: $("#arrange-toggle"),
  stageSide: $(".stage-side"),
  progressHud: $("#progress-hud"),
  progressDone: $("#progress-done"),
  progressTotal: $("#progress-total"),
  progressFill: $("#progress-fill"),
};

const store = new SessionStore({
  // 책상을 꽉 채운다. 어질러진 양이 보여야 치우고 싶어진다. [임시]
  capacity: intParam("capacity", 24, 1, 64),
  // -1 = 자동 보충 없음. 책상을 다 치우면 바닥이 드러나고, 다음 무더기는 더미를 눌러 꺼낸다. [임시]
  refillBelow: intParam("refill", -1, -1, 64),
  bounds: playBoundsFor("bottom"),
  seed: params.has("seed") ? intParam("seed", 0, 0, 2 ** 31) : undefined,
});

const status = new StatusPanel({ notices: [$("#onboarding-notice"), $("#notice")], log: $("#log") });

// 콘솔에서 상태를 들여다보기 위한 손잡이. 읽기용이다. (3D 쪽은 window.__board, window.__tuning)
if (typeof window !== "undefined") {
  window.__app = {
    store,
    get provider() {
      return provider;
    },
    get board() {
      return board;
    },
  };
}

/** @type {import("./providers/file-system-provider.js").FileSystemProvider|null} */
let provider = null;
let board = null;
let labels = { verb: "옮김", mode: "체험" };

// ───────────────────────── Provider 작업은 한 번에 하나씩 ─────────────────────────

let chain = Promise.resolve();
let pending = 0;

function run(task) {
  pending += 1;
  updateBar();
  const next = chain.then(task, task);
  chain = next
    .catch(() => {})
    .finally(() => {
      pending -= 1;
      updateBar();
    });
  return next;
}

// ───────────────────────── 제스처 → 파일 작업 ─────────────────────────

async function moveTo(fileIds, folderId) {
  const folder = store.folder(folderId);
  if (!folder || !provider) return;
  const { ids } = store.beginBatch(fileIds, folderId);
  if (ids.length === 0) return;
  store.leaveToRoot(); // 칸에 넣었으면 줄을 배송지 목록으로 되돌린다 (스프링 폴더처럼 닫힌다) [임시]

  const folderName = store.folderLabel(folderId);
  await run(async () => {
    try {
      const result = await provider.moveBatch(ids, folderId, {
        onItem: (id, stage) => store.setItemStage(id, stage),
      });
      store.applyMoveResult(result);
      status.logMove(result, { folderName, verb: labels.verb });
    } catch (error) {
      store.applyMoveResult({
        batchId: "",
        folderId,
        moved: [],
        failed: ids.map((id) => ({
          fileId: id,
          fileName: store.entry(id)?.item.name ?? id,
          code: error?.code ?? "MOVE_FAILED",
          message: error?.message ?? "알 수 없는 오류",
        })),
      });
      status.logError("옮기는 중 오류", error?.message);
    }
  });
}

async function undoLastBatch() {
  if (board?.arranging) { board.undoBoxPlacement(); return; }
  const batch = store.lastBatch;
  if (!batch || pending > 0 || !provider) return;
  await run(async () => {
    try {
      const result = await provider.undoBatch(batch.batchId);
      store.applyUndoResult(result);
      status.logUndo(result, { folderName: store.folderLabel(batch.folderId), verb: labels.verb });
    } catch (error) {
      status.logError("되돌리기 실패", error?.message);
    }
  });
}

async function createFolder(name) {
  if (!provider?.capabilities.canCreateFolder) return;
  const parentId = store.level;
  await run(async () => {
    try {
      const folder = await provider.createFolder(parentId, name);
      store.addFolders([folder]);
      status.logFolderCreated(folder, { real: provider.capabilities.realFiles });
    } catch (error) {
      status.logError("폴더를 만들지 못했습니다", error?.message);
    }
  });
}

// ───────────────────────── 배송지 열기 ─────────────────────────

const opening = new Set();
const interior = new FolderInterior({
  onActive: (active) => board?.setSuspended?.(active),
  onTarget: (folderId) => store.enterFolder(folderId),
  thumbnail: (id) => provider.readThumbnail(id),
  load: (folderId) => run(async () => {
    const contents = await provider.listContents(folderId);
    store.addFolders(contents.folders);
    store.addContainedFiles(contents.files, folderId);
    return { ...contents, folder: store.folder(folderId) };
  }),
  takeOut: (ids, folderId) => run(async () => {
    const result = await provider.takeOut(ids, folderId);
    store.applyTakeOutResult(result);
    if (result.failed.length) throw new Error(result.failed.map((item) => item.message).join(" "));
    status.notice(`${result.moved.length}개를 꺼냈습니다. 다른 상자에 넣거나 오른쪽 버튼으로 내려놓으세요.`, "info");
  }),
});

async function openFolder(folderId) {
  const folder = store.folder(folderId);
  if (!folder || opening.has(folderId) || !provider) return;
  if (typeof provider.listContents === "function") {
    if (pending > 0 || store.selection.length || interior.active) return;
    await interior.open(folderId);
    return;
  }
  if (folder.hasChildren === false) {
    status.notice(`'${store.folderLabel(folderId)}' 안에는 칸(하위 폴더)이 없습니다. 여기에 바로 넣으세요.`, "info");
    return;
  }
  opening.add(folderId);
  try {
    const children = await provider.listSubfolders(folderId);
    store.addFolders([{ ...folder, hasChildren: children.length > 0 }, ...children]);
    if (children.length === 0) {
      status.notice(`'${store.folderLabel(folderId)}' 안에는 칸(하위 폴더)이 없습니다. 여기에 바로 넣으세요.`, "info");
      return;
    }
    store.enterFolder(folderId);
  } catch (error) {
    status.logError("배송지를 열지 못했습니다", error?.message);
  } finally {
    opening.delete(folderId);
  }
}

// ───────────────────────── 화면 ─────────────────────────

// "책상을 치웠습니다" 알림을 한 파동에 한 번만 띄우기 위한 기억
let clearedNoticeShown = false;
let completedNoticeShown = false;

function updateBar() {
  if (elements.stage.hidden) return;
  const placed = store.placedCount;
  const { done, total } = store.progress;

  elements.progressDone.textContent = done;
  elements.progressTotal.textContent = `/ ${total}`;
  elements.progressFill.style.width = total > 0 ? `${(done / total) * 100}%` : "0%";
  elements.progressHud.dataset.complete = String(total > 0 && done === total);

  elements.summary.textContent =
    `책상 ${store.unprocessedCount} · 더미 ${store.queuedCount} · 선택 ${store.selection.length}` +
    (pending > 0 ? " · 작업 중" : "");

  // 바닥이 드러난 순간을 놓치지 않게 알린다
  const cleared = store.unprocessedCount === 0 && store.queuedCount > 0 && pending === 0;
  if (cleared && !clearedNoticeShown) {
    clearedNoticeShown = true;
    status.notice(`책상을 치웠습니다. 남은 ${store.queuedCount}개를 꺼내려면 더미를 누르세요.`, "success");
  } else if (!cleared) {
    clearedNoticeShown = false;
  }
  if (total > 0 && done === total && !completedNoticeShown) {
    completedNoticeShown = true;
    status.notice(`${total}개를 전부 치웠습니다.`, "success");
  } else if (done !== total) {
    completedNoticeShown = false;
  }
  const last = store.lastBatch;
  const arranging = board?.arranging;
  elements.arrangeToggle.hidden = !board?.setArranging;
  elements.arrangeToggle.textContent = arranging ? "상자 배치 모드 · Tab" : "파일 정리 모드 · Tab";
  elements.arrangeToggle.setAttribute("aria-pressed", String(!!arranging));
  elements.placement.disabled = elements.camera.disabled = !!arranging;
  elements.undoButton.disabled = pending > 0 || (arranging ? !board.canUndoArrangement : !last);
  elements.undoButton.querySelector(".undo-label").textContent = arranging ? "상자 배치 되돌리기" : last
    ? `마지막 더미 되돌리기 (${last.fileIds.length}개)`
    : "마지막 더미 되돌리기";
  renderPlan();
}

function renderPlan() {
  const rows = store.summary;
  elements.planTitle.textContent = provider?.capabilities.realFiles ? "정리 결과 · 탐색기에 반영됨" : "정리 계획 · 체험 (디스크는 그대로)";
  elements.plan.replaceChildren(
    ...(rows.length
      ? rows.map((row) => {
          const item = document.createElement("li");
          const head = document.createElement("strong");
          head.textContent = `${row.folder} · ${row.names.length}개`;
          const names = document.createElement("small");
          names.textContent = row.names.join(", ");
          item.append(head, names);
          return item;
        })
      : [Object.assign(document.createElement("li"), { className: "plan-empty", textContent: "아직 옮긴 파일이 없습니다." })]),
  );
}

async function startWith(nextProvider) {
  provider = nextProvider;
  const { realFiles, kind, canScan, canCreateFolder } = provider.capabilities;
  labels = realFiles ? { verb: "옮김", mode: "실제" } : { verb: "옮김 (체험)", mode: "체험" };
  elements.modePill.dataset.mode = kind;
  elements.modePill.textContent =
    kind === "helper" ? `실제 Desktop 연결 · ${provider.desktopName}` : kind === "memory" ? "샘플 · 디스크 안 건드림" : "웹 체험 · 디스크 안 건드림";
  $("#room-mode").textContent = elements.modePill.textContent;

  if (canScan) {
    try {
      const result = await provider.scan();
      status.logImport(result, { source: provider.desktopName });
    } catch (error) {
      status.logError("바탕화면을 읽지 못했습니다", error?.message);
      return;
    }
  }

  store.setFolders(provider.folders);
  elements.onboarding.hidden = true;
  elements.stage.hidden = false;
  elements.newFolderForm.hidden = !canCreateFolder;
  // 게임 화면은 뷰포트를 채운다. 온보딩(나중에는 랜딩 페이지)은 평소 레이아웃 그대로다.
  document.body.classList.add("is-playing");

  // 기본은 3D. `?view=2d`로 0-C의 2D 보드와 나란히 비교할 수 있다.
  const BoardClass = params.get("view") === "2d" ? Board : Board3D;
  board = new BoardClass({
    root: elements.boardRoot,
    store,
    labels,
    onDropToFolder: moveTo,
    onPullWave: () => store.supply({ force: true }),
    onOpenFolder: openFolder,
    onLeaveFolder: () => store.leaveFolder(),
    loadThumbnail: (item) => provider.readThumbnail(item.id),
  });
  elements.camera.replaceChildren(
    ...board.cameraPresets.map((preset) => new Option(preset.label, preset.id)),
  );
  if (board.placement) elements.placement.value = board.placement;
  store.addFiles(provider.files); // 보드가 붙은 뒤에 넣어야 쏟아지는 연출이 보인다
  updateBar();
  status.notice(
    realFiles
      ? "카드를 보고 클릭해 담고, 폴더를 보고 클릭하면 그 순간 실제로 옮겨집니다. Ctrl+Z로 되돌립니다."
      : "체험 모드입니다. 카드를 보고 클릭해 담고 폴더를 보고 클릭하세요. 디스크는 바뀌지 않고 정리 계획으로 남습니다.",
    "info",
  );
}

const onboarding = new Onboarding({
  root: elements.onboarding,
  status,
  capacity: store.capacity,
  onStart: startWith,
  createWebProvider: () => new WebDropProvider(),
  createHelperProvider: ({ port, token }) => new NativeHelperProvider({ port, token }),
  memoryProvider: new MemoryProvider({ delay: params.get("delay") !== "0",
    folders: Array.from({ length: intParam("folders", 4, 1, 200) }, (_, index) =>
      SAMPLE_FOLDERS[index] ?? { name: `보관함 ${String(index + 1).padStart(2, "0")}` }),
  }),
});

store.subscribe(updateBar);

elements.newFolderForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = elements.newFolderName.value;
  if (!name.trim()) return;
  createFolder(name);
  elements.newFolderName.value = "";
});
elements.placement.addEventListener("change", (event) => board?.setPlacement(event.target.value));
elements.camera.addEventListener("change", (event) => {
  board?.setCamera(event.target.value);
  // 1인칭은 폴더를 먼 쪽으로 옮긴다. 선택칸을 실제 상태에 맞춘다.
  if (board?.placement) elements.placement.value = board.placement;
});
elements.undoButton.addEventListener("click", undoLastBatch);

function toggleSidePanel(force) {
  const open = force ?? elements.stageSide.dataset.open !== "true";
  elements.stageSide.dataset.open = String(open);
  elements.panelToggle.setAttribute("aria-pressed", String(open));
  elements.panelToggle.setAttribute("aria-label", open ? "설정 및 기록 닫기" : "설정 및 기록 열기");
  if (open && document.pointerLockElement) document.exitPointerLock();
}
elements.panelToggle.addEventListener("click", () => toggleSidePanel());
elements.boardRoot.addEventListener("arrangementchange", updateBar);
function toggleArrangement() {
  if (pending > 0 || interior.active || !board?.setArranging) return;
  toggleSidePanel(false);
  board.setArranging(!board.arranging);
}
elements.arrangeToggle.addEventListener("click", toggleArrangement);

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const isEditing =
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  if (isEditing || elements.stage.hidden || interior.active) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (event.key === "Tab") {
    event.preventDefault();
    if (!event.repeat) toggleArrangement();
    return;
  }
  if (board?.arranging) {
    if (event.key === "Escape") { event.preventDefault(); board.cancelBoxPlacement(); }
    if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); board.undoBoxPlacement(); }
    // 배치 중 파일 선택, 파일 이동, 폴더 탐색 단축키는 전달하지 않는다.
    return;
  }

  if (modifier && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoLastBatch();
    return;
  }
  if (modifier && event.key.toLowerCase() === "a") {
    event.preventDefault();
    store.selectAll();
    return;
  }
  if (event.key === "Escape") {
    // 1인칭에서 Esc는 브라우저가 마우스를 풀어 주는 키다. 들고 있던 카드까지 내려놓지 않는다.
    if (board?.locked) return;
    if (store.level !== null) store.leaveFolder();
    else store.clearSelection();
    return;
  }
  if (event.key === "Backspace" && store.level !== null) {
    event.preventDefault();
    store.leaveFolder();
    return;
  }
  // 숫자 키 = 지금 보이는 상자 줄의 번호. 선택한 카드를 N번에 넣는다. 어느 상자인지는 사용자가 누른다. (§11)
  if (!modifier && /^[1-9]$/.test(event.key) && !board?.tilted) {
    const folder = board?.folderAt ? board.folderAt(Number(event.key)) : store.folderAt(Number(event.key));
    const selection = store.selection;
    if (!folder || selection.length === 0) return;
    event.preventDefault();
    moveTo(selection, folder.id);
  }
});

window.addEventListener("pagehide", () => {
  // Helper에 작별 인사. 실패해도 Helper는 idle 타이머로 스스로 꺼진다.
  provider?.disconnect?.();
});

async function initialize() {
  if (!memoryMode && !WebDropProvider.isSupported()) {
    onboarding.showUnsupported(
      window.isSecureContext
        ? "웹 체험은 최신 데스크톱 Chrome 또는 Edge에서 됩니다. Desktop Helper 연결은 그대로 쓸 수 있습니다."
        : "HTTPS 또는 localhost에서 열어야 합니다. file:// 로는 동작하지 않습니다.",
    );
  }
  const helperPort = params.get("helper");
  const helperToken = params.get("token");
  if (helperPort && helperToken) {
    // 주소창에 토큰이 남지 않게 지운다. 세션 동안은 메모리에만 있다.
    const clean = new URL(location.href);
    clean.searchParams.delete("helper");
    clean.searchParams.delete("token");
    history.replaceState(null, "", clean);
    await onboarding.connectHelper(helperPort, helperToken);
  }
}

initialize();
