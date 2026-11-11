import { and, asc, eq, gt, sql } from "drizzle-orm";
import { chatEndpoints, chatSdkState, toolConnections, type Db } from "@paperclipai/db";
import { HttpError, conflict } from "../../../errors.js";
import type { ConnectionManagementContext } from "../../connection-management.js";
import { readPhotonExternalState } from "./external-contract.js";
import { PHOTON_EXTERNAL_STATE } from "./external-store.js";

import type { EndpointRecord } from "../runtime-types.js";
import type { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";
import type { createChatConfiguration } from "../configuration.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RemovalOwner = {
  remove<T>(endpointId: string, after: () => Promise<T>, actorUserId?: string | null,
    management?: ConnectionManagementContext): Promise<T>;
};
const owners = new WeakMap<Db, RemovalOwner>();
const pending = () => conflict("Photon retirement must settle before removal", { code: "photon_retirement_pending" });

/** Registration belongs to the normal chat service, never a second cleanup service. */
export function registerPhotonRemovalOwner(db: Db, owner: RemovalOwner) {
  owners.set(db, owner);
  return () => { if (owners.get(db) === owner) owners.delete(db); };
}

/** Same transaction-scoped key on create and destructive cleanup; no provider I/O. */
export async function lockPhotonCompanyMutation(tx: Transaction, companyId: string, provider?: string) {
  if (provider !== undefined && provider !== "imessage-photon") return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`photon-company:${companyId}`}, 0))`);
}

export async function assertPhotonCompanyRetired(tx: Transaction, companyId: string) {
  await lockPhotonCompanyMutation(tx, companyId);
  const endpoints = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.companyId, companyId),
    eq(chatEndpoints.provider, "imessage-photon"))).orderBy(asc(chatEndpoints.id)).for("update");
  for (const endpoint of endpoints) await assertEndpointRetired(tx, endpoint);
}

async function assertEndpointRetired(tx: Transaction, endpoint: typeof chatEndpoints.$inferSelect) {
  const companyId = endpoint.companyId;
  const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId),
    eq(toolConnections.id, endpoint.connectionId))).for("update");
  const [row] = await tx.select().from(chatSdkState).where(and(eq(chatSdkState.companyId, companyId),
    eq(chatSdkState.endpointId, endpoint.id), eq(chatSdkState.stateKey, PHOTON_EXTERNAL_STATE))).for("update");
  let state;
  try { state = readPhotonExternalState(row?.value ?? null); } catch { throw pending(); }
  if (endpoint.status !== "archived" || !connection || connection.enabled || connection.status !== "archived"
    || connection.credentialSecretRefs.length !== 0
    || state && (state.identity.companyId !== companyId || state.identity.endpointId !== endpoint.id
      || state.identity.connectionId !== connection.id || state.phase !== "retired" || state.pending !== null || state.failure !== null
      || state.localResourceId !== null && state.localClosureConfirmed !== true
      || state.senderResource && !state.senderResource.closed)) throw pending();
}

/** Before agent termination or destructive SQL: keep consumer and credentials alive on 409. */
export async function preparePhotonCompanyDeletion(db: Db, companyId: string) {
  let cursor: string | undefined;
  while (true) {
    const endpoints = await db.select({ id: chatEndpoints.id }).from(chatEndpoints).where(and(
      eq(chatEndpoints.companyId, companyId), eq(chatEndpoints.provider, "imessage-photon"),
      cursor === undefined ? undefined : gt(chatEndpoints.id, cursor))).orderBy(asc(chatEndpoints.id)).limit(100);
    if (!endpoints.length) return;
    const owner = owners.get(db);
    if (!owner) throw pending();
    for (const endpoint of endpoints) await owner.remove(endpoint.id, async () => undefined);
    cursor = endpoints[endpoints.length - 1]!.id;
  }
}

/** Opaque generic connection-removal boundary; normal actor checks remain with its caller. */
export async function withPhotonConnectionRetirement<T>(db: Db, connectionId: string, companyId: string,
  after: () => Promise<T>, actorUserId?: string | null, management?: ConnectionManagementContext,
): Promise<{ handled: false } | { handled: true; value: T }> {
  const [endpoint] = await db.select({ id: chatEndpoints.id }).from(chatEndpoints).where(and(
    eq(chatEndpoints.companyId, companyId), eq(chatEndpoints.connectionId, connectionId),
    eq(chatEndpoints.provider, "imessage-photon")));
  if (!endpoint) return { handled: false };
  const owner = owners.get(db);
  if (!owner) throw pending();
  return { handled: true, value: await owner.remove(endpoint.id, after, actorUserId, management) };
}

export function createPhotonRemovalDelegate(db: Db, options: {
  endpointRecord(endpointId: string): Promise<EndpointRecord | null>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  configureWithCredentialLease: ReturnType<typeof createChatConfiguration>["configureWithCredentialLease"];
  available(): boolean;
}): RemovalOwner {
  return {
    async remove(endpointId, after, actorUserId, management) {
      if (!options.available()) throw pending();
      await management?.reauthorize();
      const record = await options.endpointRecord(endpointId);
      if (!record || record.endpoint.provider !== "imessage-photon") throw pending();
      return options.withCredentialMutationLease(record.endpoint, async lease => {
        try {
          await options.configureWithCredentialLease(endpointId, { action: "remove" }, lease, actorUserId, management);
        } catch (error) {
          // Normal repeated removal has already run provider cleanup before this conflict.
          if (!(error instanceof HttpError) || error.status !== 409 || !error.details
            || typeof error.details !== "object" || !("code" in error.details)
            || error.details.code !== "chat_endpoint_already_removed") {
            if (error instanceof HttpError) throw error;
            throw Object.assign(pending(), { cause: error });
          }
        }
        await lease.assertOwned();
        // A repeated-remove conflict is not itself settlement evidence. Recheck
        // the exact endpoint and retained obligations before generic secret work.
        await db.transaction(async tx => {
          await lockPhotonCompanyMutation(tx, record.endpoint.companyId);
          const [current] = await tx.select().from(chatEndpoints).where(and(
            eq(chatEndpoints.companyId, record.endpoint.companyId), eq(chatEndpoints.id, endpointId))).for("update");
          if (!current || current.provider !== "imessage-photon") throw pending();
          await assertEndpointRetired(tx, current);
          await lease.assertOwned(tx);
        });
        await management?.reauthorize();
        return after();
      });
    },
  };
}
