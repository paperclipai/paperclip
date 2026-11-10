import type { Db } from "@paperclipai/db";
import type { AttentionSourceKind } from "@paperclipai/shared";
import { decisionRetentionService, DEFAULT_DECISION_ARCHIVE_DAYS } from "./decision-retention.js";

type Candidate = { id: string; companyId: string; at: Date; cursorAt: string };
type Cursor = { at: string; id: string };

export function createDecisionRetentionSweep(db: Db, options: {
  sourceKind: AttentionSourceKind;
  failureMessage: string;
  end(cutoff: Date): Promise<Cursor | undefined>;
  page(cutoff: Date, cursor: Cursor | undefined, end: Cursor, limit: number): Promise<Candidate[]>;
  lock(database: Db, id: string, cutoff: Date): Promise<Candidate | undefined>;
  next(): Promise<number | null>;
}) {
  let cursor: Cursor | undefined;
  let end: Cursor | undefined;
  const batchSize = 100;
  async function sweep(now = new Date(), signal?: AbortSignal) {
    const cutoff = new Date(now.getTime() - DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000);
    end ??= await options.end(cutoff);
    if (!end) return { archived: 0 };
    const rows = await options.page(cutoff, cursor, end, batchSize);
    let archived = 0;
    const errors: unknown[] = [];
    for (const candidate of rows) {
      if (signal?.aborted) break;
      try {
        archived += await db.transaction(async tx => {
          const database = tx as unknown as Db;
          const current = await options.lock(database, candidate.id, cutoff);
          if (!current) return 0;
          const retention = decisionRetentionService(database);
          const source = { sourceKind: options.sourceKind, subject: { id: current.id }, activityAt: current.at.toISOString() };
          const states = await retention.syncItems(current.companyId, [source]);
          const state = states.get(`${options.sourceKind}:${current.id}`)!;
          return retention.autoArchive({ companyId: current.companyId, now, items: [{ ...source,
            keep: state.keep, archivedAt: state.archivedAt?.toISOString() ?? null, retentionVersion: state.version,
          }] });
        });
      } catch (error) { errors.push(error); }
      cursor = { at: candidate.cursorAt, id: candidate.id };
    }
    if (rows.length < batchSize) { cursor = undefined; end = undefined; }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, options.failureMessage);
    return { archived };
  }
  return { sweep, next: options.next };
}
