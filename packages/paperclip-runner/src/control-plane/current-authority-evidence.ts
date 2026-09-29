import { normalizedEpochCloseId } from "./event-epochs.js";
import { compareCurrentEvents, isEventEpochTransition, eventEpochCloseId } from "./event-epochs.js";
import { compareCurrentCommands, isCommandEpochTransition, commandEpochCloseId } from "./command-epochs.js";
import { createHash } from "node:crypto";
import { authorityJson, DurableAuthorityStoreError, type AuthorityRecord, type DurableAuthorityStore } from "./durable-authority-store.js";
import type { StoredCoreState } from "./durable-prp-control-plane.js";

export interface CurrentAuthorityReference {
  epoch: string;
  kind: "command" | "event";
  id: string;
  sequence: string;
  sha256: string;
}
export interface CurrentAuthorityEvidence {
  schema: "paperclip.current-evidence.v1";
  records: Record<string, CurrentAuthorityReference>;
  commandOrder?: string[];
  eventOrder?: string[];
}
const digest = (body: unknown) => createHash("sha256").update(authorityJson(body)).digest("hex");
const lifecycleEvents = new Set(["session.started", "session.resumed", "session.reconciled", "harness.ready", "turn.accepted", "turn.started", "turn.completed", "turn.failed", "run.terminal"]);
const terminalOperations = new Set(["paperclip_finish", "paperclip_block"]);
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
function invalid(): never { throw new DurableAuthorityStoreError("invalid_authority", "current recovery evidence differs from its exact receipt"); }
function slot(kind: CurrentAuthorityReference["kind"], body: Record<string, unknown>): string | null {
  if (kind === "command") {
    if (body.status === "pending" || body.status === "indeterminate") return null;
    if (typeof body.type !== "string" || body.type.length > 80) invalid();
    if (body.type !== "semantic_tool.result") return `command:${body.type}`;
    const operation = String(object(body.payload).operationId);
    return terminalOperations.has(operation) ? `command:terminal:${operation}` : null;
  }
  const operation = String(object(object(object(object(body.envelope).payload).payload).semantic_tool).operationId);
  if (terminalOperations.has(operation)) return `event:${body.eventType}:${operation}`;
  return lifecycleEvents.has(String(body.eventType)) ? `event:${body.eventType}` : null;
}

/** The on-disk current row contains active work and a fixed set of typed slots.
 * Settled payloads live once in the immutable receipt index. This does not
 * certify a finish by itself: server acceptance still validates its structured
 * input, operation result, completion contract and business result receipt. */
export function referenceCurrentAuthority(state: StoredCoreState): StoredCoreState {
  const next = structuredClone(state);
  const current = next.indexedState!;
  const evidence: CurrentAuthorityEvidence = { schema: "paperclip.current-evidence.v1", records: {}, commandOrder: next.commands.map(c => c.commandId), eventOrder: next.committedEvents.map(e => e.sourceEventId) };
  const remember = (kind: CurrentAuthorityReference["kind"], body: Record<string, unknown>, id: string, sequence: number) => {
    const key = slot(kind, body);
    if (!key) return false;
    evidence.records[key] = { epoch: next.identity.runId, kind, id, sequence: String(sequence), sha256: digest(body) };
    return true;
  };
  next.commands = next.commands.filter(command => !remember("command", command as unknown as Record<string, unknown>, command.commandId, command.controllerSeq));
  next.committedEvents = next.committedEvents.filter(event => current.pendingSemanticInputIds.includes(event.sourceEventId) ||
    !remember("event", { ...event, deliveryCount: 1 }, event.sourceEventId, event.sourceSeq));
  if (Object.keys(evidence.records).length > 40) invalid();
  current.recoveryEvidence = evidence;
  current.schema = "paperclip.runner.current-authority.v2";
  return next;
}

/** Resolves only named current receipts. There is no history scan or fallback
 * to a nearby event if a receipt is missing. Callers fence snapshot generation
 * before and after this bounded read when opening an active authority. */
export async function materializeCurrentAuthority(state: Record<string, unknown>, read: DurableAuthorityStore["getRecord"]): Promise<Record<string, unknown>> {
  const current = object(state.indexedState);
  if (state.indexedState !== undefined && !["paperclip.runner.current-authority.v1", "paperclip.runner.current-authority.v2"].includes(String(current.schema))) invalid();
  if (current.recoveryEvidence === undefined) {
    if (current.schema === "paperclip.runner.current-authority.v2") invalid();
    return state; // Retained v1 current rows and already materialized views.
  }
  if (current.controllerEpoch !== undefined || current.lastCommandEpochTransition !== undefined) {
    const transition = current.lastCommandEpochTransition;
    if (!isCommandEpochTransition(transition) || transition.nextEpoch !== current.controllerEpoch || transition.runId !== object(state.identity).runId) invalid();
    for (const id of [`command-epoch-${transition.transitionId}`, commandEpochCloseId(transition)]) {
      const receipt = await read(transition.runId, "effect", id);
      if (!receipt || receipt.epoch !== transition.runId || receipt.kind !== "effect" || receipt.id !== id || receipt.sequence !== "0" || authorityJson(receipt.body) !== authorityJson(transition)) invalid();
    }
  }
  if (current.sourceEpoch !== undefined || current.lastEventEpochTransition !== undefined) {
    const transition = current.lastEventEpochTransition;
    if (!isEventEpochTransition(transition) || transition.nextEpoch !== current.sourceEpoch || transition.runId !== object(state.identity).runId) invalid();
    for (const id of [`event-epoch-${transition.transitionId}`, eventEpochCloseId(transition)]) {
      const receipt = await read(transition.runId, "effect", id);
      if (!receipt || receipt.epoch !== transition.runId || receipt.kind !== "effect" || receipt.id !== id || receipt.sequence !== "0" || authorityJson(receipt.body) !== authorityJson(transition)) invalid();
    }
  }
  const delivery = object(current.normalizedDelivery);
  if (delivery.producedEpoch !== undefined || delivery.lastSourceEpochTransition !== undefined) {
    const t = delivery.lastSourceEpochTransition;
    const identity = object(state.identity);
    if (!isEventEpochTransition(t) || t.nextEpoch !== delivery.producedEpoch || t.runId !== identity.runId) invalid();
    for (const id of [`normalized-epoch-${t.transitionId}`, normalizedEpochCloseId(t.runId, String(identity.runnerInstanceId), t.fromEpoch)]) {
      const receipt = await read(t.runId, "effect", id);
      if (!receipt || receipt.sequence !== "0" || authorityJson(receipt.body) !== authorityJson(t)) invalid();
    }
  }
  const raw = object(object(current.normalizedDelivery).raw);
  if (current.normalizedDelivery && raw.sourceEpoch !== current.sourceEpoch) {
    const receipt = await read(String(object(state.identity).runId), "effect", eventEpochCloseId({runId: String(object(state.identity).runId), fromEpoch: (raw.sourceEpoch as string | undefined) ?? null}));
    if (!receipt || !isEventEpochTransition(receipt.body) || receipt.body.fromEpoch !== (raw.sourceEpoch ?? null) || Number(raw.sourceSeq) > receipt.body.finalOrdinal) invalid();
  }
  const evidence = object(current.recoveryEvidence), entries = Object.entries(object(evidence.records));
  if (current.schema !== "paperclip.runner.current-authority.v2" || evidence.schema !== "paperclip.current-evidence.v1" || !evidence.records || Array.isArray(evidence.records) || entries.length > 40 ||
    !Array.isArray(state.commands) || !Array.isArray(state.committedEvents)) invalid();
  const result = structuredClone(state) as unknown as StoredCoreState;
  const ids = new Set<string>();
  for (const [key, value] of entries) {
    const ref = value as CurrentAuthorityReference;
    if (!ref || ref.epoch !== result.identity.runId || !["command", "event"].includes(ref.kind) ||
      typeof ref.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(ref.id) ||
      !/^[1-9][0-9]{0,15}$/.test(ref.sequence) || !Number.isSafeInteger(Number(ref.sequence)) || !/^[a-f0-9]{64}$/.test(ref.sha256)) invalid();
    const receipt: AuthorityRecord | null = await read(ref.epoch, ref.kind, ref.id);
    if (!receipt || receipt.epoch !== ref.epoch || receipt.kind !== ref.kind || receipt.id !== ref.id ||
      receipt.sequence !== ref.sequence || digest(receipt.body) !== ref.sha256 || slot(ref.kind, receipt.body) !== key || ids.has(`${ref.kind}:${ref.id}`)) invalid();
    ids.add(`${ref.kind}:${ref.id}`);
    if (ref.kind === "command") {
      if (receipt.body.commandId !== ref.id || String(receipt.body.controllerSeq) !== ref.sequence || result.commands.some(c => c.commandId === ref.id)) invalid();
      result.commands.push(receipt.body as unknown as StoredCoreState["commands"][number]);
    } else {
      if (receipt.body.sourceEventId !== ref.id || String(receipt.body.sourceSeq) !== ref.sequence || result.committedEvents.some(e => e.sourceEventId === ref.id)) invalid();
      result.committedEvents.push(receipt.body as unknown as StoredCoreState["committedEvents"][number]);
    }
  }
  result.commands.sort((a, b) => compareCurrentCommands(a, b, result.indexedState?.controllerEpoch));
  result.committedEvents.sort((a, b) => compareCurrentEvents(a, b, result.indexedState?.sourceEpoch));
  for (const [order, records, id] of [
    [evidence.commandOrder, result.commands, "commandId"], [evidence.eventOrder, result.committedEvents, "sourceEventId"],
  ] as const) {
    if (order === undefined) continue; // retained current-evidence v1
    if (!Array.isArray(order) || order.length !== records.length || new Set(order).size !== order.length) invalid();
    const position = new Map(order.map((key, index) => [key, index]));
    if (records.some(record => !position.has((record as unknown as Record<string, unknown>)[id]))) invalid();
    records.sort((a, b) => position.get((a as unknown as Record<string, unknown>)[id])! - position.get((b as unknown as Record<string, unknown>)[id])!);
  }
  delete result.indexedState!.recoveryEvidence;
  result.indexedState!.schema = "paperclip.runner.current-authority.v1";
  return result as unknown as Record<string, unknown>;
}
