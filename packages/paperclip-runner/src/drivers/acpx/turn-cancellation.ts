import type { AcpRuntimeTurnResult } from "acpx/runtime";
import type { AcpxRuntimeTurn } from "./runtime-host.js";

/** An ACP cancel acknowledgement is not terminal evidence. Await a provider
 * terminal or owned runtime retirement before ending the caller's stream.
 */
export function withAcpxTurnCancellation(
  raw: AcpxRuntimeTurn,
  closeRuntime: (reason: string) => Promise<void>,
  graceMs: number,
): AcpxRuntimeTurn {
  let cancellation: Promise<AcpRuntimeTurnResult> | undefined;
  const retirement = new AbortController();
  let retire!: (value: AcpRuntimeTurnResult) => void;
  let failRetirement!: (error: unknown) => void;
  const retired = new Promise<AcpRuntimeTurnResult>((resolve, reject) => {
    retire = resolve; failRetirement = reject;
  });
  void retired.catch(() => undefined);
  const cancel = (input?: { reason?: string }): Promise<void> => {
    if (!cancellation) {
      const reason = input?.reason ?? "Paperclip cancellation";
      // Install the gate before invoking provider code, including synchronous
      // callback cancellation and a terminal racing the acknowledgement.
      cancellation = Promise.resolve().then(async () => {
        void Promise.resolve().then(() => raw.cancel({ reason })).catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const terminal = await Promise.race([
          raw.result,
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), graceMs); }),
        ]).finally(() => clearTimeout(timer));
        if (terminal !== null) {
          return terminal.status === "completed"
            ? { status: "cancelled" as const, stopReason: "cancelled_after_provider_completed" }
            : terminal;
        }
        // closeRuntime owns process identities and lifetime leases. A rejected
        // close must never turn an unproven process exit into cancellation.
        await closeRuntime(reason);
        return { status: "cancelled" as const, stopReason: "cancelled_after_runtime_close" };
      });
      void cancellation.then(
        value => { retire(value); retirement.abort(); },
        error => { failRetirement(error); retirement.abort(); },
      );
    }
    return cancellation.then(() => undefined);
  };
  const result = Promise.race([
    raw.result.then(value => cancellation ?? value, error => cancellation ?? Promise.reject(error)),
    retired,
  ]);
  void result.catch(() => undefined);
  return {
    requestId: raw.requestId,
    promptStarted: raw.promptStarted,
    result,
    cancel,
    closeStream: input => raw.closeStream(input),
    events: (async function* () {
      const iterator = raw.events[Symbol.asyncIterator]();
      try {
        while (true) {
          if (retirement.signal.aborted) { await retired; return; }
          let onRetirement!: () => void;
          const interrupted = new Promise<{ kind: "retired" }>((resolve, reject) => {
            onRetirement = () => { void retired.then(() => resolve({ kind: "retired" }), reject); };
            retirement.signal.addEventListener("abort", onRetirement, { once: true });
          });
          const next = await Promise.race([
            iterator.next().then(value => ({ kind: "event" as const, value })),
            interrupted,
          ]).finally(() => retirement.signal.removeEventListener("abort", onRetirement)).catch(async error => {
            if (!cancellation) throw error;
            // EOF during owned close is not itself proof that cleanup worked.
            await cancellation;
            return { kind: "retired" as const };
          });
          if (next.kind === "retired") return;
          if (next.value.done) {
            // Clean EOF is no stronger than a transport error: when Stop owns
            // settlement, keep the stream open until terminal/cleanup proof.
            if (cancellation) await cancellation;
            return;
          }
          yield next.value.value;
        }
      } finally {
        // Some provider iterators await a stuck RPC even after retirement.
        // Do not make their optional return() another unbounded shutdown wait.
        void iterator.return?.().catch(() => undefined);
      }
    })(),
  };
}
