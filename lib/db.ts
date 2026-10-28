// Saves generated exams in the browser (IndexedDB) so they can be printed / downloaded again later.
// Stored per browser on this computer. Questions are saved, and PDFs are rebuilt from them on demand.
import type { Exam } from "@/exam";

const DB_NAME = "centerapp-exams", STORE = "exams";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export async function listExams(): Promise<Exam[]> {
  const all = await run<Exam[]>("readonly", (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export const saveExam = (e: Exam) => run("readwrite", (s) => s.put(e)).then(() => undefined);
export const removeExam = (id: string) => run("readwrite", (s) => s.delete(id)).then(() => undefined);
