import { and, desc, eq, ne } from "drizzle-orm";
import { routineCheckRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { CheckStatus } from "./types.js";

export async function computePreviousStatus(args: {
  db: Db;
  checkName: string;
  currentId: string;
}): Promise<CheckStatus | null> {
  const rows = await args.db
    .select({ status: routineCheckRuns.status })
    .from(routineCheckRuns)
    .where(and(eq(routineCheckRuns.checkName, args.checkName), ne(routineCheckRuns.id, args.currentId)))
    .orderBy(desc(routineCheckRuns.scheduledFor))
    .limit(1);
  return rows[0] ? (rows[0].status as CheckStatus) : null;
}
