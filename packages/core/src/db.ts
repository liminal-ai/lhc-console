import { DatabaseSync } from "node:sqlite";

/**
 * Open a SQLite file read-only. The console never writes host-owned files;
 * every open in this package goes through here.
 */
export function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/** Run `fn` against a read-only connection, always closing it. */
export function withDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = openReadOnly(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
