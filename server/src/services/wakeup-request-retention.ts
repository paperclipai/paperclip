import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

// Keep terminal requests for at least as long as the issue diagnostics lookback.
// The diagnostics service currently supports a 14-day wake-history window.
export const WAKEUP_REQUEST_TERMINAL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const WAKEUP_REQUEST_RETENTION_BATCH_SIZE = 10_000;

export function wakeupRequestRetentionService(db: Db) {
  return {
    async pruneTerminalRequests(opts?: { now?: Date; batchSize?: number }) {
      const now = opts?.now ?? new Date();
      const batchSize = Math.max(1, Math.floor(opts?.batchSize ?? WAKEUP_REQUEST_RETENTION_BATCH_SIZE));
      const cutoff = new Date(now.getTime() - WAKEUP_REQUEST_TERMINAL_RETENTION_MS);
      const cutoffIso = cutoff.toISOString();
      const companyRows = await db.execute(sql<{ id: string }>`
        select id
        from companies
        order by id
      `);

      let deleted = 0;
      for (const company of Array.from(companyRows)) {
        const remaining = batchSize - deleted;
        if (remaining <= 0) break;

        // The company/requested_at index bounds candidate discovery. A skipped
        // request with a run_id became part of the heartbeat audit trail and is
        // retained. Coalesced requests point at another request's run and never
        // own a heartbeat_runs.wakeup_request_id reference.
        const deletedRows = await db.execute(sql<{ id: string }>`
          with candidates as materialized (
            select request.id
            from agent_wakeup_requests request
            where request.company_id = ${company.id}
              and request.requested_at < ${cutoffIso}::timestamptz
              and (
                (request.status = 'skipped' and request.run_id is null)
                or request.status = 'coalesced'
              )
            order by request.requested_at, request.id
            limit ${remaining}
            for update skip locked
          )
          delete from agent_wakeup_requests request
          using candidates
          where request.id = candidates.id
          returning request.id
        `);
        deleted += Array.from(deletedRows).length;
      }

      return {
        deleted,
        hasMore: deleted === batchSize,
        cutoff,
      };
    },
  };
}
