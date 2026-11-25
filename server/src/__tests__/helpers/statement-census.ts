import type { Db } from "@paperclipai/db";
import { meterDatabaseStatements, type MeteredStatement } from "./database-statement-meter.js";

export type StatementShape = { shape: string; count: number; callers: string[] };
export type RequestCensus = { statements: number; transactions: number; shapes: StatementShape[]; log: MeteredStatement[] };

export function normalizeStatementShape(sql: string) {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\$\d+(?:\s*,\s*\$\d+)*/g, "$n")
    .replace(/\(\s*\$n\s*\)(?:\s*,\s*\(\s*\$n\s*\))+/g, "($n)")
    .trim();
}

export function statementCaller(stack: string | undefined, depth = 3) {
  if (!stack) return "unknown";
  const frames = stack.split("\n").slice(1).map((line) => line.trim())
    .filter((line) => line.includes("/server/src/") && !line.includes("/__tests__/"))
    .slice(0, depth)
    .map((line) => {
      const match = /at (?:async )?(?:(\S+) )?\(?.*\/server\/src\/([^:)]+):(\d+)/.exec(line);
      return match ? `${match[2]}:${match[3]}${match[1] ? ` ${match[1]}` : ""}` : line;
    });
  return frames.length > 0 ? frames.join(" < ") : "unknown";
}

export function groupStatementShapes(log: MeteredStatement[]): StatementShape[] {
  const byShape = new Map<string, StatementShape>();
  for (const entry of log) {
    const shape = normalizeStatementShape(entry.sql);
    const group = byShape.get(shape) ?? { shape, count: 0, callers: [] };
    group.count += 1;
    const caller = statementCaller(entry.stack);
    if (!group.callers.includes(caller)) group.callers.push(caller);
    byShape.set(shape, group);
  }
  return [...byShape.values()].sort((left, right) => right.count - left.count);
}

export function createStatementCensus(db: Db) {
  const { host, port } = (db.$client as unknown as { options: { host: string[]; port: number[] } }).options;
  const meter = meterDatabaseStatements(db, `postgres://${host[0]}:${port[0]}/census`);
  return {
    async measure(run: () => Promise<unknown>, options: { stacks?: boolean } = {}): Promise<RequestCensus> {
      const before = meter.read();
      meter.startLog(options);
      let log: MeteredStatement[];
      try {
        await run();
      } finally {
        log = meter.stopLog();
      }
      const after = meter.read();
      return {
        statements: after.statements - before.statements,
        transactions: after.transactions - before.transactions,
        shapes: groupStatementShapes(log),
        log,
      };
    },
    uninstall: () => meter.uninstall(),
  };
}

export function formatStatementCensus(label: string, census: RequestCensus, top = 5) {
  const lines = [`${label}: ${census.statements} statements, ${census.transactions} transactions`];
  for (const shape of census.shapes.slice(0, top)) {
    lines.push(`  ${String(shape.count).padStart(3)}x ${shape.shape.slice(0, 160)}`);
    for (const caller of shape.callers.slice(0, 3)) lines.push(`        ${caller}`);
  }
  return lines.join("\n");
}
