export type StoredPrivatePost = {
  _id: string;
  boardSlug: string;
  urlName: string;
  listedAt: number;
  detailedAt?: number;
  listedCommentCount: number;
  combinedText: string;
  lastActivityAt: number;
  payload: Record<string, unknown>;
};

type MetaRecord =
  | { key: "viewer"; viewerId: string }
  | { key: "queue"; ids: string[] }
  | { key: `board:${string}`; slug: string; lastListSync: number; complete: boolean };

const DB_NAME = "vrcfb-private-v1";
const DB_VERSION = 1;

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function idbFactory(target?: Window & typeof globalThis): IDBFactory | null {
  if (typeof indexedDB !== "undefined") {
    return indexedDB;
  }
  if (target && "indexedDB" in target) {
    return target.indexedDB;
  }
  return null;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let dbTarget: (Window & typeof globalThis) | undefined;

function openDb(target?: Window & typeof globalThis): Promise<IDBDatabase> {
  if (dbPromise && dbTarget === target) {
    return dbPromise;
  }
  const factory = idbFactory(target);
  if (!factory) {
    return Promise.reject(new Error("IndexedDB is not available"));
  }
  dbTarget = target;
  dbPromise = new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("posts")) {
        const posts = db.createObjectStore("posts", { keyPath: "_id" });
        posts.createIndex("boardSlug", "boardSlug", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("Failed to open private-board IndexedDB"));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function txDone(tx: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function readViewerId(db: IDBDatabase): Promise<string> {
  const tx = db.transaction("meta", "readonly");
  const rec = (await idbRequest(
    tx.objectStore("meta").get("viewer"),
  )) as MetaRecord | undefined;
  return rec && rec.key === "viewer" ? rec.viewerId : "";
}

async function clearAll(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(["posts", "meta"], "readwrite");
  tx.objectStore("posts").clear();
  tx.objectStore("meta").clear();
  await txDone(tx);
}

/** Open the store for this viewer, wiping data if a different account is present. */
export async function ensurePrivateStore(
  viewerId: string,
  target?: Window & typeof globalThis,
): Promise<void> {
  if (!viewerId) {
    return;
  }
  const db = await openDb(target);
  const existing = await readViewerId(db);
  if (existing === viewerId) {
    return;
  }
  await clearAll(db);
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put({ key: "viewer", viewerId } satisfies MetaRecord);
  await txDone(tx);
}

export async function getAllPrivatePosts(
  viewerId: string,
  target?: Window & typeof globalThis,
): Promise<StoredPrivatePost[]> {
  if (!viewerId) {
    return [];
  }
  try {
    const db = await openDb(target);
    const storedViewer = await readViewerId(db);
    if (storedViewer !== viewerId) {
      return [];
    }
    const tx = db.transaction("posts", "readonly");
    const rows = await idbRequest(tx.objectStore("posts").getAll());
    return Array.isArray(rows) ? (rows as StoredPrivatePost[]) : [];
  } catch {
    return [];
  }
}

export async function getPrivatePostsByBoard(
  viewerId: string,
  boardSlug: string,
  target?: Window & typeof globalThis,
): Promise<StoredPrivatePost[]> {
  if (!viewerId) {
    return [];
  }
  const db = await openDb(target);
  const storedViewer = await readViewerId(db);
  if (storedViewer !== viewerId) {
    return [];
  }
  const tx = db.transaction("posts", "readonly");
  const index = tx.objectStore("posts").index("boardSlug");
  const rows = await idbRequest(index.getAll(boardSlug));
  return Array.isArray(rows) ? (rows as StoredPrivatePost[]) : [];
}

export async function getPrivatePost(
  id: string,
  target?: Window & typeof globalThis,
): Promise<StoredPrivatePost | undefined> {
  const db = await openDb(target);
  const tx = db.transaction("posts", "readonly");
  const row = await idbRequest(tx.objectStore("posts").get(id));
  return row as StoredPrivatePost | undefined;
}

export async function putPrivatePosts(
  posts: StoredPrivatePost[],
  target?: Window & typeof globalThis,
): Promise<void> {
  if (posts.length === 0) {
    return;
  }
  const db = await openDb(target);
  const tx = db.transaction("posts", "readwrite");
  const store = tx.objectStore("posts");
  for (const post of posts) {
    store.put(post);
  }
  await txDone(tx);
}

export async function deletePrivatePosts(
  ids: string[],
  target?: Window & typeof globalThis,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const db = await openDb(target);
  const tx = db.transaction("posts", "readwrite");
  const store = tx.objectStore("posts");
  for (const id of ids) {
    store.delete(id);
  }
  await txDone(tx);
}

export async function countPrivatePosts(
  viewerId: string,
  target?: Window & typeof globalThis,
): Promise<number> {
  if (!viewerId) {
    return 0;
  }
  try {
    const db = await openDb(target);
    const storedViewer = await readViewerId(db);
    if (storedViewer !== viewerId) {
      return 0;
    }
    const tx = db.transaction("posts", "readonly");
    return await idbRequest(tx.objectStore("posts").count());
  } catch {
    return 0;
  }
}

export async function getCommentQueue(
  target?: Window & typeof globalThis,
): Promise<string[]> {
  try {
    const db = await openDb(target);
    const tx = db.transaction("meta", "readonly");
    const rec = (await idbRequest(
      tx.objectStore("meta").get("queue"),
    )) as MetaRecord | undefined;
    return rec && rec.key === "queue" && Array.isArray(rec.ids) ? rec.ids : [];
  } catch {
    return [];
  }
}

export async function setCommentQueue(
  ids: string[],
  target?: Window & typeof globalThis,
): Promise<void> {
  const db = await openDb(target);
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put({ key: "queue", ids } satisfies MetaRecord);
  await txDone(tx);
}

export async function markBoardListSync(
  slug: string,
  complete: boolean,
  target?: Window & typeof globalThis,
): Promise<void> {
  const db = await openDb(target);
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put({
    key: `board:${slug}`,
    slug,
    lastListSync: Date.now(),
    complete,
  } satisfies MetaRecord);
  await txDone(tx);
}
