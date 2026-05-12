import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ECHO_TTL_MS } from "./constants.js";

type EchoRecord = { ts: number };

function isValidEchoRecord(value: unknown): value is EchoRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).ts === "number" &&
    Number.isFinite((value as EchoRecord).ts)
  );
}

/**
 * Echo-dedup guard backed by ctx.state (instance scope) so it survives worker restarts.
 *
 * Returns true  → delivery already seen within TTL; caller should suppress processing.
 * Returns false → delivery is new; caller should proceed.
 *
 * CONCURRENCY NOTE: The plugin SDK does not expose an atomic compare-and-swap
 * operation. Under concurrent webhook deliveries with the same ID, both requests
 * can observe a "not seen" state before either writes, so dedup can fail.
 * This is an eventual-consistency limitation of the current SDK surface.
 * Mitigation: GitHub retries are typically spaced ≥5 s apart; the probability
 * of a true concurrent collision on the same delivery ID is negligible in practice.
 * Do NOT rely on this guard for financial-grade exactly-once semantics.
 *
 * STATE CORRUPTION GUARD: If the stored record has a non-numeric ts (corrupted
 * state), we treat the delivery as new (fail open) rather than suppressing it.
 */
export async function isDuplicateDelivery(ctx: PluginContext, entityId: string): Promise<boolean> {
  const stateKey = `echo:${entityId}`;
  const raw = await ctx.state.get({ scopeKind: "instance", stateKey });
  const now = Date.now();

  if (isValidEchoRecord(raw) && now - raw.ts < ECHO_TTL_MS) {
    return true;
  }

  // Best-effort write — if this throws, the delivery proceeds unguarded this time.
  // On the next delivery the state will still be absent, so dedup stays best-effort.
  await ctx.state.set({ scopeKind: "instance", stateKey }, { ts: now });
  return false;
}

/**
 * Record that we are about to push an entity to GitHub so the inbound webhook
 * handler can suppress the echo when GitHub fires back at us.
 */
export async function markOutboundEcho(ctx: PluginContext, entityId: string): Promise<void> {
  const stateKey = `echo:${entityId}`;
  await ctx.state.set({ scopeKind: "instance", stateKey }, { ts: Date.now() });
}
