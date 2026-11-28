import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { issueComments, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

type WriteDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export function insertIssueComment(db: WriteDb, input: PgInsertValue<typeof issueComments> & { companyId: string }) {
  return db.transaction(async tx => {
    await notifyStatusCardIssueChange(tx, input.companyId);
    await notifyIssueRecovery(tx, { companyId: input.companyId,
      issueId: typeof input.issueId === "string" ? input.issueId : undefined });
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.dotEvents, `company:${input.companyId}`);
    return tx.insert(issueComments).values(input).returning();
  });
}
