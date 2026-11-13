import { sql, type SQL } from "drizzle-orm";
import { idleMcpHistoryChecks } from "./idle-history-proof.js";
import type { IdleMcpWakeProof } from "./idle-wake-proof.js";
import type { IdleMcpSubscriptionProof } from "./idle-subscription-proof.js";
import type { IdleMcpEventScheduleProof } from "./idle-event-schedule.js";
import type { IdleDeadlineSnapshot } from "../idle-deadline-types.js";




export function idleMcpWorkQuery(reason: string, input: {
  ingress?: IdleMcpWakeProof;
  subscriptions?: IdleMcpSubscriptionProof;
  retries?: IdleMcpEventScheduleProof;
  transfers?: IdleDeadlineSnapshot;
  handoffs?: IdleDeadlineSnapshot;
}): SQL | undefined {
  const check = idleMcpHistoryChecks.find(check => check.reason === reason);
  if (!check || !input.ingress) return;
  if (reason === "mcp_file_tickets" && input.transfers) return sql`SELECT 1 WHERE ${input.transfers.blocked}`;
  if (reason === "mcp_authorization_handoffs" && input.handoffs) return sql`SELECT 1 WHERE ${input.handoffs.blocked}`;
  if (reason === "mcp_oauth_grants" && input.ingress.grantIds.length) {
    return sql`${sql.raw(check.query)} AND g.id NOT IN (${sql.join(input.ingress.grantIds.map(id => sql`${id}::uuid`), sql`, `)})`;
  }
  if (reason === "mcp_event_subscriptions" && input.subscriptions?.blocked === false && input.subscriptions.subscriptionIds.length) {
    return sql`${sql.raw(check.query)} AND s.id NOT IN (${sql.join(input.subscriptions.subscriptionIds.map(id => sql`${id}`), sql`, `)})`;
  }
  if (reason === "mcp_event_deliveries" && input.retries?.blocked === false && input.retries.deliveryIds.length) {
    return sql`${sql.raw(check.query)} AND d.id NOT IN (${sql.join(input.retries.deliveryIds.map(id => sql`${id}::uuid`), sql`, `)})`;
  }
}
