import { useCallback, useEffect, useRef, useState } from "react";

const DATABASE_NAME = "copypaesto-settings";
const STORE_NAME = "handles";
const DIRECTORY_KEY = "trusted-auto-save";
const ENABLED_KEY = "copypaesto:auto-save-enabled";

type WritePermission = "granted" | "denied" | "prompt" | "unsupported";

interface PermissionedDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
  }) => Promise<PermissionedDirectoryHandle>;
};

export interface AutoSaveWritableTarget {
  savedName: string;
  writable: {
    write(data: ArrayBuffer): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
  };
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("Could not open browser storage")));
  });
}

async function loadDirectory() {
  const database = await openDatabase();
  try {
    return await new Promise<PermissionedDirectoryHandle | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(DIRECTORY_KEY);
      request.addEventListener("success", () => resolve((request.result as PermissionedDirectoryHandle | undefined) ?? null));
      request.addEventListener("error", () => reject(request.error ?? new Error("Could not load the saved folder")));
    });
  } finally {
    database.close();
  }
}

async function storeDirectory(handle: PermissionedDirectoryHandle) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(handle, DIRECTORY_KEY);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Could not remember the folder")));
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Could not remember the folder")));
    });
  } finally {
    database.close();
  }
}

function safeFileName(value: string) {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  const fallback = cleaned || "Received file";
  const portable = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fallback)
    ? `_${fallback}`
    : fallback;
  if (portable.length <= 180) return portable;
  const dot = portable.lastIndexOf(".");
  const extension = dot > 0 && portable.length - dot <= 16 ? portable.slice(dot) : "";
  return `${portable.slice(0, 180 - extension.length)}${extension}`;
}

function numberedName(name: string, index: number) {
  if (!index) return name;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} (${index})`;
  return `${name.slice(0, dot)} (${index})${name.slice(dot)}`;
}

async function exists(directory: FileSystemDirectoryHandle, name: string) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "NotFoundError") return false;
    if (cause instanceof DOMException && cause.name === "TypeMismatchError") return true;
    throw cause;
  }
}

export function useAutoSaveFolder() {
  const supported = typeof window !== "undefined"
    && "indexedDB" in window
    && typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
  const [enabled, setEnabled] = useState(() => supported && localStorage.getItem(ENABLED_KEY) === "true");
  const [directory, setDirectory] = useState<PermissionedDirectoryHandle | null>(null);
  const [permission, setPermission] = useState<WritePermission>(supported ? "prompt" : "unsupported");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reservedNamesRef = useRef(new Set<string>());

  useEffect(() => {
    if (!supported) return;
    let stopped = false;
    void loadDirectory().then(async (saved) => {
      if (stopped) return;
      if (!saved) {
        setEnabled(false);
        localStorage.removeItem(ENABLED_KEY);
        return;
      }
      setDirectory(saved);
      try {
        const state = await saved.queryPermission({ mode: "readwrite" });
        if (!stopped) setPermission(state);
      } catch {
        if (!stopped) setPermission("prompt");
      }
    }).catch(() => {
      if (!stopped) setError("The saved auto-save folder could not be opened");
    });
    return () => {
      stopped = true;
    };
  }, [supported]);

  const enable = useCallback(async (chooseNewFolder = false) => {
    if (!supported) return;
    setBusy(true);
    setError("");
    try {
      let next = chooseNewFolder ? null : directory;
      let state: PermissionState = "prompt";
      if (next) {
        state = await next.queryPermission({ mode: "readwrite" });
        if (state !== "granted") state = await next.requestPermission({ mode: "readwrite" });
      } else {
        next = await (window as DirectoryPickerWindow).showDirectoryPicker?.({
          id: "copypaesto-auto-save",
          mode: "readwrite",
          startIn: "downloads",
        }) ?? null;
        if (!next) return;
        state = await next.queryPermission({ mode: "readwrite" });
        await storeDirectory(next);
        setDirectory(next);
      }

      setPermission(state);
      if (state !== "granted") {
        setError("Folder permission was not granted");
        return;
      }
      localStorage.setItem(ENABLED_KEY, "true");
      setEnabled(true);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not enable auto-save");
    } finally {
      setBusy(false);
    }
  }, [directory, supported]);

  const disable = useCallback(() => {
    localStorage.removeItem(ENABLED_KEY);
    setEnabled(false);
    setError("");
  }, []);

  const createTarget = useCallback(async (suggestedName: string): Promise<AutoSaveWritableTarget> => {
    if (!directory || !enabled || permission !== "granted") {
      throw new Error("Trusted auto-save needs folder permission");
    }
    const currentPermission = await directory.queryPermission({ mode: "readwrite" });
    if (currentPermission !== "granted") {
      setPermission(currentPermission);
      throw new Error("Trusted auto-save needs folder permission again");
    }

    const baseName = safeFileName(suggestedName);
    let savedName = baseName;
    let fileHandle: FileSystemFileHandle | null = null;
    for (let index = 0; index < 10_000; index += 1) {
      const candidate = numberedName(baseName, index);
      if (reservedNamesRef.current.has(candidate)) continue;
      reservedNamesRef.current.add(candidate);
      try {
        if (await exists(directory, candidate)) {
          reservedNamesRef.current.delete(candidate);
          continue;
        }
        fileHandle = await directory.getFileHandle(candidate, { create: true });
        savedName = candidate;
        break;
      } catch (cause) {
        reservedNamesRef.current.delete(candidate);
        throw cause;
      }
    }
    if (!fileHandle) throw new Error("Could not choose a safe file name");

    try {
      const stream = await fileHandle.createWritable({ keepExistingData: false });
      let finished = false;
      return {
        savedName,
        writable: {
          write: (data) => stream.write(data),
          close: async () => {
            if (finished) return;
            finished = true;
            try {
              await stream.close();
            } finally {
              reservedNamesRef.current.delete(savedName);
            }
          },
          abort: async (reason) => {
            if (finished) return;
            finished = true;
            try {
              await stream.abort(reason);
            } finally {
              reservedNamesRef.current.delete(savedName);
              await directory.removeEntry(savedName).catch(() => undefined);
            }
          },
        },
      };
    } catch (cause) {
      reservedNamesRef.current.delete(savedName);
      await directory.removeEntry(savedName).catch(() => undefined);
      throw cause;
    }
  }, [directory, enabled, permission]);

  return {
    supported,
    enabled,
    ready: supported && enabled && permission === "granted" && Boolean(directory),
    permission,
    folderName: directory?.name ?? "",
    busy,
    error,
    enable,
    chooseFolder: () => enable(true),
    disable,
    createTarget,
  };
}
