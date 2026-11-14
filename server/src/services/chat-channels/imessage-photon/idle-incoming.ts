import { photonCoverageFingerprint, type PhotonCoverageAuthority } from "./idle-coverage.js";
import { and, eq, sql } from "drizzle-orm";
import { chatEndpoints, chatSdkState, toolConnections, type Db } from "@paperclipai/db";
import { createHash } from "node:crypto";
import { connectionManagementService } from "../../connection-management.js";
import { credentialFingerprint } from "../credential-fingerprint.js";
import { readPhotonExternalState } from "./external-contract.js";
import { PHOTON_EXTERNAL_STATE } from "./external-store.js";
import { photonExternalPhysicalIdle } from "./external-runtime.js";
import type { VerifiedIdleCapabilities } from "../../idle-incoming-wake-capability.js";
/** Query execution wrapper, not an authorization policy. Every actual nested
 * SELECT/execute uses the enclosing idle reader's SAME query/time budget. */
export function photonIdleReadTransaction(tx: Pick<Db, "select" | "execute">, budget: { beforeRead(): Promise<void>; remaining(): number }): Db {
  const read = async <T>(work: () => T | PromiseLike<T>): Promise<T> => {
    await budget.beforeRead(); const result = await work(); budget.remaining(); return result;
  };
  const query = <T extends object>(target: T): T => new Proxy(target, { get(value, key) {
    const member: unknown = Reflect.get(value, key, value);
    if (key === "then" && typeof member === "function") {
      return (resolve: (result: unknown) => unknown, reject: (error: unknown) => unknown) =>
        read(() => Promise.resolve(value)).then(resolve, reject);
    }
    if (typeof member !== "function") return member;
    return (...args: unknown[]) => {
      if (key === "execute") return read(() => Reflect.apply(member, value, args));
      const result: unknown = Reflect.apply(member, value, args);
      return result && typeof result === "object" && typeof Reflect.get(result, "then") === "function" ? query(result) : result;
    };
  } });
  return new Proxy(tx as Db, { get(target, key) {
    if (["insert", "update", "delete", "transaction", "query"].includes(String(key)))
      return () => { throw new Error("Photon idle authority requires a readonly bounded query"); };
    const member: unknown = Reflect.get(target, key, target);
    if (key === "execute" && typeof member === "function") return (...args: unknown[]) => read(() => Reflect.apply(member, target, args));
    if (["select", "selectDistinct", "selectDistinctOn"].includes(String(key)) && typeof member === "function")
      return (...args: unknown[]) => query(Reflect.apply(member, target, args));
    return member;
  } });
}
/** Same safety transaction/budget. No I/O, allocation, cleanup or secret fetch. */
export async function readPhotonIdleIncomingProof(tx: Pick<Db, "select" | "execute">, input: {
  capabilities: VerifiedIdleCapabilities; identity?: { instanceId: string; environment: string }; receiverOwner: Db;
  receiverBound: boolean; beforeRead(): Promise<void>; remaining(): number; inspectionNow: number;
}): Promise<{ endpointIds: string[]; connectionIds: string[] } | undefined> {
  const incoming = input.capabilities.incomingWake, coverage = incoming?.photonBroker;
  if (!incoming?.routes.includes("photon-broker-events-v1") || !coverage || !input.identity || !input.receiverBound
    || coverage.instanceId !== input.identity.instanceId || coverage.generation !== incoming.generation) return;
  await input.beforeRead();
  const key = `photon:${createHash("sha256").update(PHOTON_EXTERNAL_STATE).digest("hex")}`;
  const rows = await tx.select({ endpoint: chatEndpoints, connection: toolConnections, retained: chatSdkState.value }).from(chatEndpoints)
    .innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
    .leftJoin(chatSdkState, and(eq(chatSdkState.companyId, chatEndpoints.companyId), eq(chatSdkState.endpointId, chatEndpoints.id), eq(chatSdkState.stateKey, key)))
    .where(and(eq(chatEndpoints.provider, "imessage-photon"), eq(chatEndpoints.status, "active"),
      sql`exists (select 1 from companies where id=${chatEndpoints.companyId} and status <> 'archived')`)).orderBy(chatEndpoints.id).limit(1001);
  input.remaining(); if (rows.length > 1000 || rows.length !== coverage.count) return;
  const endpointIds: string[] = [], connectionIds: string[] = [], seen = new Set<string>(), authorities: PhotonCoverageAuthority[] = [];
  for (const { endpoint, connection, retained } of rows) {
    input.remaining(); const state = readPhotonExternalState(retained), setup = endpoint.setup;
    if (!state || seen.has(endpoint.id) || setup.step !== "complete" || connection.status !== "active" || !connection.enabled
      || connection.healthStatus === "failed" || connection.transport !== "chat_sdk" || connection.connectionPurpose !== "channel"
      || state.phase !== "external" || state.pending || state.failure || state.localResourceDebt || state.enrollmentCancellation
      || state.identity.companyId !== endpoint.companyId || state.identity.endpointId !== endpoint.id || state.identity.connectionId !== connection.id
      || state.identity.runtimeGeneration !== Reflect.get(setup, "runtimeGeneration") || state.identity.subject !== Reflect.get(setup, "photonExternalSubject")
      || state.identity.credentialReferences !== credentialFingerprint(connection.credentialSecretRefs)
      || state.binding.instanceId !== input.identity.instanceId || state.binding.environment !== input.identity.environment
      || state.localResourceId !== null && (state.localClosureConfirmed !== true || state.localResource?.closed !== true)
      || !photonExternalPhysicalIdle(input.receiverOwner, state)) return;
    authorities.push({ binding: state.binding, handoffId: state.handoffId, subject: state.identity.subject, deliveredThrough: state.acceptedSequence });
    // Normal responsible-user evaluator, same transaction; capability probe never mutates.
    await connectionManagementService(photonIdleReadTransaction(tx, input)).authorize({ type: "board", userId: state.identity.subject, source: "session", ignoreInstanceAdmin: true },
      "connections:configure", { type: "connection_management", companyId: endpoint.companyId, connectionId: connection.id,
        provider: "imessage-photon", purpose: "chat", operation: "chat_endpoints:update", readOnly: true }, { mutation: false, capabilityProbe: true });
    input.remaining(); seen.add(endpoint.id); endpointIds.push(endpoint.id); connectionIds.push(connection.id);
  }
  if (authorities.length !== coverage.count || photonCoverageFingerprint(authorities) !== coverage.bindingsFingerprint) return;
  return { endpointIds, connectionIds };
}
