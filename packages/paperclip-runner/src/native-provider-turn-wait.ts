import { HarnessStaleTurnError } from "./contracts/harness-driver.js";
import type { NativeSession } from "./contracts/native-session-backend.js";
import type { PrpEvent } from "./protocol/replay-contract.js";

export const PROVIDER_TURN_WAIT_CAP_MS = 600_000;
export const PROVIDER_TURN_WAIT_TIMEOUT_MARGIN_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface ProviderTurnWaitOptions {
  startedAtMs?: number | null;
  capMs?: number;
  onWait?: (input: { startedAtMs: number; signal: AbortSignal }) => Promise<unknown>;
}

export type ProviderTurnWaitEnd = "cap" | "early" | "runner";

export function awaitsProviderTurn(event: PrpEvent): boolean {
  return event.eventType === "turn.completed" && event.payload.awaitingProviderTurn === true;
}

export function providerTurnWaitDeadline(input: {
  startedAtMs: number;
  capMs: number;
  overallDeadlineMs: number | null;
}): number {
  const cap = input.startedAtMs + input.capMs;
  return input.overallDeadlineMs === null
    ? cap
    : Math.min(cap, input.overallDeadlineMs - PROVIDER_TURN_WAIT_TIMEOUT_MARGIN_MS);
}

export function createProviderTurnWait(input: {
  session: NativeSession;
  options?: ProviderTurnWaitOptions;
  overallDeadlineMs: number | null;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const lifetime = new AbortController();
  let awaited: PrpEvent | null = null;
  let idle = false;
  let startedAtMs: number | null = null;
  let ending: ProviderTurnWaitEnd | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let force!: () => void;
  const forced = new Promise<null>(resolve => { force = () => resolve(null); });

  const end = (reason: ProviderTurnWaitEnd) => {
    if (ending !== null || lifetime.signal.aborted) return;
    ending = reason;
    clearTimeout(timer);
    if (!idle) return;
    const interrupt = input.session.interrupt;
    if (interrupt === undefined) {
      force();
      return;
    }
    void Promise.resolve()
      .then(() => interrupt.call(input.session, {
        ...(awaited?.turnId ? { turnId: awaited.turnId } : {}),
        reason: reason === "cap"
          ? "The provider did not start its own next turn within the wait limit."
          : "A person commented while Paperclip waited for the provider's own next turn.",
      }))
      .catch((error: unknown) => {
        if (!(error instanceof HarnessStaleTurnError)) force();
      });
  };

  const schedule = (deadlineMs: number) => {
    const remaining = deadlineMs - now();
    if (remaining <= 0) {
      end("cap");
      return;
    }
    timer = setTimeout(() => schedule(deadlineMs), Math.min(remaining, MAX_TIMER_MS));
    timer.unref?.();
  };

  return {
    get started() {
      return startedAtMs !== null;
    },
    get ending() {
      return ending;
    },
    get awaitedTerminal() {
      return awaited;
    },
    forced,
    begin(event: PrpEvent): boolean {
      awaited = event;
      idle = true;
      if (ending !== null) return false;
      if (startedAtMs === null) {
        startedAtMs = Math.min(now(), input.options?.startedAtMs ?? Number.POSITIVE_INFINITY);
        schedule(providerTurnWaitDeadline({
          startedAtMs,
          capMs: input.options?.capMs ?? PROVIDER_TURN_WAIT_CAP_MS,
          overallDeadlineMs: input.overallDeadlineMs,
        }));
        const onWait = input.options?.onWait;
        if (ending === null && onWait) {
          void Promise.resolve()
            .then(() => onWait({ startedAtMs: startedAtMs!, signal: lifetime.signal }))
            .then(() => end("early"), () => undefined);
        }
      }
      return ending === null;
    },
    observe(event: PrpEvent) {
      if (event.eventType === "turn.started" && event.payload.origin === "provider") idle = false;
    },
    endedBy(event: PrpEvent): boolean {
      const ended = idle && event.eventType === "item.completed"
        && event.payload.kind === "interrupt_acknowledgement"
        && event.payload.status === "provider_turn_wait_ended";
      if (ended && ending === null && event.payload.cause === "run_terminal") {
        ending = "runner";
        clearTimeout(timer);
      }
      return ended;
    },
    dispose() {
      clearTimeout(timer);
      lifetime.abort();
    },
  };
}
