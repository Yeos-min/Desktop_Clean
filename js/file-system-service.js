/**
 * file-system-service.js — File System Access API 위의 파일 규칙.
 *
 * 현재 쓰이는 것: resolveDroppedHandles, describeFileHandle, queryHandlePermission (WebDropProvider, 읽기 전용).
 *
 * 나머지(copyAndVerify, undoStagedCopy, validateBeforeCommit, removeOriginalFile)는 0-B의 "복사 → 검증 → 정리 끝" 모델이다.
 * 2026-09-03에 실제 반영을 Desktop Helper(rename)로 옮기면서 **어디에서도 호출하지 않는다.** 테스트와 함께 기록으로 남긴다.
 * 웹에서 쓰기 권한은 파일마다 확인창이 떠서(18개 → 18번) 사용자 경험으로 실패했기 때문이다. (CLAUDE.md §8-7)
 */
const nameCollator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

export class FileOperationError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "FileOperationError";
    this.code = code;
  }
}

export function sortByName(entries) {
  return [...entries].sort((a, b) => nameCollator.compare(a.name, b.name));
}

export async function resolveDroppedHandles(items) {
  const candidates = Array.from(items ?? []).filter(
    (item) => item.kind === "file" && typeof item.getAsFileSystemHandle === "function",
  );
  const results = await Promise.allSettled(
    candidates.map((item) => item.getAsFileSystemHandle()),
  );

  return {
    handles: results
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value),
    failedCount: results.filter(
      (result) => result.status === "rejected" || !result.value,
    ).length,
  };
}

export async function queryHandlePermission(handle, mode = "read") {
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return "unknown";
  }
}

export async function requestHandlePermission(handle, mode = "read") {
  const current = await queryHandlePermission(handle, mode);
  if (current === "granted") return current;
  return handle.requestPermission({ mode });
}

export async function describeFileHandle(handle) {
  const file = await handle.getFile();
  return {
    id: crypto.randomUUID(),
    name: handle.name,
    handle,
    file,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  };
}

async function assertDestinationAvailable(directoryHandle, fileName) {
  try {
    await directoryHandle.getFileHandle(fileName);
  } catch (error) {
    if (error?.name === "NotFoundError") return;
    if (error?.name === "TypeMismatchError") {
      throw new FileOperationError(
        "DESTINATION_EXISTS",
        `목적지에 '${fileName}' 이름의 폴더가 이미 있습니다.`,
        error,
      );
    }
    throw error;
  }

  throw new FileOperationError(
    "DESTINATION_EXISTS",
    `목적지에 '${fileName}' 파일이 이미 있습니다. 덮어쓰지 않았습니다.`,
  );
}

async function cleanupCopy(directoryHandle, fileName) {
  try {
    await directoryHandle.removeEntry(fileName);
    return true;
  } catch {
    return false;
  }
}

export async function copyAndVerify({
  sourceHandle,
  destinationDirectory,
  fileName = sourceHandle.name,
  onProgress = () => {},
}) {
  await assertDestinationAvailable(destinationDirectory, fileName);
  let destinationWasCreated = false;

  try {
    const sourceFile = await sourceHandle.getFile();
    onProgress("copying", sourceFile.size);

    const destinationHandle = await destinationDirectory.getFileHandle(fileName, { create: true });
    destinationWasCreated = true;
    const writable = await destinationHandle.createWritable();

    try {
      await writable.write(sourceFile);
      await writable.close();
    } catch (error) {
      try {
        await writable.abort?.();
      } catch {
        // The directory cleanup below is the authoritative rollback attempt.
      }
      throw new FileOperationError("COPY_FAILED", "파일 복사 중 오류가 발생했습니다.", error);
    }

    onProgress("verifying", sourceFile.size);
    const copiedFile = await destinationHandle.getFile();
    if (copiedFile.size !== sourceFile.size) {
      throw new FileOperationError(
        "SIZE_MISMATCH",
        `복사 크기가 다릅니다. 원본 ${sourceFile.size}B / 복사본 ${copiedFile.size}B`,
      );
    }

    onProgress("staged", sourceFile.size);
    return {
      fileName,
      destinationHandle,
      sourceSnapshot: {
        size: sourceFile.size,
        lastModified: sourceFile.lastModified,
      },
      destinationSnapshot: {
        size: copiedFile.size,
        lastModified: copiedFile.lastModified,
      },
    };
  } catch (error) {
    if (destinationWasCreated) {
      const rolledBack = await cleanupCopy(destinationDirectory, fileName);
      if (!rolledBack) {
        throw new FileOperationError(
          "ROLLBACK_FAILED",
          `${error.message} 불완전한 복사본도 정리하지 못했습니다. 목적지를 직접 확인하세요.`,
          error,
        );
      }
    }

    if (error instanceof FileOperationError) throw error;
    throw new FileOperationError("COPY_FAILED", "파일을 복사하지 못했습니다.", error);
  }
}

export async function undoStagedCopy(destinationDirectory, fileName) {
  try {
    await destinationDirectory.removeEntry(fileName);
  } catch (error) {
    throw new FileOperationError(
      "UNDO_FAILED",
      `목적지의 '${fileName}' 복사본을 제거하지 못했습니다.`,
      error,
    );
  }
}

export async function validateBeforeCommit(move) {
  let sourceFile;
  let destinationFile;

  try {
    sourceFile = await move.sourceHandle.getFile();
  } catch (error) {
    throw new FileOperationError("SOURCE_MISSING", `'${move.fileName}' 원본을 다시 읽지 못했습니다.`, error);
  }

  if (
    sourceFile.size !== move.sourceSnapshot.size ||
    sourceFile.lastModified !== move.sourceSnapshot.lastModified
  ) {
    throw new FileOperationError(
      "SOURCE_CHANGED",
      `'${move.fileName}' 원본이 복사 후 변경되어 제거하지 않았습니다.`,
    );
  }

  try {
    destinationFile = await move.destinationHandle.getFile();
  } catch (error) {
    throw new FileOperationError(
      "DESTINATION_MISSING",
      `'${move.fileName}' 목적지 복사본을 다시 읽지 못했습니다.`,
      error,
    );
  }

  if (destinationFile.size !== sourceFile.size) {
    throw new FileOperationError(
      "DESTINATION_CHANGED",
      `'${move.fileName}' 목적지 복사본 크기가 달라 원본을 제거하지 않았습니다.`,
    );
  }

  return true;
}

export async function removeOriginalFile(fileHandle) {
  if (typeof fileHandle.remove !== "function") {
    throw new FileOperationError(
      "REMOVE_UNSUPPORTED",
      `'${fileHandle.name}' 핸들에서 remove()를 지원하지 않습니다.`,
    );
  }

  try {
    await fileHandle.remove();
  } catch (error) {
    throw new FileOperationError(
      "REMOVE_FAILED",
      `'${fileHandle.name}' 원본을 제거하지 못했습니다.`,
      error,
    );
  }
}
