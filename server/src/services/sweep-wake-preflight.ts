import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issueComments, issueRelations, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { ServerGbrainCallError, type ServerGbrainClient } from "./gbrain-client-factory.js";

export type SweepWakePreflightVerdict =
  | "skip"
  | "missing_or_invalid_frame"
  | "identity_mismatch"
  | "new_activity"
  | "new_comment"
  | "status_changed"
  | "blocked_by_changed"
  | "blocker_resolved"
  | "raced_after_decision"
  | "soft_ttl_refresh"
  | "gbrain_error"
  | "feature_disabled";

export interface SweepWakeFrame {
  schemaVersion: 1;
  companyId: string;
  agentId: string;
  agentName: string;
  issueIdentifier: string;
  issueId: string;
  issueLastActivityAt: string;
  updatedAt: string;
  status: string;
  blockedByIssueIds: string[];
  disposition: string;
  nextRefreshTriggers: string[];
  consecutiveSkips: number;
  body: string;
}

export interface SweepWakeIssueSnapshot {
  id: string;
  companyId: string;
  identifier: string | null;
  status: string;
  lastActivityAt: Date;
  blockedByIssueIds: string[];
  /**
   * The most recent `completedAt` across this issue's blockers, or `null` when there are
   * no blockers (or no blocker has completedAt set). Used to detect the
   * `issue_blockers_resolved_sweep` case where the dependent's own activity has not
   * changed, but blockers have transitioned to `done` since the frame was written.
   */
  blockersResolvedSince: Date | null;
}

export interface SweepWakeCommentSnapshot {
  body: string;
  createdAt: Date;
}

export interface SweepWakeFrameIdentity {
  companyId: string;
  agentId: string;
  issueId: string;
  issueIdentifier: string;
}

export type SweepWakeFrameDecision =
  | { skip: true; verdict: "skip"; frame: SweepWakeFrame }
  | { skip: false; verdict: Exclude<SweepWakePreflightVerdict, "skip">; frame?: SweepWakeFrame };

const REQUIRED_FRAME_KEYS = new Set([
  "schemaVersion",
  "companyId",
  "agentId",
  "agentName",
  "issueIdentifier",
  "issueId",
  "issueLastActivityAt",
  "updatedAt",
  "status",
  "blockedByIssueIds",
  "disposition",
  "nextRefreshTriggers",
]);

export const SERVER_PREFLIGHT_MARKER_PREFIX = "[gstack-preflight]";
const SERVER_PREFLIGHT_SOURCE = "server-side-preflight";
const SOFT_TTL_SKIP_COUNT = 24;

function sortLex(values: string[]) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function equalStringArrays(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function parseScalar(value: string): string | number {
  const trimmed = value.trim();
  if (trimmed === "[]") return "[]";
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSweepWakeFramePage(input: unknown): SweepWakeFrame | null {
  const page = typeof input === "string"
    ? input
    : typeof input === "object" && input !== null && typeof (input as { content?: unknown }).content === "string"
      ? (input as { content: string }).content
      : typeof input === "object" && input !== null && typeof (input as { body?: unknown }).body === "string"
        ? (input as { body: string }).body
        : null;
  if (!page?.startsWith("---\n")) return null;
  const end = page.indexOf("\n---", 4);
  if (end === -1) return null;
  const frontmatter = page.slice(4, end).split(/\r?\n/);
  const body = page.slice(end + "\n---".length).replace(/^\r?\n/, "");
  const parsed: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  for (const rawLine of frontmatter) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const arrayItem = line.match(/^\s+-\s*(.*)$/);
    if (arrayItem && currentArrayKey) {
      (parsed[currentArrayKey] as string[]).push(String(parseScalar(arrayItem[1] ?? "")));
      continue;
    }
    currentArrayKey = null;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) return null;
    const [, key, value = ""] = match;
    if (!key || !REQUIRED_FRAME_KEYS.has(key) && key !== "consecutiveSkips") continue;
    if (value === "") {
      parsed[key] = [];
      currentArrayKey = key;
    } else if (value.trim() === "[]") {
      parsed[key] = [];
    } else {
      parsed[key] = parseScalar(value);
    }
  }

  const frame = {
    schemaVersion: parsed.schemaVersion,
    companyId: parsed.companyId,
    agentId: parsed.agentId,
    agentName: parsed.agentName,
    issueIdentifier: parsed.issueIdentifier,
    issueId: parsed.issueId,
    issueLastActivityAt: parsed.issueLastActivityAt,
    updatedAt: parsed.updatedAt,
    status: parsed.status,
    blockedByIssueIds: parsed.blockedByIssueIds,
    disposition: parsed.disposition,
    nextRefreshTriggers: parsed.nextRefreshTriggers,
    consecutiveSkips: parsed.consecutiveSkips ?? 0,
    body,
  };
  if (!isValidSweepWakeFrame(frame)) return null;
  return frame;
}

function isValidIsoDate(value: string) {
  return Number.isFinite(Date.parse(value));
}

function isValidSweepWakeFrame(value: unknown): value is SweepWakeFrame {
  const frame = value as SweepWakeFrame;
  return frame?.schemaVersion === 1 &&
    typeof frame.companyId === "string" &&
    typeof frame.agentId === "string" &&
    typeof frame.agentName === "string" &&
    typeof frame.issueIdentifier === "string" &&
    typeof frame.issueId === "string" &&
    typeof frame.status === "string" &&
    typeof frame.disposition === "string" &&
    typeof frame.body === "string" &&
    isValidIsoDate(frame.issueLastActivityAt) &&
    isValidIsoDate(frame.updatedAt) &&
    Array.isArray(frame.blockedByIssueIds) &&
    frame.blockedByIssueIds.every((id) => typeof id === "string") &&
    Array.isArray(frame.nextRefreshTriggers) &&
    frame.nextRefreshTriggers.every((trigger) => typeof trigger === "string") &&
    Number.isInteger(frame.consecutiveSkips) &&
    frame.consecutiveSkips >= 0;
}

export function compareSweepWakeFrame(input: {
  frame: unknown;
  issue: SweepWakeIssueSnapshot;
  recentComments: SweepWakeCommentSnapshot[];
  expectedIdentity: SweepWakeFrameIdentity;
}): SweepWakeFrameDecision {
  const frame = isValidSweepWakeFrame(input.frame) ? input.frame : null;
  if (!frame) return { skip: false, verdict: "missing_or_invalid_frame" };
  // Fail-open if the gbrain page identity does not match the DB context for the
  // company/agent/issue we are about to wake. A stale or cross-wired frame must not be
  // allowed to suppress a wake for a different identity tuple.
  const ident = input.expectedIdentity;
  if (
    frame.companyId !== ident.companyId ||
    frame.agentId !== ident.agentId ||
    frame.issueId !== ident.issueId ||
    frame.issueIdentifier !== ident.issueIdentifier
  ) {
    return { skip: false, verdict: "identity_mismatch", frame };
  }
  if (input.issue.lastActivityAt > new Date(frame.issueLastActivityAt)) {
    return { skip: false, verdict: "new_activity", frame };
  }
  const frameUpdatedAt = new Date(frame.updatedAt);
  // Blocker transitions to `done` do not bump the dependent's own lastActivityAt; check
  // the max completedAt across blockers explicitly so `issue_blockers_resolved_sweep`
  // wakes are not silently suppressed.
  if (input.issue.blockersResolvedSince && input.issue.blockersResolvedSince > frameUpdatedAt) {
    return { skip: false, verdict: "blocker_resolved", frame };
  }
  const hasNewNonMarkerComment = input.recentComments.some(
    (comment) => comment.createdAt > frameUpdatedAt && !comment.body.startsWith(SERVER_PREFLIGHT_MARKER_PREFIX),
  );
  if (hasNewNonMarkerComment) return { skip: false, verdict: "new_comment", frame };
  if (input.issue.status !== frame.status) return { skip: false, verdict: "status_changed", frame };
  if (!equalStringArrays(sortLex(input.issue.blockedByIssueIds), sortLex(frame.blockedByIssueIds))) {
    return { skip: false, verdict: "blocked_by_changed", frame };
  }
  return { skip: true, verdict: "skip", frame };
}

function quoteYamlScalar(value: string | number) {
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function renderYamlArray(key: string, values: string[]) {
  if (values.length === 0) return `${key}: []`;
  return [`${key}:`, ...values.map((value) => `  - ${quoteYamlScalar(value)}`)].join("\n");
}

export function composeSweepWakeFramePage(frame: SweepWakeFrame): string {
  return `---\n${[
    `schemaVersion: ${frame.schemaVersion}`,
    `companyId: ${quoteYamlScalar(frame.companyId)}`,
    `agentId: ${quoteYamlScalar(frame.agentId)}`,
    `agentName: ${quoteYamlScalar(frame.agentName)}`,
    `issueIdentifier: ${quoteYamlScalar(frame.issueIdentifier)}`,
    `issueId: ${quoteYamlScalar(frame.issueId)}`,
    `issueLastActivityAt: ${quoteYamlScalar(frame.issueLastActivityAt)}`,
    `updatedAt: ${quoteYamlScalar(frame.updatedAt)}`,
    `status: ${quoteYamlScalar(frame.status)}`,
    renderYamlArray("blockedByIssueIds", frame.blockedByIssueIds),
    `disposition: ${quoteYamlScalar(frame.disposition)}`,
    renderYamlArray("nextRefreshTriggers", frame.nextRefreshTriggers),
    `consecutiveSkips: ${frame.consecutiveSkips}`,
  ].join("\n")}\n---\n${frame.body}`;
}

export function shouldForceSoftTtlRefresh(frame: SweepWakeFrame) {
  return frame.consecutiveSkips + 1 >= SOFT_TTL_SKIP_COUNT;
}

export function sweepWakeFrameSlug(input: { companyId: string; agentId: string; issueIdentifier: string }) {
  return `paperclip/decisions/${input.companyId}/${input.agentId}/${input.issueIdentifier}`;
}

async function listIssueBlockerIds(db: Db, issueId: string) {
  const rows = await db
    .select({ blockerIssueId: issueRelations.issueId })
    .from(issueRelations)
    .where(and(eq(issueRelations.type, "blocks"), eq(issueRelations.relatedIssueId, issueId)));
  return rows.map((row) => row.blockerIssueId);
}

async function maxBlockerCompletedAt(
  db: Db,
  blockerIssueIds: string[],
  companyId: string,
): Promise<Date | null> {
  if (blockerIssueIds.length === 0) return null;
  const row = await db
    .select({ maxCompletedAt: sql<Date | null>`max(${issues.completedAt})` })
    .from(issues)
    .where(and(inArray(issues.id, blockerIssueIds), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row?.maxCompletedAt ?? null;
}

async function getIssueSnapshot(db: Db, issueId: string, companyId: string): Promise<SweepWakeIssueSnapshot | null> {
  const issue = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
      lastActivityAt: issues.lastActivityAt,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) return null;
  const blockedByIssueIds = await listIssueBlockerIds(db, issue.id);
  const blockersResolvedSince = await maxBlockerCompletedAt(db, blockedByIssueIds, companyId);
  return { ...issue, blockedByIssueIds, blockersResolvedSince };
}

async function listRecentComments(db: Db, issueId: string, companyId: string) {
  return db
    .select({ body: issueComments.body, createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(and(eq(issueComments.issueId, issueId), eq(issueComments.companyId, companyId)))
    .orderBy(desc(issueComments.createdAt))
    .limit(5);
}

async function isCompanyFlagEnabled(db: Db, companyId: string) {
  if (process.env.PAPERCLIP_DISABLE_SERVER_PREFLIGHT === "1") return false;
  const company = await db
    .select({ featureFlags: companies.featureFlags })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return Boolean(company?.featureFlags?.serverSideSweepPreflight);
}

function currentMinuteBucket(now = new Date()) {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
}

export type SweepWakeRaceReason =
  | "issue_vanished"
  | "activity_advanced"
  | "status_changed"
  | "new_non_marker_comment";

export type PreflightMarkerResult =
  | { kind: "posted"; createdAt: Date }
  | { kind: "raced"; reason: SweepWakeRaceReason };

/**
 * Re-reads issue/comment state under the advisory lock and flags a race when anything
 * material moved between the caller's snapshot (passed in as `input.previousIssue`)
 * and the lock acquisition. Returning `raced: true` causes the caller to fall open and
 * skip both the marker insert and the gbrain frame rewrite.
 *
 * Without this re-check, a non-marker activity (comment, status change, lastActivityAt
 * bump) that lands between `runSweepWakePreflight`'s read and the lock acquisition can
 * be silently overwritten by the frame rewrite, suppressing the next sweep.
 */
export interface RaceCheckInputs {
  previousIssue: { lastActivityAt: Date; status: string };
  currentIssue: { lastActivityAt: Date; status: string } | null;
  frameIssueLastActivityAt: Date;
  hasNewNonMarkerCommentSinceFrame: boolean;
}

export function detectSweepWakeRace(
  input: RaceCheckInputs,
): { raced: true; reason: SweepWakeRaceReason } | { raced: false } {
  if (!input.currentIssue) return { raced: true, reason: "issue_vanished" };
  if (input.currentIssue.lastActivityAt > input.frameIssueLastActivityAt) {
    return { raced: true, reason: "activity_advanced" };
  }
  if (input.currentIssue.lastActivityAt > input.previousIssue.lastActivityAt) {
    return { raced: true, reason: "activity_advanced" };
  }
  if (input.currentIssue.status !== input.previousIssue.status) {
    return { raced: true, reason: "status_changed" };
  }
  if (input.hasNewNonMarkerCommentSinceFrame) return { raced: true, reason: "new_non_marker_comment" };
  return { raced: false };
}

async function postPreflightMarker(db: Db, input: {
  issue: SweepWakeIssueSnapshot;
  frame: SweepWakeFrame;
  now?: Date;
}): Promise<PreflightMarkerResult> {
  const bucket = currentMinuteBucket(input.now);
  return db.transaction(async (tx): Promise<PreflightMarkerResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.issue.id}))`);

    // Re-read under the lock so that any activity, status change, or non-marker comment
    // that landed between the initial snapshot and the lock acquisition forces a
    // fail-open. Otherwise we would silently overwrite that signal when we rewrite the
    // gbrain frame.
    const currentIssue = await tx
      .select({ lastActivityAt: issues.lastActivityAt, status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, input.issue.id), eq(issues.companyId, input.issue.companyId)))
      .then((rows) => rows[0] ?? null);

    const frameUpdatedAtDate = new Date(input.frame.updatedAt);
    const racedRows = await tx
      .select({ body: issueComments.body, createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, input.issue.id),
        eq(issueComments.companyId, input.issue.companyId),
        gt(issueComments.createdAt, frameUpdatedAtDate),
      ))
      .limit(50);
    const hasNewNonMarkerCommentSinceFrame = racedRows.some(
      (row) => !row.body.startsWith(SERVER_PREFLIGHT_MARKER_PREFIX),
    );

    const race = detectSweepWakeRace({
      previousIssue: { lastActivityAt: input.issue.lastActivityAt, status: input.issue.status },
      currentIssue,
      frameIssueLastActivityAt: new Date(input.frame.issueLastActivityAt),
      hasNewNonMarkerCommentSinceFrame,
    });
    if (race.raced) return { kind: "raced", reason: race.reason };

    const metadata = {
      kind: "gstack-preflight",
      source: SERVER_PREFLIGHT_SOURCE,
      frameUpdatedAt: input.frame.updatedAt,
      minuteBucket: bucket,
    };
    const existing = await tx
      .select({ createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, input.issue.id),
        sql`${issueComments.metadata}->>'kind' = 'gstack-preflight'`,
        sql`${issueComments.metadata}->>'source' = ${SERVER_PREFLIGHT_SOURCE}`,
        sql`${issueComments.metadata}->>'frameUpdatedAt' = ${input.frame.updatedAt}`,
        sql`${issueComments.metadata}->>'minuteBucket' = ${bucket}`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return { kind: "posted", createdAt: existing.createdAt };

    const inserted = await tx
      .insert(issueComments)
      .values({
        companyId: input.issue.companyId,
        issueId: input.issue.id,
        authorType: "system",
        body: `${SERVER_PREFLIGHT_MARKER_PREFIX} frame stable since ${input.frame.updatedAt}; sweep wake skipped server-side.`,
        metadata: metadata as never,
      })
      .returning({ createdAt: issueComments.createdAt })
      .then((rows) => rows[0]);
    return { kind: "posted", createdAt: inserted.createdAt };
  });
}

export async function runSweepWakePreflight(input: {
  db: Db;
  gbrain: ServerGbrainClient;
  agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "name">;
  issueId: string;
  log?: Pick<typeof logger, "info" | "warn">;
}) {
  const log = input.log ?? logger;
  if (!await isCompanyFlagEnabled(input.db, input.agent.companyId)) {
    return { skip: false as const, verdict: "feature_disabled" as const };
  }
  const issue = await getIssueSnapshot(input.db, input.issueId, input.agent.companyId);
  if (!issue?.identifier) return { skip: false as const, verdict: "missing_or_invalid_frame" as const };
  const slug = sweepWakeFrameSlug({
    companyId: input.agent.companyId,
    agentId: input.agent.id,
    issueIdentifier: issue.identifier,
  });
  const expectedIdentity: SweepWakeFrameIdentity = {
    companyId: input.agent.companyId,
    agentId: input.agent.id,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
  };
  try {
    // BLO-6979: get_page now throws `ServerGbrainCallError` with
    // `errorCode === "page_not_found"` for genuinely missing frames (was
    // a silent null pre-fix). Translate that single expected absence
    // back into a null page so the downstream `parseSweepWakeFramePage(null)`
    // path keeps producing `missing_or_invalid_frame` + seed. Every other
    // error code (invalid_params, permission_denied, internal_error,
    // transport-layer aborts/HTTP errors) bubbles to the outer catch and
    // becomes `gbrain_error`, which is now observable instead of masked.
    const [page, comments] = await Promise.all([
      input.gbrain.call("get_page", { slug }).catch((err: unknown) => {
        if (err instanceof ServerGbrainCallError && err.errorCode === "page_not_found") return null;
        throw err;
      }),
      listRecentComments(input.db, issue.id, issue.companyId),
    ]);
    const frame = parseSweepWakeFramePage(page);
    const decision = compareSweepWakeFrame({ frame, issue, recentComments: comments, expectedIdentity });
    if (!decision.skip) {
      // BLO-6660: when the gate encounters an issue with no usable frame (no
      // existing page, schema mismatch, or identity mismatch) we seed an
      // initial frame from the server-observed issue state. The first
      // encounter still wakes the agent — we have no historical signal to
      // skip on — but the seed gives the NEXT sweep a comparison baseline.
      // Without this, the gate forever falls through on issues whose agents
      // don't honor the Path 1/2 LLM-side WAKE-PREFLIGHT.md protocol (the
      // entire BLO-6151 silence class), leaving Path 3 unable to produce
      // `skip` verdicts and zero cost reduction on the BLO-6388 rollout.
      if (decision.verdict === "missing_or_invalid_frame") {
        const seedFrame: SweepWakeFrame = {
          schemaVersion: 1,
          companyId: input.agent.companyId,
          agentId: input.agent.id,
          agentName: input.agent.name,
          issueIdentifier: issue.identifier,
          issueId: issue.id,
          issueLastActivityAt: issue.lastActivityAt.toISOString(),
          updatedAt: new Date().toISOString(),
          status: issue.status,
          blockedByIssueIds: [...new Set(issue.blockedByIssueIds ?? [])].sort(),
          disposition: "Auto-seeded by server-side gate; agent has not yet written a Path 1/2 frame.",
          nextRefreshTriggers: [],
          consecutiveSkips: 0,
          body: "",
        };
        try {
          await input.gbrain.call("put_page", { slug, content: composeSweepWakeFramePage(seedFrame) });
          log.info(
            { verdict: decision.verdict, seedWritten: true, issueId: issue.id, agentId: input.agent.id },
            "sweep_wake_preflight.decision",
          );
        } catch (seedErr) {
          // Seed-write failure shouldn't change the wake decision; log and
          // proceed. The next sweep will retry seeding on its own.
          log.warn(
            { err: seedErr, verdict: decision.verdict, seedWritten: false, issueId: issue.id, agentId: input.agent.id },
            "sweep_wake_preflight.decision",
          );
        }
        return decision;
      }
      log.info({ verdict: decision.verdict, issueId: issue.id, agentId: input.agent.id }, "sweep_wake_preflight.decision");
      return decision;
    }
    if (shouldForceSoftTtlRefresh(decision.frame)) {
      log.info({ verdict: "soft_ttl_refresh", issueId: issue.id, agentId: input.agent.id }, "sweep_wake_preflight.decision");
      await input.gbrain.call("put_page", {
        slug,
        content: composeSweepWakeFramePage({ ...decision.frame, consecutiveSkips: 0 }),
      });
      return { skip: false as const, verdict: "soft_ttl_refresh" as const, frame: decision.frame };
    }
    const markerResult = await postPreflightMarker(input.db, { issue, frame: decision.frame });
    if (markerResult.kind === "raced") {
      // State moved under the lock — fall open without writing a marker or rewriting
      // the frame. Next sweep will see the new activity and follow the normal path.
      log.info(
        { verdict: "raced_after_decision", reason: markerResult.reason, issueId: issue.id, agentId: input.agent.id },
        "sweep_wake_preflight.decision",
      );
      return { skip: false as const, verdict: "raced_after_decision" as const, frame: decision.frame };
    }
    const updatedFrame: SweepWakeFrame = {
      ...decision.frame,
      issueLastActivityAt: markerResult.createdAt.toISOString(),
      updatedAt: new Date().toISOString(),
      consecutiveSkips: decision.frame.consecutiveSkips + 1,
    };
    await input.gbrain.call("put_page", { slug, content: composeSweepWakeFramePage(updatedFrame) });
    log.info({ verdict: "skip", issueId: issue.id, agentId: input.agent.id }, "sweep_wake_preflight.decision");
    return { skip: true as const, verdict: "skip" as const, frame: updatedFrame };
  } catch (err) {
    log.warn({ err, issueId: issue.id, agentId: input.agent.id, verdict: "gbrain_error" }, "sweep_wake_preflight.decision");
    return { skip: false as const, verdict: "gbrain_error" as const };
  }
}
