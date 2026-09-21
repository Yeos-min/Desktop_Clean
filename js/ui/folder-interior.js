/** 탑다운 상자 내부. 읽어 온 파일도 정리는 세션 안에서만 수행한다. */
export class FolderInterior {
  #dialog;
  #grid;
  #selected = new Set();
  #folder;
  #busy = false;
  #urls = [];
  #revision = 0;
  #options;

  constructor(options) {
    this.#options = options;
    this.#dialog = document.createElement("dialog");
    this.#dialog.className = "folder-interior";
    this.#dialog.setAttribute("aria-label", "폴더 내부 보기");
    this.#dialog.innerHTML = `<header><div><small>BOX CONTENTS · 정리 체험 · 디스크 변경 없음</small><h2></h2></div>
      <button type="button" data-close>방으로 돌아가기 · Esc</button></header>
      <nav><button type="button" data-back>← 상위 폴더</button><button type="button" data-target>이 폴더를 목적지로 펼치기</button><span>클릭 · 선택 / Shift + 클릭 · 여러 개 선택</span></nav>
      <div class="interior-tray" aria-label="폴더 내용"></div>
      <footer><span role="status"></span><button type="button" data-clear>선택 해제</button></footer>`;
    document.body.append(this.#dialog);
    this.#grid = this.#get(".interior-tray");
    this.#get("[data-back]").onclick = () => this.open(this.#folder.parentId);
    this.#get("[data-close]").onclick = () => this.close();
    this.#get("[data-target]").onclick = async () => {
      if (this.#busy) return;
      const folderId = this.#folder.id;
      await this.close();
      if (!this.active) this.#options.onTarget(folderId);
    };
    this.#get("[data-clear]").onclick = () => { if (!this.#busy) { this.#selected.clear(); this.#update(); } };
    this.#dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
  }

  #get(selector) { return this.#dialog.querySelector(selector); }
  get active() { return this.#dialog.open; }

  async open(folderId) {
    if (this.#busy || !folderId) return;
    this.#busy = true;
    this.#selected.clear();
    this.#options.onActive(true);
    if (!this.active) this.#dialog.showModal();
    this.#grid.replaceChildren();
    this.#get('[role="status"]').textContent = "상자 안을 확인하는 중…";
    this.#get("[data-close]").disabled = this.#get("[data-back]").disabled = true;
    this.#get("[data-target]").disabled = true;
    const revision = ++this.#revision;
    this.#releaseImages();
    try {
      const { folder, folders, files } = await this.#options.load(folderId);
      this.#folder = folder;
      this.#get("[data-target]").disabled = false;
      this.#get("h2").textContent = folder.path.join(" / ");
      this.#get("[data-back]").disabled = !folder.parentId;
      for (const child of folders) {
        const button = this.#tile(child.name, "폴더", "interior-folder");
        button.onclick = () => this.open(child.id);
        this.#grid.append(button);
      }
      for (const file of files) {
        const button = this.#tile(file.name, file.extension.toUpperCase() || "FILE", "interior-file");
        button.dataset.fileId = file.id;
        button.setAttribute("aria-pressed", "false");
        button.onclick = (event) => {
          if (this.#busy) return;
          if (!event.shiftKey) this.#selected.clear();
          if (event.shiftKey && this.#selected.has(file.id)) this.#selected.delete(file.id);
          else this.#selected.add(file.id);
          this.#update();
        };
        this.#grid.append(button);
        this.#thumbnail(file, button, revision);
      }
      if (!files.length && !folders.length) {
        const empty = document.createElement("p");
        empty.className = "interior-empty";
        empty.textContent = "이 폴더에는 아직 파일이 없습니다.";
        this.#grid.append(empty);
      }
      this.#update();
    } catch (error) {
      this.#get('[role="status"]').textContent = `열지 못했습니다: ${error.message}`;
    } finally {
      this.#busy = false;
      this.#get("[data-close]").disabled = false;
    }
  }

  #tile(name, type, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    const face = document.createElement("span");
    face.className = "interior-face";
    face.textContent = type;
    const label = document.createElement("strong");
    label.textContent = name;
    button.title = name;
    button.append(face, label);
    return button;
  }

  async #thumbnail(file, button, revision) {
    try {
      const blob = await this.#options.thumbnail(file.id);
      if (!blob || revision !== this.#revision || !this.active) return;
      const url = URL.createObjectURL(blob);
      this.#urls.push(url);
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      button.querySelector(".interior-face").replaceChildren(image);
    } catch { /* 미리보기 없이도 이름으로 선택 가능 */ }
  }

  #update() {
    for (const button of this.#grid.querySelectorAll("[data-file-id]")) {
      button.setAttribute("aria-pressed", String(this.#selected.has(button.dataset.fileId)));
    }
    const count = this.#selected.size;
    this.#get('[role="status"]').textContent = count ? `${count}개 선택 · 방으로 돌아가면 손에 들립니다.` : "파일을 선택해 꺼내거나, 하위 폴더를 눌러 확인하세요.";
    this.#get("[data-close]").textContent = count ? `${count}개 들고 돌아가기 · Esc` : "방으로 돌아가기 · Esc";
  }

  async close() {
    if (this.#busy) return;
    this.#busy = true;
    this.#get("[data-close]").disabled = true;
    try {
      if (this.#selected.size) await this.#options.takeOut([...this.#selected], this.#folder.id);
      this.#dialog.close();
      this.#revision++;
      this.#releaseImages();
      this.#options.onActive(false);
    } catch (error) {
      this.#get('[role="status"]').textContent = `꺼내지 못했습니다: ${error.message}`;
    } finally {
      this.#busy = false;
      this.#get("[data-close]").disabled = false;
    }
  }

  #releaseImages() {
    for (const url of this.#urls) URL.revokeObjectURL(url);
    this.#urls = [];
  }
}
