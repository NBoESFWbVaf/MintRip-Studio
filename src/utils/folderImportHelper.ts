const DIR_HANDLE_DB_NAME = 'mintrip_fs_handles_v1';
const DIR_HANDLE_STORE_NAME = 'directory_handles';
const LAST_IMPORT_HANDLE_KEY = 'last_import_dir';

interface WindowWithDirPicker extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  }) => Promise<FileSystemDirectoryHandle>;
}

function openHandleDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DIR_HANDLE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DIR_HANDLE_STORE_NAME)) {
          db.createObjectStore(DIR_HANDLE_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function loadLastImportDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DIR_HANDLE_STORE_NAME, 'readonly');
      const store = tx.objectStore(DIR_HANDLE_STORE_NAME);
      const req = store.get(LAST_IMPORT_HANDLE_KEY);
      req.onsuccess = () => {
        resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      try {
        db.close();
      } catch {
        // ignore
      }
      resolve(null);
    }
  });
}

export async function saveLastImportDirHandle(handle: FileSystemDirectoryHandle | null): Promise<void> {
  const db = await openHandleDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(DIR_HANDLE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(DIR_HANDLE_STORE_NAME);
      if (handle) {
        store.put(handle, LAST_IMPORT_HANDLE_KEY);
      } else {
        store.delete(LAST_IMPORT_HANDLE_KEY);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      try {
        db.close();
      } catch {
        // ignore
      }
      resolve();
    }
  });
}

function attachRelativePath(file: File, relativePath: string): File {
  try {
    Object.defineProperty(file, 'webkitRelativePath', {
      value: relativePath,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // Fallback if non-configurable
  }
  return file;
}

export interface DirectoryEntryFile {
  file: File;
  relativePath: string;
}

export interface CollectDirectoryOptions {
  signal?: AbortSignal;
  onProgress?: (loadedCount: number) => void;
  acceptFileName?: (fileName: string) => boolean;
}

async function collectFilesFromDirHandle(
  dirHandle: FileSystemDirectoryHandle,
  prefix: string,
  out: DirectoryEntryFile[],
  options?: CollectDirectoryOptions
): Promise<void> {
  if (options?.signal?.aborted) return;
  const iter = (dirHandle as FileSystemDirectoryHandle & {
    values?: () => AsyncIterable<FileSystemHandle>;
  }).values?.();
  if (!iter) return;
  let visitedCount = 0;
  for await (const entry of iter) {
    if (options?.signal?.aborted) return;
    const rel = `${prefix}/${entry.name}`;
    if (entry.kind === 'file') {
      if (options?.acceptFileName && !options.acceptFileName(entry.name)) {
        visitedCount += 1;
        if (visitedCount % 100 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        continue;
      }
      const file = await (entry as FileSystemFileHandle).getFile();
      if (options?.signal?.aborted) return;
      out.push({
        file: attachRelativePath(file, rel),
        relativePath: rel,
      });
      if (out.length === 1 || out.length % 10 === 0) {
        options?.onProgress?.(out.length);
      }
      if (out.length % 40 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } else if (entry.kind === 'directory') {
      await collectFilesFromDirHandle(entry as FileSystemDirectoryHandle, rel, out, options);
    }
  }
}

export type PersistentDirectoryPickResult =
  | {
      status: 'picked';
      folderName: string;
      entries: DirectoryEntryFile[];
      files: File[];
    }
  | { status: 'cancelled' }
  | { status: 'fallback_input' };

export async function pickDirectoryWithPersistence(options?: {
  readFiles?: boolean;
  signal?: AbortSignal;
  onProgress?: (loadedCount: number) => void;
  acceptFileName?: (fileName: string) => boolean;
}): Promise<PersistentDirectoryPickResult> {
  const readFiles = options?.readFiles !== false;
  const win = typeof window !== 'undefined' ? (window as WindowWithDirPicker) : undefined;
  if (!win || typeof win.showDirectoryPicker !== 'function') {
    return { status: 'fallback_input' };
  }

  const savedHandle = await loadLastImportDirHandle();
  let dirHandle: FileSystemDirectoryHandle | null = null;

  try {
    dirHandle = await win.showDirectoryPicker({
      id: 'mintrip-import',
      mode: 'read',
      startIn: savedHandle || 'music',
    });
  } catch (err) {
    const errName = (err as { name?: string })?.name || '';
    if (errName === 'AbortError') {
      return { status: 'cancelled' };
    }
    if (savedHandle) {
      try {
        dirHandle = await win.showDirectoryPicker({
          id: 'mintrip-import',
          mode: 'read',
          startIn: 'music',
        });
      } catch (retryErr) {
        const retryName = (retryErr as { name?: string })?.name || '';
        if (retryName === 'AbortError') {
          return { status: 'cancelled' };
        }
        return { status: 'fallback_input' };
      }
    } else {
      return { status: 'fallback_input' };
    }
  }

  if (!dirHandle || options?.signal?.aborted) {
    return { status: 'cancelled' };
  }

  await saveLastImportDirHandle(dirHandle);

  const entries: DirectoryEntryFile[] = [];
  if (readFiles) {
    await collectFilesFromDirHandle(dirHandle, dirHandle.name, entries, {
      signal: options?.signal,
      onProgress: options?.onProgress,
      acceptFileName: options?.acceptFileName,
    });
    if (options?.signal?.aborted) {
      return { status: 'cancelled' };
    }
    options?.onProgress?.(entries.length);
  }
  return {
    status: 'picked',
    folderName: dirHandle.name,
    entries,
    files: entries.map((e) => e.file),
  };
}

export function extractTopFolderNameFromEntries(
  entries: Array<{ file: File; relativePath?: string }>
): string | null {
  for (const entry of entries) {
    const rel =
      entry.relativePath ||
      (entry.file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      '';
    const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = norm.split('/').filter(Boolean);
    if (parts.length > 1) {
      return parts[0];
    }
  }
  return null;
}
