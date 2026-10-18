import type { ValueStore } from '../app/settings';

const DB = 'esp-web-tool';
const STORE = 'plans';

/**
 * IndexedDB, which (unlike localStorage) can keep file and folder handles across reloads.
 * Any failure (blocked site data, private mode) rejects; the app then just doesn't keep plans.
 */
export function indexedDbStore(): ValueStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
    open().then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const req = fn(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: async (key, value) => {
      await run('readwrite', (s) => s.put(value, key));
    },
  };
}
