import { sql, type SQLWrapper } from "drizzle-orm";
import { agentWakeupRequests } from "@paperclipai/db";
import { REVIEWER_ASSIGNMENT_CONTINUATION_KEY } from "./domain/receipt-namespace.js";

export { hasReviewerAssignmentContinuation } from "./domain/receipt-namespace.js";

export function ordinaryWakeRequestPredicate(payload: SQLWrapper = agentWakeupRequests.payload) {
  return sql`NOT COALESCE(${payload} ? ${REVIEWER_ASSIGNMENT_CONTINUATION_KEY}, false)`;
}
