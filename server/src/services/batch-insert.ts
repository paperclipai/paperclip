// Chunked multi-row insert helper.
//
// PostgreSQL caps a single statement at 65535 bind parameters. A multi-row
// insert binds `columnsPerRow * rowCount` parameters, so large imports must
// split their rows into chunks that stay under that ceiling. This helper keeps
// the arithmetic (and the "insert nothing when there is nothing" guard) in one
// place so every import writer batches identically.

// One below the hard 65535 ceiling so the arithmetic never lands exactly on it.
export const POSTGRES_MAX_BIND_PARAMS = 65534;

// A conservative row cap so a single statement stays small even for narrow
// tables. Large enough that the common import tables issue a handful of
// statements, small enough to avoid pathological statement sizes.
export const DEFAULT_INSERT_CHUNK_ROWS = 500;

// drizzle types `insert` as a per-table generic (`<T extends PgTable>`), which a
// table-agnostic helper cannot satisfy; `any` on the boundary is the standard
// escape hatch. Callers pass concretely-typed `db`/`tx` handles and tables.
type InsertExecutor = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert: (table: any) => { values: (rows: any) => unknown };
};

/**
 * Insert `rows` into `table` using chunked multi-row statements.
 *
 * Rows are normalized to a shared column set (the union of keys across the
 * batch, with missing/`undefined` values written as `null`) so a single
 * multi-row `values()` call stays well-formed even if a caller omitted an
 * optional column on some rows. Callers must therefore set every NOT NULL /
 * default-backed column they rely on explicitly; only genuinely nullable
 * columns should be left absent.
 */
export async function insertRowsInChunks(
  executor: InsertExecutor,
  table: unknown,
  rows: Array<Record<string, unknown>>,
  options?: { maxRows?: number },
): Promise<void> {
  if (rows.length === 0) return;

  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) keys.add(key);
  }
  const columns = [...keys];
  const normalized = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of columns) {
      const value = row[key];
      out[key] = value === undefined ? null : value;
    }
    return out;
  });

  const columnsPerRow = Math.max(1, columns.length);
  const chunkSize = Math.max(
    1,
    Math.min(
      options?.maxRows ?? DEFAULT_INSERT_CHUNK_ROWS,
      Math.floor(POSTGRES_MAX_BIND_PARAMS / columnsPerRow),
    ),
  );

  for (let start = 0; start < normalized.length; start += chunkSize) {
    await executor.insert(table).values(normalized.slice(start, start + chunkSize));
  }
}
