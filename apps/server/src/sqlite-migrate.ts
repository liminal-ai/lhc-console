import type { DatabaseSync } from "node:sqlite";

export function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(ddl);
  }
}

export function runExclusiveMigration(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN EXCLUSIVE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
