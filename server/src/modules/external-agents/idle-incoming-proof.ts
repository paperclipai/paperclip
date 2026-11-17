import { sql, type SQL } from "drizzle-orm";
import type { IdleMcpWakeProof } from "../../services/public-mcp/idle-wake-proof.js";
import { idleExternalAgentHistoryChecks } from "./idle-history-proof.js";



export function idleExternalAgentIncomingWorkQuery(reason: string, proof?: IdleMcpWakeProof): SQL | undefined {
  if (!proof?.dotBindingIds.length) return;
  const ids = sql.join(proof.dotBindingIds.map(id => sql`${id}::uuid`), sql`, `);
  const check = idleExternalAgentHistoryChecks.find(check => check.reason === reason);
  if (!check) return;
  if (reason === "dot_agent_bindings") return sql`${sql.raw(check.query)} AND b.id NOT IN (${ids})`;
  if (reason === "dot_mailbox_items") {



    return sql`${sql.raw(check.query)} AND NOT (m.binding_id IN (${ids}) AND m.assignment_id IS NULL
      AND m.kind = 'readiness_challenge' AND EXISTS (SELECT 1 FROM dot_agent_bindings binding
        WHERE binding.id = m.binding_id AND binding.company_id = m.company_id
          AND m.binding_generation > 0 AND m.binding_generation <= binding.generation
          AND binding.challenge_hash IS NULL AND binding.pairing_code_hash IS NULL))`;
  }
}
