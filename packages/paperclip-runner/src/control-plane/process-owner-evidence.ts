import { isProviderProcessGeneration, isProviderGenerationSuccessor } from "./process-generation.js";
import { eventEpochCloseId, isEventEpochTransition } from "./event-epochs.js";
import { authorityJson, DurableAuthorityStoreError, type AuthorityWorkChange, type DurableAuthorityStore } from "./durable-authority-store.js";
import type { DurableRecoveryCommittedEvent, DurableRecoveryIdentity } from "./prp-transport-types.js";

export interface ProcessOwnerEvidence {
  schema: "paperclip.process-owner.v1";
  identity: DurableRecoveryIdentity;
  sourceEventId: string;
  sourceSeq: number;
  sourceEpoch?: string;
  startup: Record<string, unknown>;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function invalid(): never { throw new DurableAuthorityStoreError("invalid_authority", "provider process ownership evidence is invalid or conflicts with its launch"); }

/** A diagnostic is authoritative only after authenticated PRP validation. The
 * relation retains unresolved launch facts, independently of transcript windows.
 * Direct-child exit is deliberately not accepted as process-tree retirement. */
export function processOwnerEvidence(event: DurableRecoveryCommittedEvent, identity: DurableRecoveryIdentity): ProcessOwnerEvidence | null {
  const wire = event.envelope.payload;
  const body = object(wire) && object(wire.payload) ? wire.payload : {};
  if (event.eventType !== "harness.diagnostic" || body.code !== "provider_startup_ownership") return null;
  const startup = body.startup;
  if (!object(startup) || startup.schema !== "paperclip.provider_startup.v1" ||
    typeof startup.launchId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(startup.launchId) ||
    !["intent", "spawned", "initialization_failed"].includes(String(startup.phase)) ||
    !isProviderProcessGeneration(startup.attemptedProcessGeneration) ||
    (typeof startup.attemptedProcessGeneration === "string" && !isProviderGenerationSuccessor(startup.previousProcessGeneration, startup.attemptedProcessGeneration)) ||
    typeof startup.configurationFingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(startup.configurationFingerprint) ||
    startup.processTreeRetired !== false || !object(startup.origin) || ["runnerInstanceId", "runId", "normalizedSessionId", "turnId", "itemId"].some(key => (startup.origin as Record<string, unknown>)[key] !== identity[key as keyof DurableRecoveryIdentity])) invalid();
  const hasProcess = Number.isSafeInteger(startup.processId) && Number(startup.processId) > 0 && startup.processId === startup.processGroupId;
  if (startup.phase === "intent" ? startup.processId != null || startup.processGroupId != null :
    startup.failedStage === "spawn" ? startup.processId != null || startup.processGroupId != null : !hasProcess) invalid();
  return { schema: "paperclip.process-owner.v1", identity: structuredClone(identity), sourceEventId: event.sourceEventId, sourceSeq: event.sourceSeq, ...(event.sourceEpoch ? { sourceEpoch: event.sourceEpoch } : {}), startup: structuredClone(startup) };
}

/** At most one page of new facts; repeated phases for a launch collapse in the
 * transaction, while every original event is still an immutable receipt. */
export async function processOwnerChanges(authority: DurableAuthorityStore, facts: readonly ProcessOwnerEvidence[], current: { runId: string; sourceEpoch?: string }): Promise<AuthorityWorkChange[]> {
  // Collapse the source page before consulting the index. On interrupted
  // backfill the index may already contain a later phase from this same page;
  // comparing its first intent against that phase would reject a safe replay.
  const latest = new Map<string, ProcessOwnerEvidence>();
  for (const fact of facts) {
    const id = String(fact.startup.launchId);
    const prior = latest.get(id);
    if (prior) validateAdvance(prior, fact);
    latest.set(id, fact);
  }
  const changes = new Map<string, AuthorityWorkChange>();
  for (const fact of latest.values()) {
    const id = String(fact.startup.launchId);
    const pending = changes.get(id);
    const stored = pending ? null : await authority.getWork("process-owner", id);
    const prior = (pending?.body ?? stored?.body) as unknown as ProcessOwnerEvidence | undefined;
    if (prior) {
      validateAdvance(prior, fact);
      if (prior.sourceEpoch !== fact.sourceEpoch) {
        if (fact.identity.runId !== current.runId || fact.sourceEpoch !== current.sourceEpoch) invalid();
        const receipt = await authority.getRecord(prior.identity.runId, "effect", eventEpochCloseId({ runId: prior.identity.runId, fromEpoch: prior.sourceEpoch ?? null }));
        if (!receipt || !isEventEpochTransition(receipt.body) || receipt.body.runId !== prior.identity.runId || receipt.body.fromEpoch !== (prior.sourceEpoch ?? null)
          || receipt.body.finalOrdinal < prior.sourceSeq) invalid();
      }
      if (authorityJson(prior) === authorityJson(fact)) continue;
    }
    // An authenticated failed spawn proves that this launch created no child.
    // Remove its pending intent in the same transaction as the immutable event
    // receipt. A child exit after spawn does not prove a stopped process tree.
    if (fact.startup.phase === "initialization_failed" && fact.startup.failedStage === "spawn") {
      if (stored) changes.set(id, { collection: "process-owner", id, expectedSha256: stored.sha256, body: null });
      continue;
    }
    changes.set(id, { collection: "process-owner", id, expectedSha256: pending?.expectedSha256 ?? stored?.sha256 ?? null, body: fact as unknown as Record<string, unknown> });
  }
  return [...changes.values()];
}

function validateAdvance(prior: ProcessOwnerEvidence, fact: ProcessOwnerEvidence): void {
  if (prior.schema !== fact.schema || authorityJson(prior.identity) !== authorityJson(fact.identity) ||
    prior.startup.launchId !== fact.startup.launchId ||
    prior.startup.previousProcessGeneration !== fact.startup.previousProcessGeneration ||
    prior.startup.configurationFingerprint !== fact.startup.configurationFingerprint ||
    prior.startup.attemptedProcessGeneration !== fact.startup.attemptedProcessGeneration ||
    (prior.startup.processId != null && prior.startup.processId !== fact.startup.processId) ||
    (prior.sourceEpoch === fact.sourceEpoch && (prior.sourceSeq > fact.sourceSeq || (prior.sourceSeq === fact.sourceSeq && authorityJson(prior) !== authorityJson(fact))))) invalid();
  const phase = ["intent", "spawned", "initialization_failed"];
  if (phase.indexOf(String(prior.startup.phase)) > phase.indexOf(String(fact.startup.phase))) invalid();
}
