import type { LiveEvent } from "@paperclipai/shared";
import { publishLiveEvent } from "./live-events.js";
import { isSafeNativeChatProgressEventType } from "./safe-native-chat-progress.js";

const CHAT_PUBLICATION_PRESENTATION_COMMIT_EVENT = "run.presentation.resolved";

function isChatPublicationCommitEventType(eventType: string): boolean {
  return eventType === CHAT_PUBLICATION_PRESENTATION_COMMIT_EVENT ||
    isSafeNativeChatProgressEventType(eventType);
}

/**
 * Only events emitted after durable run evidence is visible may wake the
 * publication reconciler. Earlier lifecycle/status events can precede the
 * transaction that creates the corresponding chat publication, so polling
 * remains their recovery path.
 */
export function isChatPublicationCommitSignal(
  event: Pick<LiveEvent, "type" | "payload">,
): boolean {
  if (event.type !== "heartbeat.run.event") return false;
  const eventType = event.payload.eventType;
  if (typeof eventType !== "string") return false;
  return isChatPublicationCommitEventType(eventType);
}

/**
 * Emit a company-scoped publication wake only after its durable source row is
 * visible. The narrow primitive input prevents a PRP payload, message, tool
 * name, target, result, or error from crossing into the public live stream.
 */
export function publishChatPublicationCommitSignal(input: {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  eventType: string;
  seq?: number;
}): boolean {
  if (!isChatPublicationCommitEventType(input.eventType)) return false;
  try {
    publishLiveEvent({
      companyId: input.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: input.runId,
        agentId: input.agentId,
        issueId: input.issueId,
        ...(input.seq === undefined ? {} : { seq: input.seq }),
        eventType: input.eventType,
      },
    });
    return true;
  } catch {
    // This notification is an optional latency optimization. A subscriber
    // failure must not reject an already-committed event/comment or skip its
    // durable side effects; the periodic reconciliation poll remains recovery.
    return false;
  }
}

/**
 * A bounded, single-flight wakeup for a level-triggered durable worker.
 * Same-turn notifications coalesce before work starts. One notification that
 * arrives after work starts records a dirty bit and schedules exactly one
 * follow-up pass, so a commit cannot be stranded behind an in-flight scan.
 * Periodic recovery polls never set that dirty bit.
 */
export function createCoalescedAsyncTrigger(input: {
  run: () => Promise<unknown>;
  onError: (error: unknown) => void;
  minimumSpacingMs?: number;
}) {
  const minimumSpacingMs = Math.max(0, input.minimumSpacingMs ?? 100);
  let stopped = false;
  let dirty = false;
  let lastStartedAt: number | null = null;
  let scheduled: Promise<void> | null = null;
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveScheduled: (() => void) | null = null;
  let running: Promise<void> | null = null;

  const reportError = (error: unknown) => {
    try {
      input.onError(error);
    } catch {
      // The worker error is already contained. A diagnostic callback must not
      // create an unhandled rejection or prevent the durable recovery poll.
    }
  };

  const start = () => {
    if (stopped || running) return;
    lastStartedAt = Date.now();
    const current = Promise.resolve()
      .then(async () => {
        await input.run();
      })
      .catch(reportError)
      .finally(() => {
        if (running !== current) return;
        running = null;
        const shouldRunAgain = dirty && !stopped;
        dirty = false;
        if (shouldRunAgain) schedule();
      });
    running = current;
  };

  const schedule = () => {
    if (stopped || scheduled || running) return;
    const delay =
      lastStartedAt === null
        ? 0
        : Math.max(0, lastStartedAt + minimumSpacingMs - Date.now());
    if (delay === 0) {
      const current = Promise.resolve().then(() => {
        if (scheduled !== current) return;
        scheduled = null;
        if (!stopped) start();
      });
      scheduled = current;
      return;
    }
    const current = new Promise<void>((resolve) => {
      resolveScheduled = resolve;
      scheduledTimer = setTimeout(() => {
        if (scheduled !== current) return;
        scheduled = null;
        scheduledTimer = null;
        resolveScheduled = null;
        resolve();
        if (!stopped) start();
      }, delay);
      scheduledTimer.unref?.();
    });
    scheduled = current;
  };

  return {
    /** An event-backed wake records one bounded follow-up while work runs. */
    notify() {
      if (stopped) return;
      if (running) {
        dirty = true;
        return;
      }
      if (scheduled) return;
      schedule();
    },

    /** A recovery poll starts an idle worker but never creates extra work. */
    poll() {
      if (stopped || running || scheduled) return;
      schedule();
    },

    stop() {
      stopped = true;
      dirty = false;
      if (scheduledTimer) clearTimeout(scheduledTimer);
      scheduledTimer = null;
      scheduled = null;
      resolveScheduled?.();
      resolveScheduled = null;
    },

    async drain() {
      // A dirty follow-up is assigned from the prior promise's finally block.
      // Loop so callers that have not stopped the trigger also join that pass.
      while (scheduled || running) {
        await Promise.allSettled(
          [scheduled, running].filter(
            (promise): promise is Promise<void> => promise !== null,
          ),
        );
      }
    },
  };
}
