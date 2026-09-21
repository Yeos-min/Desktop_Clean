/**
 * Onboarding — 두 갈래. (§11, §12 UX 원칙)
 *
 *  웹에서 바로 체험하기   Ctrl+A 드롭. 읽기 전용. 설치 0, 확인창 0.
 *  내 Desktop과 연결하기 Desktop Helper. 자동 스캔, 실제 이동, 실제 되돌리기.
 *
 * Helper 설치는 진입 조건이 아니다. 기본은 웹이다.
 */

export class Onboarding {
  #root;
  #status;
  #onStart;
  #createWebProvider;
  #createHelperProvider;
  #memoryProvider;
  #els;
  #webProvider = null;
  #helperProvider = null;
  #busy = false;

  constructor({ root, status, onStart, createWebProvider, createHelperProvider, memoryProvider = null, capacity = 16 }) {
    this.#root = root;
    this.#status = status;
    this.#onStart = onStart;
    this.#createWebProvider = createWebProvider;
    this.#createHelperProvider = createHelperProvider;
    this.#memoryProvider = memoryProvider;
    const $ = (selector) => root.querySelector(selector);
    this.#els = {
      webCard: $("#mode-web"),
      helperCard: $("#mode-helper"),
      webDrop: $('[data-drop="desktop"]'),
      webSummary: $("#web-summary"),
      startWeb: $("#start-web"),
      helperForm: $("#helper-form"),
      helperPort: $("#helper-port"),
      helperToken: $("#helper-token"),
      helperState: $("#helper-state"),
      startHelper: $("#start-helper"),
      memoryTools: $("#memory-tools"),
      loadSample: $("#load-sample"),
      supportState: $("#support-state"),
      capacityLabel: $("#capacity-label"),
    };
    this.#els.capacityLabel.textContent = capacity;
    this.#els.memoryTools.hidden = !memoryProvider;
    this.#bind();
    this.refresh();
  }

  #bind() {
    const { webDrop, startWeb, helperForm, startHelper, loadSample } = this.#els;

    webDrop.addEventListener("dragenter", (event) => {
      event.preventDefault();
      webDrop.classList.add("is-dragging");
    });
    webDrop.addEventListener("dragover", (event) => event.preventDefault());
    webDrop.addEventListener("dragleave", (event) => {
      if (!webDrop.contains(event.relatedTarget)) webDrop.classList.remove("is-dragging");
    });
    webDrop.addEventListener("drop", (event) => {
      event.preventDefault();
      webDrop.classList.remove("is-dragging");
      const items = event.dataTransfer?.items;
      if (!items || items.length === 0) {
        this.#status.notice("파일 시스템 핸들을 받을 수 있는 항목이 없습니다.", "error");
        return;
      }
      this.#guard(async () => {
        this.#webProvider ??= this.#createWebProvider();
        const result = await this.#webProvider.importDropped(items);
        this.#status.logImport(result, { source: "드롭" });
      }, "드롭한 항목을 읽지 못했습니다");
    });

    startWeb.addEventListener("click", () => {
      if (this.#webProvider) this.#onStart(this.#webProvider);
    });

    helperForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.connectHelper(this.#els.helperPort.value.trim(), this.#els.helperToken.value.trim());
    });

    startHelper.addEventListener("click", () => {
      if (this.#helperProvider) this.#onStart(this.#helperProvider);
    });

    loadSample.addEventListener("click", () => {
      if (this.#memoryProvider) this.#guard(() => this.#onStart(this.#memoryProvider), "가상 파일을 열지 못했습니다");
    });
  }

  /** URL의 ?helper=PORT&token=… 로도, 폼으로도 온다. */
  async connectHelper(port, token) {
    if (!port || !token) {
      this.#status.notice("포트와 토큰을 모두 입력하세요. Helper 창에 나옵니다.", "warn");
      return false;
    }
    this.#els.helperPort.value = port;
    this.#els.helperToken.value = token;
    let connected = false;
    await this.#guard(async () => {
      const provider = this.#createHelperProvider({ port, token });
      const info = await provider.connect();
      this.#helperProvider = provider;
      this.#status.logConnect(info);
      this.#els.helperState.textContent = `연결됨 · Desktop Helper v${info.version} · '${info.desktopName}'`;
      this.#els.helperState.dataset.tone = "success";
      connected = true;
    }, "Desktop Helper에 연결하지 못했습니다");
    if (!connected) {
      this.#helperProvider = null;
      this.#els.helperState.textContent = "연결 안 됨. Helper가 실행 중인지, 포트와 토큰이 맞는지 확인하세요.";
      this.#els.helperState.dataset.tone = "error";
    }
    this.refresh();
    return connected;
  }

  async #guard(task, failureTitle) {
    if (this.#busy) return;
    this.#busy = true;
    this.refresh();
    try {
      await task();
    } catch (error) {
      this.#status.logError(failureTitle, error?.message);
    } finally {
      this.#busy = false;
      this.refresh();
    }
  }

  refresh() {
    this.#els.loadSample.disabled = this.#busy;
    const { webSummary, startWeb, startHelper, webCard, helperCard, helperForm } = this.#els;
    const web = this.#webProvider;
    const files = web?.files ?? [];
    const folders = web?.folders.filter((folder) => folder.parentId === null) ?? [];

    if (!web || (files.length === 0 && folders.length === 0)) {
      webSummary.textContent = "";
    } else {
      const shown = files.slice(0, 4).map((file) => file.name);
      webSummary.textContent =
        `파일 ${files.length}개 · 폴더 ${folders.length}개` +
        (shown.length ? ` — ${shown.join(" · ")}${files.length > 4 ? ` 외 ${files.length - 4}개` : ""}` : "");
    }
    startWeb.disabled = this.#busy || files.length === 0;
    startWeb.textContent = folders.length === 0 && files.length > 0 ? "책상 열기 · 체험 (폴더 없음 — 새 폴더를 만들어 정리)" : "책상 열기 · 체험";
    webCard.dataset.ready = files.length > 0;

    startHelper.disabled = this.#busy || !this.#helperProvider;
    helperCard.dataset.ready = Boolean(this.#helperProvider);
    for (const control of helperForm.querySelectorAll("input, button")) control.disabled = this.#busy;
  }

  showUnsupported(message) {
    const { supportState, webDrop, startWeb } = this.#els;
    supportState.textContent = message;
    supportState.hidden = false;
    webDrop.classList.add("is-disabled");
    startWeb.disabled = true;
  }
}
