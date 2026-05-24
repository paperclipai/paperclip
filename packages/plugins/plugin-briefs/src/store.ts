import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type {
  BriefCard,
  BriefCardSource,
  BriefPreferences,
  BriefSnapshot,
} from "./contracts.js";

type BriefCardRow = {
  id: string;
  company_id: string;
  user_id: string;
  slug: string;
  title: string;
  grouping_description: string;
  root_issue_id: string | null;
  state: BriefCard["state"];
  summary_status: BriefCard["summaryStatus"];
  pinned: boolean;
  hidden: boolean;
  stale_at: string;
  expires_at: string | null;
  latest_snapshot_id: string | null;
  last_meaningful_event_at: string;
};

type BriefSnapshotRow = {
  id: string;
  company_id: string;
  user_id: string;
  card_id: string;
  summary_paragraph: string | null;
  summary_status: BriefSnapshot["summaryStatus"];
  summary_model: string | null;
  summary_tokens_in: number | null;
  summary_tokens_out: number | null;
  summary_failure_reason: BriefSnapshot["summaryFailureReason"];
  task_rows: unknown;
  evidence_source_ids: unknown;
  generated_by_agent_id: string | null;
  generated_by_run_id: string | null;
  deterministic_state_inputs: unknown;
  created_at: string;
};

type BriefSourceRow = {
  id: string;
  company_id: string;
  user_id: string;
  card_id: string;
  source_kind: BriefCardSource["sourceKind"];
  source_id: string;
  issue_id: string | null;
  identifier: string | null;
  title_line: string;
  right_tag: string;
  link_path: string;
  is_intra_tree_blocked: boolean | null;
  event_at: string;
  metadata: unknown;
  total_source_count?: number;
};

const SOURCES_PER_CARD_LIMIT = 200;

function table(namespace: string, name: string): string {
  return `${namespace}.${name}`;
}

function toSnapshot(row: BriefSnapshotRow): BriefSnapshot {
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    cardId: row.card_id,
    summaryParagraph: row.summary_paragraph,
    summaryStatus: row.summary_status,
    summaryModel: row.summary_model,
    summaryTokensIn: row.summary_tokens_in,
    summaryTokensOut: row.summary_tokens_out,
    summaryFailureReason: row.summary_failure_reason,
    taskRows: Array.isArray(row.task_rows) ? row.task_rows as BriefSnapshot["taskRows"] : [],
    evidenceSourceIds: Array.isArray(row.evidence_source_ids) ? row.evidence_source_ids as string[] : [],
    generatedByAgentId: row.generated_by_agent_id,
    generatedByRunId: row.generated_by_run_id,
    deterministicStateInputs: row.deterministic_state_inputs && typeof row.deterministic_state_inputs === "object"
      ? row.deterministic_state_inputs as Record<string, unknown>
      : {},
    createdAt: row.created_at,
  };
}

function toSource(row: BriefSourceRow): BriefCardSource {
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    cardId: row.card_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    issueId: row.issue_id,
    identifier: row.identifier,
    titleLine: row.title_line,
    rightTag: row.right_tag,
    linkPath: row.link_path,
    isIntraTreeBlocked: row.is_intra_tree_blocked,
    eventAt: row.event_at,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {},
  };
}

function toCard(
  row: BriefCardRow,
  snapshot: BriefSnapshot,
  sources: BriefCardSource[],
  totalSourceCount = sources.length,
): BriefCard {
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    slug: row.slug,
    title: row.title,
    groupingDescription: row.grouping_description,
    rootIssueId: row.root_issue_id,
    state: row.state,
    summaryStatus: row.summary_status,
    pinned: row.pinned,
    hidden: row.hidden,
    staleAt: row.stale_at,
    expiresAt: row.expires_at,
    latestSnapshotId: row.latest_snapshot_id,
    lastMeaningfulEventAt: row.last_meaningful_event_at,
    snapshot,
    sources,
    moreSourceCount: Math.max(0, totalSourceCount - snapshot.taskRows.length),
  };
}

export function createBriefsStore(db: PluginDatabaseClient) {
  const cardsTable = table(db.namespace, "briefs_cards");
  const sourcesTable = table(db.namespace, "briefs_card_sources");
  const snapshotsTable = table(db.namespace, "briefs_card_snapshots");
  const preferencesTable = table(db.namespace, "briefs_user_preferences");

  return {
    async listCards(input: { companyId: string; userId: string; includeHidden?: boolean; limit?: number }): Promise<BriefCard[]> {
      const cardRows = await db.query<BriefCardRow>(
        `SELECT id, company_id, user_id, slug, title, grouping_description, root_issue_id, state, summary_status,
                pinned, hidden, stale_at, expires_at, latest_snapshot_id, last_meaningful_event_at
         FROM ${cardsTable}
         WHERE company_id = $1 AND user_id = $2 AND ($3::boolean OR hidden = false)
         ORDER BY pinned DESC, last_meaningful_event_at DESC, id DESC
         LIMIT $4`,
        [input.companyId, input.userId, Boolean(input.includeHidden), input.limit ?? 50],
      );

      const snapshotIds = cardRows
        .map((card) => card.latest_snapshot_id)
        .filter((id): id is string => Boolean(id));
      if (snapshotIds.length === 0) return [];

      const snapshots = await db.query<BriefSnapshotRow>(
        `SELECT id, company_id, user_id, card_id, summary_paragraph, summary_status, summary_model,
                summary_tokens_in, summary_tokens_out, summary_failure_reason, task_rows, evidence_source_ids,
                generated_by_agent_id, generated_by_run_id, deterministic_state_inputs, created_at
         FROM ${snapshotsTable}
         WHERE company_id = $1 AND user_id = $2 AND id = ANY($3::uuid[])`,
        [input.companyId, input.userId, snapshotIds],
      );
      const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
      const cardIds = cardRows.map((card) => card.id);
      const sourceRows = await db.query<BriefSourceRow>(
        `WITH ranked_sources AS (
           SELECT id, company_id, user_id, card_id, source_kind, source_id, issue_id, identifier, title_line,
                  right_tag, link_path, is_intra_tree_blocked, event_at, metadata,
                  count(*) OVER (PARTITION BY card_id)::int AS total_source_count,
                  row_number() OVER (PARTITION BY card_id ORDER BY event_at DESC, id DESC) AS source_rank
           FROM ${sourcesTable}
           WHERE company_id = $1 AND user_id = $2 AND card_id = ANY($3::uuid[])
         )
         SELECT id, company_id, user_id, card_id, source_kind, source_id, issue_id, identifier, title_line,
                right_tag, link_path, is_intra_tree_blocked, event_at, metadata, total_source_count
         FROM ranked_sources
         WHERE source_rank <= $4
         ORDER BY card_id, event_at DESC, id DESC`,
        [input.companyId, input.userId, cardIds, SOURCES_PER_CARD_LIMIT],
      );
      const sourcesByCardId = new Map<string, BriefCardSource[]>();
      const sourceCountsByCardId = new Map<string, number>();
      for (const row of sourceRows) {
        const sources = sourcesByCardId.get(row.card_id) ?? [];
        sources.push(toSource(row));
        sourcesByCardId.set(row.card_id, sources);
        sourceCountsByCardId.set(row.card_id, row.total_source_count ?? sources.length);
      }

      const cards: BriefCard[] = [];
      for (const card of cardRows) {
        if (!card.latest_snapshot_id) continue;
        const snapshot = snapshotsById.get(card.latest_snapshot_id);
        if (!snapshot) continue;
        const sources = sourcesByCardId.get(card.id) ?? [];
        cards.push(toCard(card, toSnapshot(snapshot), sources, sourceCountsByCardId.get(card.id)));
      }
      return cards;
    },

    async saveCard(card: BriefCard): Promise<BriefCard> {
      const existingBeforeRows = await db.query<{ id: string; pinned: boolean; hidden: boolean }>(
        `SELECT id, pinned, hidden FROM ${cardsTable} WHERE company_id = $1 AND user_id = $2 AND slug = $3 LIMIT 1`,
        [card.companyId, card.userId, card.slug],
      );
      const existingBefore = existingBeforeRows[0] ?? null;
      const pinned = Boolean(existingBefore?.pinned || card.pinned);
      const hidden = Boolean(existingBefore?.hidden || card.hidden);

      await db.execute(
        `INSERT INTO ${cardsTable} (
           id, company_id, user_id, slug, title, grouping_description, root_issue_id, state, summary_status,
           pinned, hidden, stale_at, expires_at, latest_snapshot_id, last_meaningful_event_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, NULL, $14::timestamptz)
         ON CONFLICT (company_id, user_id, slug) DO UPDATE SET
           title = EXCLUDED.title,
           grouping_description = EXCLUDED.grouping_description,
           root_issue_id = EXCLUDED.root_issue_id,
           state = EXCLUDED.state,
           summary_status = EXCLUDED.summary_status,
           pinned = ${cardsTable}.pinned OR EXCLUDED.pinned,
           hidden = ${cardsTable}.hidden OR EXCLUDED.hidden,
           stale_at = EXCLUDED.stale_at,
           expires_at = CASE WHEN ${cardsTable}.pinned OR EXCLUDED.pinned THEN NULL ELSE EXCLUDED.expires_at END,
           last_meaningful_event_at = EXCLUDED.last_meaningful_event_at,
           updated_at = now()`,
        [
          card.id,
          card.companyId,
          card.userId,
          card.slug,
          card.title,
          card.groupingDescription,
          card.rootIssueId,
          card.state,
          card.summaryStatus,
          pinned,
          hidden,
          card.staleAt,
          pinned ? null : card.expiresAt,
          card.lastMeaningfulEventAt,
        ],
      );

      const existingRows = await db.query<{ id: string; pinned: boolean; hidden: boolean }>(
        `SELECT id, pinned, hidden FROM ${cardsTable} WHERE company_id = $1 AND user_id = $2 AND slug = $3 LIMIT 1`,
        [card.companyId, card.userId, card.slug],
      );
      const persistedCardId = existingRows[0]?.id ?? card.id;
      const sourceRowsJson = JSON.stringify(card.sources.map((source) => ({
        id: source.id,
        source_kind: source.sourceKind,
        source_id: source.sourceId,
        issue_id: source.issueId,
        identifier: source.identifier,
        title_line: source.titleLine,
        right_tag: source.rightTag,
        link_path: source.linkPath,
        is_intra_tree_blocked: source.isIntraTreeBlocked,
        event_at: source.eventAt,
        metadata: source.metadata ?? {},
      })));

      await db.execute(
        `WITH deleted_sources AS (
           DELETE FROM ${sourcesTable}
           WHERE company_id = $1 AND user_id = $2 AND card_id = $3
           RETURNING id
         ),
         source_rows AS (
           SELECT *
           FROM jsonb_to_recordset($4::jsonb) AS source(
             id uuid,
             source_kind text,
             source_id text,
             issue_id uuid,
             identifier text,
             title_line text,
             right_tag text,
             link_path text,
             is_intra_tree_blocked boolean,
             event_at timestamptz,
             metadata jsonb
           )
         ),
         inserted_sources AS (
           INSERT INTO ${sourcesTable} (
             id, company_id, user_id, card_id, source_kind, source_id, issue_id, identifier, title_line,
             right_tag, link_path, is_intra_tree_blocked, event_at, metadata
           )
           SELECT id, $1::uuid, $2, $3::uuid, source_kind, source_id, issue_id, identifier, title_line,
                  right_tag, link_path, is_intra_tree_blocked, event_at, metadata
           FROM source_rows
           RETURNING id
         ),
         inserted_snapshot AS (
           INSERT INTO ${snapshotsTable} (
             id, company_id, user_id, card_id, summary_paragraph, summary_status, summary_model,
             summary_tokens_in, summary_tokens_out, summary_failure_reason, task_rows, evidence_source_ids,
             generated_by_agent_id, generated_by_run_id, deterministic_state_inputs
           )
           VALUES ($5::uuid, $1::uuid, $2, $3::uuid, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16::jsonb)
           RETURNING id
         )
         UPDATE ${cardsTable}
         SET latest_snapshot_id = (SELECT id FROM inserted_snapshot), updated_at = now()
         WHERE company_id = $1 AND user_id = $2 AND id = $3`,
        [
          card.companyId,
          card.userId,
          persistedCardId,
          sourceRowsJson,
          card.snapshot.id,
          card.snapshot.summaryParagraph,
          card.snapshot.summaryStatus,
          card.snapshot.summaryModel,
          card.snapshot.summaryTokensIn,
          card.snapshot.summaryTokensOut,
          card.snapshot.summaryFailureReason,
          JSON.stringify(card.snapshot.taskRows),
          JSON.stringify(card.snapshot.evidenceSourceIds),
          card.snapshot.generatedByAgentId,
          card.snapshot.generatedByRunId,
          JSON.stringify(card.snapshot.deterministicStateInputs),
        ],
      );

      return {
        ...card,
        id: persistedCardId,
        pinned: existingRows[0]?.pinned ?? card.pinned,
        hidden: existingRows[0]?.hidden ?? card.hidden,
        latestSnapshotId: card.snapshot.id,
        snapshot: { ...card.snapshot, cardId: persistedCardId },
        sources: card.sources.map((source) => ({ ...source, cardId: persistedCardId })),
      };
    },

    async setPinned(input: { companyId: string; userId: string; cardId: string; pinned: boolean }): Promise<void> {
      await db.execute(
        `UPDATE ${cardsTable}
         SET pinned = $1, expires_at = CASE WHEN $1 THEN NULL ELSE expires_at END, updated_at = now()
         WHERE company_id = $2 AND user_id = $3 AND id = $4`,
        [input.pinned, input.companyId, input.userId, input.cardId],
      );
    },

    async dismissCard(input: { companyId: string; userId: string; cardId: string }): Promise<void> {
      await db.execute(
        `UPDATE ${cardsTable}
         SET hidden = true, pinned = false, updated_at = now()
         WHERE company_id = $1 AND user_id = $2 AND id = $3`,
        [input.companyId, input.userId, input.cardId],
      );
    },

    async loadPreferences(input: { companyId: string; userId: string }): Promise<BriefPreferences> {
      const rows = await db.query<{
        cadence: BriefPreferences["cadence"];
        retention_days: number;
        done_retention_hours: number;
        stale_after_days: number;
        max_unpinned_cards: number;
        scope: BriefPreferences["scope"];
      }>(
        `SELECT cadence, retention_days, done_retention_hours, stale_after_days, max_unpinned_cards, scope
         FROM ${preferencesTable}
         WHERE company_id = $1 AND user_id = $2
         LIMIT 1`,
        [input.companyId, input.userId],
      );
      const row = rows[0];
      if (!row) {
        return {
          companyId: input.companyId,
          userId: input.userId,
          cadence: "hourly",
          retentionDays: 7,
          doneRetentionHours: 72,
          staleAfterDays: 7,
          maxUnpinnedCards: 30,
          scope: "user",
        };
      }
      return {
        companyId: input.companyId,
        userId: input.userId,
        cadence: row.cadence,
        retentionDays: row.retention_days,
        doneRetentionHours: row.done_retention_hours,
        staleAfterDays: row.stale_after_days,
        maxUnpinnedCards: row.max_unpinned_cards,
        scope: row.scope,
      };
    },

    async upsertPreferences(preferences: BriefPreferences): Promise<void> {
      await db.execute(
        `INSERT INTO ${preferencesTable} (
           id, company_id, user_id, cadence, retention_days, done_retention_hours, stale_after_days,
           max_unpinned_cards, scope
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (company_id, user_id) DO UPDATE SET
           cadence = EXCLUDED.cadence,
           retention_days = EXCLUDED.retention_days,
           done_retention_hours = EXCLUDED.done_retention_hours,
           stale_after_days = EXCLUDED.stale_after_days,
           max_unpinned_cards = EXCLUDED.max_unpinned_cards,
           scope = EXCLUDED.scope,
           updated_at = now()`,
        [
          randomUUID(),
          preferences.companyId,
          preferences.userId,
          preferences.cadence,
          preferences.retentionDays,
          preferences.doneRetentionHours,
          preferences.staleAfterDays,
          preferences.maxUnpinnedCards,
          preferences.scope,
        ],
      );
    },
  };
}
