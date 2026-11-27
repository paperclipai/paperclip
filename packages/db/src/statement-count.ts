import type { Logger } from "drizzle-orm";

let statements = 0;

export const statementCountingLogger: Logger = {
  logQuery(): void {
    statements += 1;
  },
};

export function databaseStatementCount(): number {
  return statements;
}
