import type { SandboxNetworkEvent } from "./local-process-sandbox.js";
import type { AdapterExecutionContext, AdapterRuntimeEvent } from "./types.js";

/**
 * Delivery of `sandbox.network.*` events onto a channel the confined process cannot reach.
 *
 * ## Why this is not `onLog`
 *
 * `onLog(stream, chunk)` is the confined child's own output pipe: `child.stdout` is forwarded to the
 * identical sink with the identical `"stdout"` discriminator and no framing. Writing security events
 * there gives the sandboxed agent two capabilities against the record that exists to contain it.
 *
 * - **Forgery.** The agent holds `PAPERCLIP_RUN_ID`, `PAPERCLIP_AGENT_ID` and `PAPERCLIP_COMPANY_ID`
 *   in its environment, and the event schema is public. One `echo` of a JSON line is
 *   byte-indistinguishable from a host-authored one — including a fabricated `proxy.started`, which
 *   is the liveness signal every downstream detector keys on.
 * - **Suppression.** Child chunks arrive unframed. A child holding a write open with no trailing
 *   newline prepends its bytes to the next physical line, so a JSON-per-line reader drops whatever
 *   followed. Done continuously it suppresses the whole stream while emission continues, nothing
 *   errors and no test fails — and the alerting then reports "no denials" when the truth is "no data".
 *
 * A record an attacker can write to and delete from is worse than no record, because it reports
 * health. So these events go to `ctx.onEvent` instead: the host-authored run-event channel, which
 * lands a typed row per event with `stream: "system"`. Nothing the child writes can produce a row
 * there — every caller of that channel is host code passing a literal `eventType` — and each event is
 * its own record, so framing is structural rather than a newline convention.
 *
 * ## Ordering
 *
 * Writes are chained rather than fired in parallel. The run-event store allocates a sequence number
 * inside the write, so concurrent fire-and-forget writes could persist out of order and
 * `proxy.stopped` — the end-of-stream marker — could land before the events it closes. The chain is
 * FIFO and survives a failed write: one broken call must not reorder everything after it.
 *
 * The chain carries a second guarantee that is not about ordering and is easy to optimise away: it
 * holds **at most one outstanding store write per sandbox**, so a confined run's egress stream costs
 * one pool connection no matter how fast the child issues requests. Parallelising these writes would
 * lose the ordering *and* let one flooding run exhaust the pool for every other run in the host
 * process. Both guarantees come from the same `then`; the cost of an event is accepted on that basis
 * (TEA-189 J2), so keep it.
 *
 * The queue in front of the chain is bounded by the sink, not here — see
 * `SINK_MAX_OUTSTANDING_WRITES` and `proxy.stopped.droppedEventCount`. An unbounded queue against a
 * one-at-a-time drain is how the end-of-stream marker gets starved.
 *
 * ## Failure accounting
 *
 * The returned promise is handed back to the proxy's sink, which counts its rejection into
 * `proxy.stopped.sinkErrorCount`. That is deliberate: this function must *not* swallow its own
 * rejection, or a persistently failing channel reports `sinkErrorCount: 0`, which reads as an
 * affirmative "the sink was healthy". The proxy never awaits the promise, and the sink attaches the
 * rejection handler, so nothing here can become an unhandled rejection or delay an egress decision.
 */
export interface SandboxNetworkEventChannelOptions {
  /** Stamped onto every event payload. The sandbox utility never learns these Paperclip concepts. */
  identity: { runId: string; agentId: string; companyId: string };
  /** Host-authored run-event sink. The only channel these events are written to. */
  onEvent: AdapterExecutionContext["onEvent"];
  /**
   * Used once, to report that no run-event channel exists — never to carry an event. Writing the
   * events here instead would restore both the forgery and the suppression path above.
   *
   * This warning is a courtesy to whoever reads the log, and **not** a control: it goes out on the
   * child's own log stream, so the confined process can forge it or bury it with exactly the trick
   * C-1 removes from the event path. The control for a missing channel is the absent
   * `proxy.started` that downstream liveness keys on — never this line.
   */
  onLog?: AdapterExecutionContext["onLog"];
}

const NO_CHANNEL_WARNING =
  "[paperclip] sandbox egress decision events are not being recorded: this run has no host run-event " +
  "channel. Network policy is still enforced; only the audit record is missing.\n";

/** Short operator-facing line for the run UI. Every interpolated field is already bounded and scrubbed. */
function describeEvent(event: SandboxNetworkEvent): string {
  switch (event.event) {
    case "sandbox.network.decision":
      return `sandbox egress ${event.decision} ${event.hostname ?? "?"}:${event.port ?? "?"} (${event.reason})`;
    case "sandbox.network.proxy.started":
      return `sandbox egress proxy started with ${event.ruleCount} rule(s), ruleset ${event.rulesetDigest}`;
    case "sandbox.network.proxy.stopped":
      return `sandbox egress proxy stopped after ${event.allowCount} allowed and ${event.denyCount} denied`;
    case "sandbox.network.tunnel.closed":
      return `sandbox egress tunnel closed ${event.hostname ?? "?"}:${event.port ?? "?"} ` +
        `(${event.bytesOut} bytes out, ${event.bytesIn} bytes in)`;
  }
}

/**
 * Builds the `onNetworkDecision` observer for {@link LocalProcessSandboxOptions}. Shared by every
 * adapter that confines a process: duplicating this at each wiring site is how two copies of a
 * security path drift apart.
 */
export function createSandboxNetworkEventChannel(
  options: SandboxNetworkEventChannelOptions,
): (event: SandboxNetworkEvent) => unknown {
  const { identity, onEvent, onLog } = options;
  let warned = false;
  let chain: Promise<void> = Promise.resolve();
  return (event: SandboxNetworkEvent): unknown => {
    if (!onEvent) {
      // Loud once, then silent. The alternative — falling back to the log — would trade a visible
      // absence for a forgeable presence, and absence is the failure mode a reader can act on: a
      // `proxy.started` that never arrives is what the liveness detector already alerts on.
      if (!warned) {
        warned = true;
        // Wrapped rather than `onLog?.(…).catch(…)`: the contract says the call returns a promise,
        // and an implementation that returns nothing would throw here instead — inside the sink,
        // which would count a courtesy warning as a sink failure and hide the real reason.
        void Promise.resolve(onLog?.("stderr", NO_CHANNEL_WARNING)).catch(() => {});
      }
      return undefined;
    }
    const runtimeEvent: AdapterRuntimeEvent = {
      eventType: event.event,
      // Host-authored, so never the child's stdout or stderr.
      stream: "system",
      // A deny is the allowlist working as configured, not an anomaly. Severity is the alerting
      // layer's judgement over the whole stream, not a property of one record.
      level: "info",
      message: describeEvent(event),
      // Identity spreads *last*, and that order is load-bearing: a future event field named `runId`,
      // `agentId` or `companyId` must not be able to displace the host-stamped identity on a security
      // record. Reversing these two spreads would let the emitter overwrite who the event is about.
      payload: { ...event, ...identity },
    };
    const write = chain.then(() => onEvent(runtimeEvent));
    // The chain must outlive a failed write, or one rejection reorders or drops every later event.
    chain = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  };
}
