import { isDeepStrictEqual } from "node:util";
import type { ConnectionManagementContext } from "../../connection-management.js";
import { logActivity } from "../../activity-log.js";
import { forbidden, conflict, notFound } from "../../../errors.js";
import { notifyChatReceiver } from "../runtime/receiver-work-notifications.js";
import { PhotonChatAdapter } from "../../photon/adapter.js";
import { and, eq, sql, gt, lte, desc } from "drizzle-orm";
import { chatEndpoints, chatSdkState, type Db } from "@paperclipai/db";
import type { LiveEvent } from "@photon-ai/advanced-imessage";
import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";
import type { ResolvedPhotonChatConfig } from "../../chat-sdk-runtime.js";
import type { EndpointRecord, RuntimeContext, DiscordGatewayOwnership, InternalSetupState } from "../runtime-types.js";
import { credentialFingerprint } from "../credential-fingerprint.js";
import { createPhotonExternalStore, PHOTON_EXTERNAL_STATE } from "./external-store.js";
import { createPhotonExternalOwner, PhotonLocalResources, type PhotonExternalBroker } from "./external-owner.js";
import { readPhotonExternalState, parsePhotonExternalDelivery, photonHash, type PhotonExternalIdentity } from "./external-contract.js";
import { currentControllerProcess, UNKNOWN_PROCESS_SPACE } from "../../controller-process-identity.js";
import { randomUUID, createHash } from "node:crypto";

export type PhotonCloudDelivery = { id: string; event: string; createdAt: string; installationId: string | null; bindingIds: readonly string[]; payload: Record<string, unknown> };
type Ingress = (event: PhotonCloudDelivery) => Promise<void>;
const ingress = new WeakMap<Db, Ingress>();
export async function dispatchPhotonCloudEvent(db: Db, event: PhotonCloudDelivery) {
  const owner = ingress.get(db); if (!owner) throw new Error("Photon normal authorized ingress is not ready");
  await owner(event);
}
const stateKey = `photon:${createHash("sha256").update(PHOTON_EXTERNAL_STATE).digest("hex")}`;
type PhotonReceiverScope = { kind: "endpoint" | "connection" | "company"; id: string };
/** Same keyset reconstruction pattern as the normal receiver owner. The upper
 * bound is captured once, so concurrent inserts cannot extend this scan forever;
 * their ordinary durable endpoint notifications remain independently pending.
 * Cost is 1 + ceil(snapshot rows / 100) reads, NOT a fixed SQL-lifetime bound. */
async function* photonExternalRows(db: Db, scope?: PhotonReceiverScope) {
  const filter = and(eq(chatSdkState.stateKey, stateKey), scope?.kind === "endpoint" ? eq(chatSdkState.endpointId, scope.id) : undefined,
    scope?.kind === "company" ? eq(chatSdkState.companyId, scope.id) : undefined);
  const [last] = await db.select({ id: chatSdkState.id }).from(chatSdkState).where(filter).orderBy(desc(chatSdkState.id)).limit(1);
  if (!last) return;
  let after: string | undefined;
  while (true) {
    const rows = await db.select({ id: chatSdkState.id, companyId: chatSdkState.companyId, endpointId: chatSdkState.endpointId,
      connectionId: chatEndpoints.connectionId, value: chatSdkState.value }).from(chatSdkState).innerJoin(chatEndpoints,
        and(eq(chatEndpoints.companyId, chatSdkState.companyId), eq(chatEndpoints.id, chatSdkState.endpointId)))
      .where(and(filter, lte(chatSdkState.id, last.id), after ? gt(chatSdkState.id, after) : undefined)).orderBy(chatSdkState.id).limit(100);
    for (const row of rows) if (scope?.kind !== "connection" || row.connectionId === scope.id) yield row;
    if (rows.length < 100 || rows[rows.length - 1].id === last.id) return;
    after = rows[rows.length - 1].id;
  }
}
export async function readPhotonRetainedConsumer(db: Db, identity: { instanceId: string; environment: string }) {
  // Settled history never hides an unfinished tail behind a LIMIT-before-filter.
  const attention: string[] = [];
  let owner: { subject: string; companyId: string } | null = null;
  for await (const row of photonExternalRows(db)) {
    try {
      const retained = readPhotonExternalState(row.value);
      if (!retained || retained.identity.companyId !== row.companyId || retained.identity.endpointId !== row.endpointId
        || retained.binding.instanceId !== identity.instanceId || retained.binding.environment !== identity.environment) throw new Error("Photon retained identity changed");
      if (retained.phase !== "retired" && !owner) owner = { subject: retained.identity.subject, companyId: row.companyId };
    } catch { if (attention.length < 100) attention.push("photon_retained_identity_invalid"); }
  }
  return { owner, attention };
}
export function createPhotonExternalRuntimeOwner(db: Db, options: {
  broker(): PhotonExternalBroker | undefined;
  withReceiverLease<T>(record: EndpointRecord, work: (lease: { token: string }) => Promise<T>): Promise<T>;
  endpointRecord(id: string): Promise<EndpointRecord | null>;
  runtimeFor(endpoint: EndpointRecord["endpoint"], input: { requireDiscordOwnership?: boolean }): Promise<ChatEndpointRuntime>;
  context(runtime: ChatEndpointRuntime): RuntimeContext | undefined;
  ownership(id: string): DiscordGatewayOwnership | undefined;
  release(ownership: DiscordGatewayOwnership): Promise<void>;
  currentRuntime(id: string): ChatEndpointRuntime | null;
  removeRuntime(id: string): Promise<boolean>;
  config(record: EndpointRecord): Promise<ResolvedPhotonChatConfig>;
  admit(id: string, event: LiveEvent, context: RuntimeContext): Promise<void>;
  notify(id: string): void;
}) {
  const store = createPhotonExternalStore(db), resources = new PhotonLocalResources();
  const active = new Map<string, Promise<void>>();
  async function selected(record: EndpointRecord) {
    const subject = (record.endpoint.setup as InternalSetupState).photonExternalSubject;
    if (!subject) return null;
    const identity: PhotonExternalIdentity = { companyId: record.endpoint.companyId, endpointId: record.endpoint.id,
      connectionId: record.endpoint.connectionId, runtimeGeneration: Number((record.endpoint.setup as InternalSetupState).runtimeGeneration ?? 0),
      credentialReferences: credentialFingerprint(record.credentialSecretRefs), subject };
    const retained = await store.inspect(identity), connector = options.broker()?.instanceIdentity();
    if (!retained || retained.phase !== "external" || !isDeepStrictEqual(retained.identity, identity)
      || !connector || retained.binding.instanceId !== connector.instanceId || retained.binding.environment !== connector.environment) return null;
    return retained;
  }
  async function placement(record: EndpointRecord) {
    if (record.endpoint.provider !== "imessage-photon") return null;
    return selected(record);
  }
  async function reserveLocalRuntime(record: EndpointRecord, context: RuntimeContext, lease: { token: string }, config: ResolvedPhotonChatConfig): Promise<string | null> {
    const subject = (record.endpoint.setup as InternalSetupState).photonExternalSubject, broker = options.broker();
    if (!subject || !broker || record.endpoint.provider !== "imessage-photon") return null;
    const identity: PhotonExternalIdentity = { companyId: record.endpoint.companyId, endpointId: record.endpoint.id,
      connectionId: record.endpoint.connectionId, runtimeGeneration: context.generation, credentialReferences: context.credentialFingerprint, subject };
    const prior = await store.read(identity);
    if (prior && prior.phase !== "retired") {
      if (prior.phase === "external") return null; // Normal lazy useful sender; no receiver allocation.
      options.notify(record.endpoint.id);
      throw conflict("Photon original handoff must recover before a replacement receiver allocation");
    }
    const controller = await currentControllerProcess();
    if (controller.hostHash === UNKNOWN_PROCESS_SPACE || !controller.processStartedAt)
      throw conflict("Photon local allocation requires its actual process birth and namespace");
    const id = randomUUID();
    // Durable descriptor precedes construction/initialize, not an after-crash backfill.
    await createPhotonExternalOwner({ store, broker, resources, notify: value => options.notify(value.endpointId) }).prepare({
      identity, lease, config, localResourceId: id, localResource: { id, controller, leaseDigest: photonHash(lease.token), closed: false } });
    return id;
  }
  function attachLocalRuntime(id: string, runtime: ChatEndpointRuntime): void {
    resources.attach(id, runtime, () => runtime.shutdown());
  }
  async function reconcile(id: string): Promise<void> {
    const pending = active.get(id); if (pending) return pending;
    const run = (async () => {
      const record = await options.endpointRecord(id);
      if (!record || record.endpoint.provider !== "imessage-photon") return;
      const previous = await store.read({ companyId: record.endpoint.companyId, endpointId: id });
      const broker = options.broker(), subject = (record.endpoint.setup as InternalSetupState).photonExternalSubject;
      const identity: PhotonExternalIdentity | null = subject ? { companyId: record.endpoint.companyId, endpointId: id, connectionId: record.endpoint.connectionId,
        runtimeGeneration: Number((record.endpoint.setup as InternalSetupState).runtimeGeneration ?? 0), credentialReferences: credentialFingerprint(record.credentialSecretRefs), subject } : null;
      if (previous && previous.phase !== "retired" && (previous.phase === "retiring" || !identity
        || !isDeepStrictEqual(previous.identity, identity) || !await store.inspect(identity)
        || broker && (previous.binding.instanceId !== broker.instanceIdentity().instanceId
          || previous.binding.environment !== broker.instanceIdentity().environment))) {
        await createPhotonExternalOwner({ store, broker, resources, notify: value => options.notify(value.endpointId) }).retire(previous);
        return;
      }
      if (!identity || !broker) {
        if (previous && previous.phase !== "retired") throw new Error("Photon retained Cloud receiver port is unavailable");
        return;
      }
      const optionsConfig = await options.config(record);
      const originalRuntime = options.currentRuntime(id);
      const originalResourceCurrent = previous?.localResourceId && originalRuntime
        ? resources.owns(previous.localResourceId, originalRuntime) : false;
      if (previous && ["enrolling", "joining"].includes(previous.phase) && !originalResourceCurrent) {
        // Recover BUSINESS authority without constructing/capturing an ignored
        // replacement receiver. The normal finite renewable lease fences old writes.
        const originalResourceId = previous.localResourceId;
        await options.withReceiverLease(record, lease => createPhotonExternalOwner({ store, broker, resources,
          notify: value => options.notify(value.endpointId) }).reconcile({ identity, lease, config: optionsConfig, localResourceId: originalResourceId }));
        return;
      }
      let external = await placement(record);
      if (external) {
        if (external.localResourceId !== null && !external.localClosureConfirmed) {
          external = (await createPhotonExternalOwner({ store, broker, resources, notify: value => options.notify(value.endpointId) }).repair(external)).state;
        }
        const adapter = options.currentRuntime(id)?.getProviderAdapter();
        if (adapter instanceof PhotonChatAdapter) await adapter.drainUsefulClient();
        else if (external.failure?.code === "sender_close" && !await options.removeRuntime(id)) throw new Error("Photon original sender physical closure is unknown");
        if (external.failure?.code === "sender_close") await store.retained(external, value => ({ ...value, failure: null }));
        return;
      }
      const runtime = await options.runtimeFor(record.endpoint, { requireDiscordOwnership: true });
      const context = options.context(runtime), lease = options.ownership(id);
      if (!context || !lease || lease.context !== context || context.endpointRuntime !== runtime || lease.stopping) throw new Error("Photon normal local resource lease changed");
      const currentIdentity: PhotonExternalIdentity = { companyId: record.endpoint.companyId, endpointId: id, connectionId: record.endpoint.connectionId,
        runtimeGeneration: context.generation, credentialReferences: context.credentialFingerprint, subject: identity.subject };
      const owner = createPhotonExternalOwner({ store, broker, resources, notify: value => options.notify(value.endpointId) });
      // Keep the real runtime in the normal registry through shutdown. Its failure
      // persistence callbacks still see the exact current object/lease; removing
      // it first would turn cleanup debt into an obsolete-context no-op.
      const resourceId = resources.capture(runtime, async () => { await runtime.shutdown(); });
      await owner.reconcile({ identity: currentIdentity, lease, config: await options.config(record), localResourceId: resourceId });
      await options.removeRuntime(id);
      await options.release(lease);
      context.discordGatewayOwned = false;
      // The SDK client was physically closed. Normal runtimeFor builds a NEW
      // useful sender, with placement verified from committed external state.
      // No eager sender/client is created merely to be idle. The next genuine
      // ordinary publication or Cloud admission calls normal runtimeFor.
    })();
    active.set(id, run);
    try { await run; } finally { if (active.get(id) === run) active.delete(id); }
  }
  const receive: Ingress = async event => {
    const packet = event.payload.photonEvent;
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new Error("Photon sealed packet is missing");
    const raw = Reflect.get(packet, "binding");
    if (!raw || typeof raw !== "object" || typeof Reflect.get(raw, "endpointId") !== "string") throw new Error("Photon sealed binding is invalid");
    const record = await options.endpointRecord(Reflect.get(raw, "endpointId"));
    if (!record) throw new Error("Photon retained endpoint requires retirement attention");
    const retained = await placement(record), broker = options.broker();
    if (!retained) {
      const subject = (record.endpoint.setup as InternalSetupState).photonExternalSubject;
      if (!subject) throw new Error("Photon original subject is unavailable");
      const previous = await store.read({ companyId: record.endpoint.companyId, endpointId: record.endpoint.id, connectionId: record.endpoint.connectionId,
        runtimeGeneration: Number((record.endpoint.setup as InternalSetupState).runtimeGeneration ?? 0), credentialReferences: credentialFingerprint(record.credentialSecretRefs), subject });
      if (!previous || previous.phase !== "retiring" || !broker) throw new Error("Photon exact retired delivery owner is unavailable");
      const decoded = parsePhotonExternalDelivery({ ...event, payload: packet }, previous);
      await store.noEffect(previous, decoded.packet.sequence);
      options.notify(record.endpoint.id);
      return;
    }
    if (!broker) throw new Error("Photon exact external owner is not currently dispatchable");
    const runtime = await options.runtimeFor(record.endpoint, { requireDiscordOwnership: true });
    const context = options.context(runtime), lease = options.ownership(record.endpoint.id);
    if (!context || !lease || lease.context !== context || lease.stopping) throw new Error("Photon short admission lease is unavailable");
    try {
      const owner = createPhotonExternalOwner({ store, broker, resources, notify: value => options.notify(value.endpointId) });
      await owner.dispatch({ identity: retained.identity, lease, delivery: { ...event, payload: packet },
        admit: value => options.admit(record.endpoint.id, value, context) });
    } finally {
      // Keep the useful sender; retire ONLY the short receiver admission lease.
      await options.release(lease); context.discordGatewayOwned = false;
    }
  };
  async function senderDebt(id: string) {
    const record = await options.endpointRecord(id);
    if (!record) throw new Error("Photon sender debt has no retained endpoint");
    const external = await placement(record);
    if (!external) throw new Error("Photon sender debt has no exact retained owner");
    await store.retained(external, value => ({ ...value, failure: { code: "sender_close", attempts: (value.failure?.attempts ?? 0) + 1, nextAttemptAt: new Date().toISOString() } }));
    options.notify(id);
  }
  async function retire(id: string) {
    const record = await options.endpointRecord(id), broker = options.broker();
    if (!record || !broker) return;
    const subject = (record.endpoint.setup as InternalSetupState).photonExternalSubject;
    if (!subject) return;
    const retained = await store.read({ companyId: record.endpoint.companyId, endpointId: id, connectionId: record.endpoint.connectionId,
      runtimeGeneration: Number((record.endpoint.setup as InternalSetupState).runtimeGeneration ?? 0), credentialReferences: credentialFingerprint(record.credentialSecretRefs), subject });
    if (retained && retained.phase !== "retired") await createPhotonExternalOwner({ store, broker, resources, notify: value => options.notify(value.endpointId) }).retire(retained);
  }
  async function retained(scope?: { kind: "endpoint" | "connection" | "company"; id: string }) {
    const values = [];
    for await (const row of photonExternalRows(db, scope)) {
      let state;
      try {
        state = readPhotonExternalState(row.value);
        if (!state || state.identity.companyId !== row.companyId || state.identity.endpointId !== row.endpointId) throw new Error("Photon retained receiver identity changed");
      } catch {
        // Keep malformed debt on its own existing endpoint owner. The coordinator
        // records/retries that failure while still visiting unrelated endpoints.
        if (scope?.kind !== "connection" || row.connectionId === scope.id) values.push({ id: row.endpointId, companyId: row.companyId, connectionId: row.connectionId, dueAt: 0 });
        continue;
      }
      if (state.phase === "retired") continue;
      const record = state.phase === "external" ? await options.endpointRecord(row.endpointId) : null;
      const current = record && record.endpoint.provider === "imessage-photon"
        && (record.endpoint.setup as InternalSetupState).photonExternalSubject === state.identity.subject
        ? await store.inspect(state.identity) : null;
      const connector = options.broker()?.instanceIdentity();
      const changedExternal = state.phase === "external" && (!current || current.phase !== "external" || current.handoffId !== state.handoffId
        || connector && (state.binding.instanceId !== connector.instanceId || state.binding.environment !== connector.environment));
      const restoredRetirementPort = state.phase === "retiring" && state.failure?.code === "authority"
        && state.failure.nextAttemptAt === null && connector !== undefined;
      values.push({ id: row.endpointId, companyId: row.companyId, connectionId: row.connectionId,
        dueAt: changedExternal || restoredRetirementPort ? 0 : state.failure ? (state.failure.nextAttemptAt ? Date.parse(state.failure.nextAttemptAt) : null)
          : state.localResourceDebt ? (state.localResourceDebt.nextAttemptAt ? Date.parse(state.localResourceDebt.nextAttemptAt) : null)
          : state.phase === "external" ? null : 0 });
    }
    return values;
  }
  async function cleanupFailure(id: string, context: RuntimeContext): Promise<{ kind: "recorded" } | { kind: "obsolete" }> {
    const record = await options.endpointRecord(id);
    const subject = record && (record.endpoint.setup as InternalSetupState).photonExternalSubject;
    if (!record || !subject || !context.endpointRuntime) return { kind: "obsolete" };
    const state = await store.read({ companyId: record.endpoint.companyId, endpointId: id, connectionId: record.endpoint.connectionId,
      runtimeGeneration: context.generation, credentialReferences: context.credentialFingerprint, subject });
    if (!state?.localResourceId || !resources.owns(state.localResourceId, context.endpointRuntime)
      || !["joining", "external", "retiring"].includes(state.phase) || state.localClosureConfirmed) return { kind: "obsolete" };
    await store.retained(state, value => value.phase === "external"
      ? { ...value, localResourceDebt: { attempts: (value.localResourceDebt?.attempts ?? 0) + 1, nextAttemptAt: new Date().toISOString() } }
      : { ...value, failure: { code: "local_join", attempts: (value.failure?.attempts ?? 0) + 1, nextAttemptAt: new Date().toISOString() } });
    options.notify(id);
    return { kind: "recorded" };
  }
  async function retry(endpointId: string, actionId: string, management: ConnectionManagementContext) {
    await management.reauthorize();
    const record = await options.endpointRecord(endpointId), broker = options.broker();
    if (!record || record.endpoint.provider !== "imessage-photon") throw notFound("Photon endpoint not found");
    const subject = (record.endpoint.setup as InternalSetupState).photonExternalSubject;
    if (!subject || !broker || !management.responsibleUserId || !management.decision.allowed || management.decision.action !== "connections:configure"
      || management.resource.companyId !== record.endpoint.companyId || management.resource.connectionId && management.resource.connectionId !== record.endpoint.connectionId)
      throw forbidden("Current company connection authority is required");
    const state = await store.read({ companyId: record.endpoint.companyId, endpointId, connectionId: record.endpoint.connectionId,
      runtimeGeneration: Number((record.endpoint.setup as InternalSetupState).runtimeGeneration ?? 0), credentialReferences: credentialFingerprint(record.credentialSecretRefs), subject });
    const connector = broker.instanceIdentity();
    if (!state || state.handoffId !== actionId || state.binding.instanceId !== connector.instanceId || state.binding.environment !== connector.environment)
      throw conflict("Photon retained retry identity changed");
    if (state.phase === "retired") return { actionId, state: "complete" as const };
    // Retry is real current-authorized business recovery/physical repair. An
    // unknown old UUID remains debt; it is never certified closed by this action.
    if (state.phase === "external" || state.phase === "retiring")
      await createPhotonExternalOwner({ store, broker, resources, notify: value => options.notify(value.endpointId) }).repair(state);
    if (state.phase === "external") await broker.photonReceiverOperation({ subject: management.responsibleUserId, companyId: state.identity.companyId,
      operation: { kind: "retry", binding: state.binding } });
    await management.reauthorize();
    const current = await store.read(state.identity);
    if (!current || current.handoffId !== state.handoffId || !isDeepStrictEqual(current.binding, state.binding)) throw conflict("Photon retry owner changed");
    await store.retained(current, value => ({ ...value, failure: value.failure ? { ...value.failure, nextAttemptAt: new Date().toISOString() } : null }), async tx => {
      await management.reauthorize();
      await logActivity(tx, { ...management.audit, companyId: state.identity.companyId, action: "chat.photon_external_owner.retry",
        entityType: "chat_endpoint", entityId: endpointId, details: { handoffId: actionId, phase: state.phase } });
      await notifyChatReceiver(tx, { id: endpointId, provider: "imessage-photon" });
    });
    options.notify(endpointId);
    return { actionId, state: "scheduled" as const };
  }
  ingress.set(db, receive);
  return { reserveLocalRuntime, attachLocalRuntime, reconcile, placement, senderDebt, retire, retained, cleanupFailure, retry, close() { if (ingress.get(db) === receive) ingress.delete(db); return Promise.all([...active.values()]).then(() => undefined); } };
}

/** Called by normal configuration SQL with its actual authorized actor. Existing
 * retained SDK state is deliberately untouched until its original owner retires. */
export async function stagePhotonExternalConfiguration(db: Pick<Db, "select" | "update">, endpointId: string, subject: string | null | undefined) {
  if (!subject) return;
  await db.update(chatEndpoints).set({ setup: sql`jsonb_set(${chatEndpoints.setup}, '{photonExternalSubject}', ${JSON.stringify(subject)}::jsonb)` })
    .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.provider, "imessage-photon")));
}
