/**
 * StatusPanel — 알림 한 줄 + 결과 기록.
 * 성공 항목과 실패 항목을 이름으로 분리해 적는다. "일부 실패"로 뭉뚱그리지 않는다. (§5-2)
 */

const MAX_LOG_ENTRIES = 40;

export class StatusPanel {
  #notices;
  #log;

  constructor({ notices = [], log }) {
    this.#notices = notices.filter(Boolean);
    this.#log = log;
  }

  notice(message, tone = "info") {
    for (const element of this.#notices) {
      element.textContent = message;
      element.dataset.tone = tone;
      element.hidden = false;
    }
  }

  clearNotice() {
    for (const element of this.#notices) element.hidden = true;
  }

  #push(title, tone, lines = []) {
    if (!this.#log) return;
    const item = document.createElement("li");
    item.className = "log-entry";
    item.dataset.tone = tone;

    const heading = document.createElement("strong");
    heading.textContent = title;
    item.append(heading);

    if (lines.length > 0) {
      const list = document.createElement("ul");
      for (const line of lines) {
        const row = document.createElement("li");
        row.dataset.tone = line.tone ?? "info";
        row.textContent = line.text;
        list.append(row);
      }
      item.append(list);
    }

    const time = document.createElement("time");
    time.textContent = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    item.append(time);

    this.#log.prepend(item);
    while (this.#log.children.length > MAX_LOG_ENTRIES) this.#log.lastElementChild.remove();
  }

  /** @param {import("../providers/file-system-provider.js").ImportResult} result */
  logImport(result, { source = "" } = {}) {
    const parts = [];
    if (result.files.length) parts.push(`파일 ${result.files.length}개`);
    if (result.folders.length) parts.push(`폴더 ${result.folders.length}개`);
    const lines = [];
    if (result.skipped) lines.push({ text: `${result.skipped}개는 읽지 못해 건너뜀`, tone: "warn" });
    for (const note of result.notes ?? []) lines.push({ text: note, tone: "warn" });
    const title = parts.length ? `${source ? `${source} · ` : ""}${parts.join(", ")} 읽음` : `${source ? `${source} · ` : ""}읽은 항목 없음`;
    this.#push(title, lines.length ? "warn" : "info", lines);
    this.notice(lines.length ? `${title}. ${lines.map((line) => line.text).join(" · ")}` : title, lines.length ? "warn" : "success");
  }

  logConnect({ desktopName, version }) {
    this.#push(`Desktop Helper v${version ?? "?"} 연결됨 · ${desktopName}`, "success");
    this.notice(`Desktop Helper에 연결됐습니다. '${desktopName}'을(를) 읽어 시작할 수 있습니다.`, "success");
  }

  /**
   * @param {import("../providers/file-system-provider.js").MoveResult} result
   * @param {{ folderName: string, verb: string }} options  verb: "옮김" | "옮김 (체험)"
   */
  logMove(result, { folderName, verb }) {
    const lines = [
      ...result.moved.map((move) => ({ text: `${verb} · ${move.fileName}`, tone: "success" })),
      ...result.failed.map((failure) => ({ text: `실패 · ${failure.fileName} — ${failure.message}`, tone: "error" })),
    ];
    const title = `→ ${folderName}: ${result.moved.length}개 ${verb}${result.failed.length ? `, ${result.failed.length}개 실패` : ""}`;
    this.#push(title, result.failed.length ? (result.moved.length ? "warn" : "error") : "success", lines);
    if (result.failed.length) {
      this.notice(`${result.failed.length}개는 넣지 못했습니다. ${result.failed.map((f) => f.fileName).join(", ")}`, "error");
    } else {
      this.notice(`${result.moved.length}개를 '${folderName}'에 ${verb}.`, "success");
    }
  }

  /** @param {import("../providers/file-system-provider.js").UndoResult} result */
  logUndo(result, { folderName, verb }) {
    const lines = [
      ...result.restored.map((move) => ({ text: `되돌림 · ${move.fileName}`, tone: "success" })),
      ...result.failed.map((failure) => ({ text: `남김 · ${failure.fileName} — ${failure.message}`, tone: "error" })),
    ];
    const title = `되돌리기 ← ${folderName ?? ""}: ${result.restored.length}개${result.failed.length ? `, ${result.failed.length}개 남김` : ""}`;
    this.#push(title, result.failed.length ? "warn" : "info", lines);
    this.notice(
      result.failed.length
        ? `${result.failed.length}개는 되돌리지 못했습니다. 기록을 확인하세요.`
        : `${result.restored.length}개를 되돌렸습니다${verb.includes("체험") ? "" : ". 탐색기에도 반영됐습니다"}.`,
      result.failed.length ? "error" : "success",
    );
  }

  logFolderCreated(folder, { real }) {
    this.#push(`새 폴더 · ${folder.path.join(" › ")}${real ? "" : " (체험 — 디스크에는 없음)"}`, "success");
    this.notice(`'${folder.name}' 폴더를 만들었습니다${real ? ". 탐색기에도 생겼습니다" : " (체험)"}.`, "success");
  }

  logError(title, message) {
    this.#push(title, "error", message ? [{ text: message, tone: "error" }] : []);
    this.notice(message ? `${title}. ${message}` : title, "error");
  }
}
