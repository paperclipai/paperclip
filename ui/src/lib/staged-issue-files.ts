import { localizeUiError } from "@/lib/localized-ui-error";
export interface StagedIssueFile {
  id: string;
  file: File;
  kind: "document" | "attachment";
  documentKey?: string;
  title?: string | null;
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("paperclip:issue-draft-files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(localizeUiError(new Error("Draft file storage is blocked"), { key: "integration-errors:draftStorageBlocked" }));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  }).catch((error) => { database = undefined; throw error; });
  return database;
}

export async function readStagedIssueFiles(key: string): Promise<StagedIssueFile[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("files", "readonly");
    const request = transaction.objectStore("files").get(key);
    transaction.oncomplete = () => resolve(request.result ?? []);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function writeStagedIssueFiles(key: string, files: StagedIssueFile[], removedIds: string[]): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("files", "readwrite");
    const store = transaction.objectStore("files");
    const request = store.get(key);
    request.onsuccess = () => {
      const removed = new Set(removedIds);
      const saved = (request.result ?? []) as StagedIssueFile[];
      const merged = new Map(saved.filter(file => !removed.has(file.id)).map(file => [file.id, file]));
      for (const file of files) merged.set(file.id, file);
      if (merged.size) store.put([...merged.values()], key);
      else store.delete(key);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
