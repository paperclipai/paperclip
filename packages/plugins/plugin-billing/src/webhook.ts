import { createHash, randomUUID } from "node:crypto";
import { applyBillingEvent, type ApplyDeps } from "./apply.js";
import type { BillingEvent, SubscriptionRow } from "./domain.js";
import type { ParsedProviderEvent } from "./provider/types.js";
import type { BillingStore } from "./store.js";

/**
 * Idempotency key derived from the exact signed bytes: a provider replay is
 * byte-identical, so it hashes to the same key and the ledger insert reports
 * "duplicate" (spec §5 rules). The parsed-event union deliberately carries no
 * event id, so the raw body is the only stable identity.
 */
export function ledgerKeyForRawBody(rawBody: string): string {
  return `webhook:${createHash("sha256").update(rawBody, "utf8").digest("hex")}`;
}

export function toBillingEvent(parsed: ParsedProviderEvent): BillingEvent {
  switch (parsed.type) {
    case "checkout.completed":
      return { type: "checkout.completed", sessionRef: parsed.sessionRef, subRef: parsed.subRef, periodEnd: parsed.periodEnd };
    case "payment.succeeded":
      return { type: "payment.succeeded", subRef: parsed.subRef, periodEnd: parsed.periodEnd };
    case "payment.failed":
      return { type: "payment.failed", subRef: parsed.subRef };
    case "subscription.canceled":
      return { type: "subscription.canceled", subRef: parsed.subRef };
  }
}

/** Resolution order: open session ref → provider subscription ref → rawPayload.companyId. */
export async function resolveSubscriptionForEvent(
  store: BillingStore,
  parsed: ParsedProviderEvent,
  rawPayload: Record<string, unknown>,
): Promise<SubscriptionRow | null> {
  if (parsed.type === "checkout.completed") {
    const bySession = await store.getSubscriptionBySessionRef(parsed.sessionRef);
    if (bySession) return bySession;
  }
  const byRef = await store.getSubscriptionByProviderRef(parsed.subRef);
  if (byRef) return byRef;
  if (typeof rawPayload.companyId === "string" && rawPayload.companyId.length > 0) {
    return store.getSubscriptionByCompany(rawPayload.companyId);
  }
  return null;
}

/**
 * verify → ledger insert → transition → standing. Throwing before the ledger
 * insert (bad signature) makes the host record the delivery as failed with a
 * non-2xx response and changes no state. Any crash after the insert leaves an
 * unapplied ledger row that the sweep replays idempotently (spec §8).
 */
export async function handleProviderWebhook(
  deps: ApplyDeps,
  input: { headers: Record<string, string | string[]>; rawBody: string },
): Promise<void> {
  const parsed = deps.provider.verifyAndParseWebhook(input.headers, input.rawBody);

  let rawPayload: Record<string, unknown>;
  try {
    rawPayload = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    rawPayload = { rawBody: input.rawBody };
  }

  const sub = await resolveSubscriptionForEvent(deps.store, parsed, rawPayload);
  const ledgerId = randomUUID();
  const inserted = await deps.store.insertLedgerEvent({
    id: ledgerId,
    idempotencyKey: ledgerKeyForRawBody(input.rawBody),
    type: parsed.type,
    subscriptionId: sub?.id ?? null,
    companyId: sub?.companyId ?? null,
    rawPayload,
  });
  if (inserted === "duplicate") return;

  if (!sub) {
    deps.logger.warn("billing: webhook event has no resolvable subscription yet; left unapplied for the sweep", {
      type: parsed.type,
    });
    return;
  }

  await applyBillingEvent(deps, sub, toBillingEvent(parsed), ledgerId);
}
