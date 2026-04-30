import { and, desc, eq, ne } from "drizzle-orm";
import { routineCheckRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { mostRecentPastSlot, parseCron } from "../cron.js";
import { buildSummary, computeContentHash, postWebhook, shouldNotify, type WebhookPayload } from "./notify.js";
import type { Registry } from "./registry.js";
import type { CheckCtx, CheckDef, CheckLogger, CheckResult, CheckStatus, NotifyChannel } from "./types.js";

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

export async function insertOrSkipRun(args: {
  db: Db;
  checkName: string;
  scheduledFor: Date;
  notifyChannel: NotifyChannel;
}): Promise<string | null> {
  const rows = await args.db
    .insert(routineCheckRuns)
    .values({
      checkName: args.checkName,
      scheduledFor: args.scheduledFor,
      runAt: new Date(),
      status: "ok",
      findings: 0,
      notifyChannel: args.notifyChannel,
      payloadJson: { _state: "running" },
    })
    .onConflictDoNothing({ target: [routineCheckRuns.checkName, routineCheckRuns.scheduledFor] })
    .returning({ id: routineCheckRuns.id });
  return rows[0]?.id ?? null;
}

const CATCHUP_GRACE_MS = 90_000;

export interface WebhookCfg {
  url: string;
  token: string;
  fetcher?: typeof fetch;
}

export interface RunOneArgs {
  db: Db;
  def: CheckDef;
  scheduledFor: Date;
  logger: CheckLogger;
  now: () => Date;
  webhook: WebhookCfg | undefined;
}

export interface RunOneResult {
  skipped: boolean;
  notified: boolean;
  status: CheckStatus | null;
}

export async function runOne(args: RunOneArgs): Promise<RunOneResult> {
  const id = await insertOrSkipRun({
    db: args.db,
    checkName: args.def.name,
    scheduledFor: args.scheduledFor,
    notifyChannel: args.def.notify,
  });
  if (id === null) {
    return { skipped: true, notified: false, status: null };
  }

  const start = args.now().getTime();
  let result: CheckResult;
  let errorText: string | null = null;

  const ctx: CheckCtx = {
    db: args.db,
    fs: await import("node:fs/promises"),
    now: args.now,
    logger: args.logger,
  };

  try {
    result = await args.def.run(ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errorText = msg;
    result = { status: "error", findings: 0, payload: { error: msg }, summary: `error: ${msg}` };
  }

  const previousStatus = await computePreviousStatus({ db: args.db, checkName: args.def.name, currentId: id });
  const willNotify = shouldNotify({
    channel: args.def.notify,
    thresholdSeverity: args.def.thresholdSeverity,
    currentStatus: result.status,
    previousStatus,
    findings: result.findings,
  });

  let notified = false;
  if (willNotify && args.webhook) {
    const isCatchUp = args.now().getTime() - args.scheduledFor.getTime() > CATCHUP_GRACE_MS;
    const baseSummary = isCatchUp ? `${result.summary} (catch-up)` : result.summary;
    const summary = buildSummary({ original: baseSummary, previousStatus, currentStatus: result.status });
    const examples = Array.isArray((result.payload as { examples?: unknown }).examples)
      ? ((result.payload as { examples: unknown[] }).examples.map((x) => String(x)))
      : [];
    const hash = computeContentHash({ summary, findings: result.findings, examples });
    const payload: WebhookPayload = {
      check: args.def.name,
      status: result.status,
      previous_status: previousStatus,
      findings: result.findings,
      summary,
      content_hash: hash,
      scheduled_for: args.scheduledFor.toISOString(),
      details_hint: `paperclip checks history ${args.def.name} --limit 1`,
    };
    notified = await postWebhook({
      url: args.webhook.url,
      token: args.webhook.token,
      fetcher: args.webhook.fetcher,
      payload,
      logger: args.logger,
    });
  }

  await args.db
    .update(routineCheckRuns)
    .set({
      status: result.status,
      findings: result.findings,
      payloadJson: result.payload,
      durationMs: args.now().getTime() - start,
      errorText,
      notified,
    })
    .where(eq(routineCheckRuns.id, id));

  return { skipped: false, notified, status: result.status };
}

export interface OrchestrationArgs {
  db: Db;
  registry: Registry;
  now: () => Date;
  logger: CheckLogger;
  webhook: WebhookCfg | undefined;
}

export async function catchUpAll(args: OrchestrationArgs): Promise<void> {
  for (const def of args.registry.list()) {
    const cron = parseCron(def.schedule);
    const lastSlot = mostRecentPastSlot(cron, args.now());
    if (!lastSlot) continue;

    const rows = await args.db
      .select({ scheduled: routineCheckRuns.scheduledFor })
      .from(routineCheckRuns)
      .where(eq(routineCheckRuns.checkName, def.name))
      .orderBy(desc(routineCheckRuns.scheduledFor))
      .limit(1);
    const lastRecorded = rows[0]?.scheduled?.getTime() ?? 0;

    if (lastSlot.getTime() > lastRecorded) {
      args.logger.info({ check: def.name, slot: lastSlot.toISOString() }, "catch-up running missed slot");
      await runOne({ db: args.db, def, scheduledFor: lastSlot, logger: args.logger, now: args.now, webhook: args.webhook });
    }
  }
}

const TICK_GRACE_MS = 60_000;

export async function tickAll(args: OrchestrationArgs): Promise<void> {
  for (const def of args.registry.list()) {
    const cron = parseCron(def.schedule);
    const slot = mostRecentPastSlot(cron, args.now());
    if (!slot) continue;
    const ageMs = args.now().getTime() - slot.getTime();
    if (ageMs > TICK_GRACE_MS) continue;
    await runOne({ db: args.db, def, scheduledFor: slot, logger: args.logger, now: args.now, webhook: args.webhook });
  }
}
