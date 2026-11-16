import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type SchemaDriftMissingColumn = { table: string; column: string };

export type SchemaDriftReport = {
  drifted: boolean;
  checkedTables: number;
  missingTables: string[];
  missingColumns: SchemaDriftMissingColumn[];
};

type ExpectedSchema = Map<string, Set<string>>;

export function collectExpectedSchema(): ExpectedSchema {
  const expected: ExpectedSchema = new Map();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const tableName = getTableName(value);
    const columns = getTableColumns(value);
    const columnNames = new Set<string>();
    for (const column of Object.values(columns)) {
      columnNames.add(column.name);
    }
    const existing = expected.get(tableName);
    if (existing) {
      for (const name of columnNames) existing.add(name);
    } else {
      expected.set(tableName, columnNames);
    }
  }
  return expected;
}

async function loadLiveSchema(url: string): Promise<Map<string, Set<string>>> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `;
    const live = new Map<string, Set<string>>();
    for (const row of rows) {
      let columns = live.get(row.table_name);
      if (!columns) {
        columns = new Set();
        live.set(row.table_name, columns);
      }
      columns.add(row.column_name);
    }
    return live;
  } finally {
    await sql.end();
  }
}

export function diffSchema(expected: ExpectedSchema, live: Map<string, Set<string>>): SchemaDriftReport {
  const missingTables: string[] = [];
  const missingColumns: SchemaDriftMissingColumn[] = [];

  for (const [tableName, expectedColumns] of expected) {
    const liveColumns = live.get(tableName);
    if (!liveColumns) {
      missingTables.push(tableName);
      continue;
    }
    for (const column of expectedColumns) {
      if (!liveColumns.has(column)) {
        missingColumns.push({ table: tableName, column });
      }
    }
  }

  missingTables.sort((a, b) => a.localeCompare(b));
  missingColumns.sort((a, b) =>
    a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table),
  );

  return {
    drifted: missingTables.length > 0 || missingColumns.length > 0,
    checkedTables: expected.size,
    missingTables,
    missingColumns,
  };
}

export async function inspectSchemaDrift(url: string): Promise<SchemaDriftReport> {
  const expected = collectExpectedSchema();
  const live = await loadLiveSchema(url);
  return diffSchema(expected, live);
}

export function formatSchemaDriftReport(report: SchemaDriftReport): string {
  if (!report.drifted) {
    return `No schema drift detected (checked ${report.checkedTables} table(s)).`;
  }

  const lines: string[] = [
    `Schema drift detected (checked ${report.checkedTables} table(s)):`,
  ];
  if (report.missingTables.length > 0) {
    lines.push(`  Missing tables (${report.missingTables.length}): ${report.missingTables.join(", ")}`);
  }
  if (report.missingColumns.length > 0) {
    lines.push(`  Missing columns (${report.missingColumns.length}):`);
    for (const { table, column } of report.missingColumns) {
      lines.push(`    - ${table}.${column}`);
    }
  }
  return lines.join("\n");
}

export class SchemaDriftError extends Error {
  readonly report: SchemaDriftReport;
  constructor(report: SchemaDriftReport) {
    super(formatSchemaDriftReport(report));
    this.name = "SchemaDriftError";
    this.report = report;
  }
}

export async function assertNoSchemaDrift(url: string): Promise<SchemaDriftReport> {
  const report = await inspectSchemaDrift(url);
  if (report.drifted) {
    throw new SchemaDriftError(report);
  }
  return report;
}
