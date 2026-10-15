// Durable, resumable upload queue backed by IndexedDB.
//
// Ship connectivity drops constantly. Without persistence, a reload or a dropped
// connection mid-upload loses every queued/in-progress photo and forces the
// seaman to re-pick and re-send the whole batch on his limited bandwidth. This
// store keeps each pending photo's BYTES (a Blob — IndexedDB can hold binary, so
// there is no 5 MB localStorage cap) plus its status on disk, so after a reload
// or a reconnect the queue is restored and the uploads resume exactly where they
// stopped. A row is removed only once the server has accepted it.
//
// Everything here is best-effort: if IndexedDB is unavailable the helpers no-op
// and the caller still works in-memory for the current session.

export type QueuedUpload = {
  key: string;
  seafarerId: string;
  name: string;
  size: number;
  originalSize: number;
  blob: Blob;
  status: "pending" | "failed";
  createdAt: number;
};

const DB_NAME = "docka-uploads";
const STORE = "queue";
const VERSION = 1;

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!idbAvailable()) return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function putUpload(item: QueuedUpload): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const r = tx(db, "readwrite").put(item);
      r.onsuccess = () => resolve();
      r.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

export async function setUploadStatus(
  key: string,
  status: QueuedUpload["status"]
): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const store = tx(db, "readwrite");
      const g = store.get(key);
      g.onsuccess = () => {
        const cur = g.result as QueuedUpload | undefined;
        if (!cur) return resolve();
        cur.status = status;
        const p = store.put(cur);
        p.onsuccess = () => resolve();
        p.onerror = () => resolve();
      };
      g.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

export async function removeUpload(key: string): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const r = tx(db, "readwrite").delete(key);
      r.onsuccess = () => resolve();
      r.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

export async function loadUploads(seafarerId: string): Promise<QueuedUpload[]> {
  const db = await open();
  if (!db) return [];
  const all = await new Promise<QueuedUpload[]>((resolve) => {
    try {
      const r = tx(db, "readonly").getAll();
      r.onsuccess = () => resolve((r.result as QueuedUpload[]) ?? []);
      r.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
  db.close();
  return all
    .filter((u) => u.seafarerId === seafarerId)
    .sort((a, b) => a.createdAt - b.createdAt);
}
