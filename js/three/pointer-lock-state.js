/** 실패는 이번 요청의 결과일 뿐, 다음 사용자 클릭의 재시도를 막지 않는다. */
export class PointerLockState {
  locked = false;
  denied = false;
  pending = false;
  hasLocked = false;
  #version = 0;
  #notify;

  constructor(notify = () => {}) { this.#notify = notify; }

  changed(locked) {
    this.#version++;
    this.locked = locked;
    this.pending = false;
    if (locked) { this.denied = false; this.hasLocked = true; }
    this.#notify();
  }

  failed(version = this.#version) {
    if (version !== this.#version || this.locked) return;
    this.pending = false;
    this.denied = true;
    this.#notify();
  }

  request(element) {
    if (this.locked || this.pending) return;
    const version = ++this.#version;
    this.pending = true;
    this.#notify();
    try {
      if (!element.requestPointerLock) { this.failed(version); return; }
      // 락 획득은 pointerlockchange로 확정한다. 예전 Promise의 늦은 실패는 무시한다.
      element.requestPointerLock()?.catch(() => this.failed(version));
    } catch {
      this.failed(version);
    }
  }
}
