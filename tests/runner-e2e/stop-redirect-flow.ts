import type { Page } from "@playwright/test";
type Row = Record<string, any>;

/** Work emitted by a retired turn, excluding accounting and control-plane bookkeeping. */
export function nativeWorkEvents<T extends Row>(events: T[]): T[] {
  return events.filter(row => {
    const kind = row.payload?.prpEvent?.eventType;
    return typeof kind === "string" && /^(tool\.execution\.|turn\.|message\.|item\.)/.test(kind);
  });
}

/** Detect post-cancellation output even if it arrived before the first snapshot. */
export function nativeCancellationHasNoLaterWork(events: Row[]): boolean {
  const work = nativeWorkEvents(events);
  const cancellation = work.findIndex(row => row.payload.prpEvent.eventType === "turn.cancelled");
  return cancellation >= 0 && cancellation === work.length - 1;
}

/** A claimed run is not proof that a cancellable native turn has started. */
export function activeNativeTurnStarted(run: Row | undefined, events: Row[]): boolean {
  const latestTurn = events.map(row => row.payload?.prpEvent?.eventType)
    .filter(kind => ["turn.started", "turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(kind)).at(-1);
  return run?.runtimeMode === "native" && run.status === "running" && latestTurn === "turn.started";
}

/** Shared story order; target adapters supply authoritative retirement observations. */
export async function stopAndRedirectThroughUi(input: {
  page: Page; nonce: string;
  awaitRetirement(): Promise<void>;
  beforeRedirect(): Promise<void>;
  reply(message: string): Promise<unknown>;
}) {
  await input.page.getByTestId("task-chat-composer-stop").last().click();
  await input.awaitRetirement();
  await input.beforeRedirect();
  const marker = `The studio is ready. Reference ${input.nonce}.`;
  const reply = await input.reply(`Change direction. Leave the project as it is. Reply with just this short note: "${marker}"`);
  await input.page.reload();
  return { marker, reply };
}

/** The native control plane must acknowledge this run's Stop, including resource release. */
export function nativeStopAcknowledged(run: Row, companyId: string, issueId: string, userId: string) {
  const stop = run.resultJson?.nativeCancellation;
  const result = run.resultJson ?? {};
  const startup = result.startupCancellation;
  const cancellation = result.cancellation;
  return run.runtimeMode === "native" && run.status === "cancelled" && run.companyId === companyId && (run.nativeIssueId ?? run.issueId) === issueId
    && stop?.schema === "paperclip.native-cancellation.v1" && stop.companyId === companyId
    && stop.runId === run.id && stop.issueId === issueId && stop.scope === "run" && stop.dispatched === true
    && stop.dispatchState === "acknowledged" && stop.reasonCode === "cancellation_run_only"
    && stop.effects?.length === 1 && stop.effects[0] === "release_run_resources"
    && typeof stop.intentAuditId === "string" && typeof stop.acknowledgementAuditId === "string"
    && stop.intentAuditId !== stop.acknowledgementAuditId
    && /^native-cancellation:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(stop.intentId ?? "")
    && result.cancelledByActorType === "user" && result.cancelledByUserId === userId
    && cancellation?.source === "operator" && cancellation.expected === true
    && cancellation.initiator?.type === "user" && cancellation.initiator.id === userId
    && typeof startup?.requestedAt === "string" && Number.isFinite(Date.parse(startup.requestedAt))
    && startup.beforeNativeSelection === false;
}
