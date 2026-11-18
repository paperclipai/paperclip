import { isDeepStrictEqual } from "node:util";
import { and, eq, gt } from "drizzle-orm";
import { chatEndpoints, chatEndpointLeases, toolConnections, type Db } from "@paperclipai/db";
import type { InternalSetupState } from "../runtime-types.js";
import { credentialFingerprint } from "../credential-fingerprint.js";
import { PhotonState } from "../../photon/state.js";
import { createChatSdkStatePersistence } from "../sdk-state.js";
import { readPhotonExternalState, type PhotonExternalIdentity, type PhotonExternalState } from "./external-contract.js";

export const PHOTON_EXTERNAL_STATE = "external-owner";
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type PhotonExternalLease = { token: string };
export function photonStateFor(db: Pick<Db, "select" | "insert" | "update" | "delete">, identity: Pick<PhotonExternalIdentity, "companyId" | "endpointId">) {
  return new PhotonState(identity, createChatSdkStatePersistence(db));
}
/** All callbacks are SQL-only. Provider I/O and resource joining happen outside. */
export function createPhotonExternalStore(db: Db) {
  async function lock(tx: Transaction, identity: PhotonExternalIdentity) {
    const [endpoint] = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.companyId, identity.companyId), eq(chatEndpoints.id, identity.endpointId))).for("no key update");
    if (!endpoint || endpoint.provider !== "imessage-photon") throw new Error("Photon external endpoint is unavailable");
    return endpoint;
  }
  return {
    async read(identity: Pick<PhotonExternalIdentity, "companyId" | "endpointId">) {
      return readPhotonExternalState(await photonStateFor(db, identity).read(PHOTON_EXTERNAL_STATE));
    },
    async inspect(identity: PhotonExternalIdentity) {
      return db.transaction(async tx => {
        const endpoint = await lock(tx, identity);
        const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.companyId, identity.companyId), eq(toolConnections.id, identity.connectionId))).for("share");
        if (!["active", "verifying", "attention"].includes(endpoint.status) || endpoint.connectionId !== identity.connectionId
          || (endpoint.setup as InternalSetupState).runtimeGeneration !== identity.runtimeGeneration || !connection?.enabled
          || connection.status !== "active" || connection.healthStatus === "failed" || credentialFingerprint(connection.credentialSecretRefs) !== identity.credentialReferences) return null;
        return readPhotonExternalState(await photonStateFor(tx, identity).read(PHOTON_EXTERNAL_STATE));
      });
    },
    async current<T>(identity: PhotonExternalIdentity, lease: PhotonExternalLease, work: (state: PhotonState, current: PhotonExternalState | null) => Promise<T>): Promise<T> {
      return db.transaction(async tx => {
        const endpoint = await lock(tx, identity);
        const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.companyId, identity.companyId), eq(toolConnections.id, identity.connectionId))).for("share");
        const [owner] = await tx.select().from(chatEndpointLeases).where(and(eq(chatEndpointLeases.companyId, identity.companyId),
          eq(chatEndpointLeases.endpointId, identity.endpointId), eq(chatEndpointLeases.leaseKey, "photon_receiver_runtime"),
          eq(chatEndpointLeases.token, lease.token), gt(chatEndpointLeases.expiresAt, new Date()))).for("update");
        if (!owner || !["active", "verifying", "attention"].includes(endpoint.status) || endpoint.connectionId !== identity.connectionId
          || (endpoint.setup as InternalSetupState).runtimeGeneration !== identity.runtimeGeneration || !connection?.enabled || connection.status !== "active" || connection.healthStatus === "failed"
          || credentialFingerprint(connection.credentialSecretRefs) !== identity.credentialReferences)
          throw new Error("Photon external current authority changed");
        const state = photonStateFor(tx, identity), current = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
        if (current && current.phase !== "retired" && !isDeepStrictEqual(current.identity, identity)) throw new Error("Photon prior owner must finish retirement");
        return work(state, current);
      });
    },
    async noEffect(expected: PhotonExternalState, sequence: number) {
      return db.transaction(async tx => {
        const endpoint = await lock(tx, expected.identity);
        const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.companyId, expected.identity.companyId), eq(toolConnections.id, endpoint.connectionId))).for("share");
        const superseded = !["active", "verifying", "attention"].includes(endpoint.status)
          || endpoint.connectionId !== expected.identity.connectionId || (endpoint.setup as InternalSetupState).runtimeGeneration !== expected.identity.runtimeGeneration
          || !connection?.enabled || connection.status !== "active" || connection.healthStatus === "failed" || credentialFingerprint(connection.credentialSecretRefs) !== expected.identity.credentialReferences;
        if (!superseded || expected.phase !== "retiring") throw new Error("Photon no-effect requires actual current revocation");
        const updated = await photonStateFor(tx, expected.identity).update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, raw => {
          const current = readPhotonExternalState(raw);
          if (!current || !isDeepStrictEqual(current.binding, expected.binding) || current.phase !== "retiring") throw new Error("Photon no-effect owner changed");
          return { ...current, acceptedSequence: Math.max(current.acceptedSequence ?? -1, sequence), pending: null };
        });
        return updated;
      });
    },
    /** Preserve an already accepted broker/resource result even if configure won.
     * This cannot activate or grant use: it only replaces the exact retained intent. */
    async retained(expected: PhotonExternalState, update: (state: PhotonExternalState) => PhotonExternalState, after?: (tx: Transaction) => Promise<void>) {
      return db.transaction(async tx => {
        await lock(tx, expected.identity);
        const updated = await photonStateFor(tx, expected.identity).update<PhotonExternalState>(PHOTON_EXTERNAL_STATE, raw => {
          const current = readPhotonExternalState(raw);
          if (!current || !isDeepStrictEqual(current, expected)) throw new Error("Photon retained intent changed concurrently");
          const next = update(current);
          if (!isDeepStrictEqual(next.identity, current.identity) || !isDeepStrictEqual(next.binding, current.binding)
            || next.handoffId !== current.handoffId || next.localResourceId !== current.localResourceId
            || next.initialSequence !== current.initialSequence || next.phase === "external" && current.phase !== "external")
            throw new Error("Photon retained update cannot change authority");
          if (!isDeepStrictEqual(next.businessHandoff, current.businessHandoff)
            || current.localClosureConfirmed === true && next.localClosureConfirmed !== true
            || !isDeepStrictEqual(next.localResource ? { ...next.localResource, closed: false } : undefined,
              current.localResource ? { ...current.localResource, closed: false } : undefined)
            || current.localResource?.closed === true && next.localResource?.closed !== true)
            throw new Error("Photon retained cleanup cannot rewrite business or allocation identity");
          // Cleanup may confirm the SAME sender only. New allocation identity
          // is installed exclusively through current company/credential/lease CAS.
          if (!isDeepStrictEqual(next.senderResource ? { ...next.senderResource, closed: false } : undefined,
              current.senderResource ? { ...current.senderResource, closed: false } : undefined)
            || current.senderResource?.closed === true && next.senderResource?.closed !== true)
            throw new Error("Photon retained cleanup cannot replace sender ownership");
          const parsed = readPhotonExternalState(next);
          if (!parsed) throw new Error("Photon retained result disappeared");
          return parsed;
        });
        await after?.(tx);
        return updated;
      });
    },
  };
}
export type PhotonExternalStore = ReturnType<typeof createPhotonExternalStore>;
