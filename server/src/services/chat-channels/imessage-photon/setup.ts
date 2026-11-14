import { credentialFingerprint } from "../credential-fingerprint.js";
import { PhotonState } from "../../photon/state.js";
import { createChatSdkStatePersistence } from "../sdk-state.js";
import { preparePhotonCheckpointConfiguration, carryPhotonCheckpointConfiguration } from "./external-owner.js";
import type { createPhotonCredentialChecks } from "./credentials.js";

import type { EndpointRow, InternalSetupState } from "../runtime-types.js";

import { type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import { photonSharedScope, photonSharedIdentity } from "../../photon/cloud.js";
import { photonChannelConfigurationSchema } from "@paperclipai/shared";

import {
  and,
  eq,
  ne,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatEndpoints,
  toolConnections,
} from "@paperclipai/db";
import type {
  ConfigureChatEndpointInput,
} from "@paperclipai/shared";

import {
  conflict,
  notFound,
} from "../../../errors.js";

import type { EndpointRecord } from "../runtime-types.js";

/** Current endpoint policy, shared by local receiver construction and callback admission. */
export function photonIntakeAfter(endpoint: Pick<EndpointRow, "setup" | "createdAt">): number {
  return Date.parse(String((endpoint.setup as InternalSetupState).photonIntakeAfter
    ?? endpoint.setup.testStartedAt ?? endpoint.createdAt.toISOString()));
}

type PhotonSetupInspectionOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  inspectPhotonCredentials: ReturnType<typeof createPhotonCredentialChecks>["inspectPhotonCredentials"];
};
export function createPhotonSetupInspection(db: Db, options: PhotonSetupInspectionOptions) {
  const { endpointRecord, inspectPhotonCredentials } = options;


  async function inspectPhoton(
    endpointId: string,
    input: { projectId: string; projectSecret: string },
  ) {
    const record = await endpointRecord(endpointId);
    if (!record || record.endpoint.provider !== "imessage-photon")
      throw notFound("iMessage Photon endpoint not found");
    const inspection = structuredClone(await inspectPhotonCredentials(
      input.projectId,
      input.projectSecret,
    ));
    const reserved = await db
      .select({ number: chatEndpoints.botExternalId })
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.provider, "imessage-photon"),
          ne(chatEndpoints.id, endpointId),
          ne(chatEndpoints.status, "archived"),
        ),
      );
    for (const line of inspection.lines) {
      if (reserved.some((row) => row.number === line.phoneNumber)) {
        line.eligible = false;
        line.unavailableReason =
          "This number already belongs to another channel";
      }
    }
    inspection.eligible = inspection.allocation === "shared" ? inspection.eligible && !reserved.some((row) => row.number === photonSharedIdentity(inspection.projectId)) : inspection.lines.some((line) => line.eligible);
    return inspection;
  }
  return { inspectPhoton };
}
export function preparePhotonConfiguration(endpoint: EndpointRow, input: ConfigureChatEndpointInput, credentials: Record<string, string>): Record<string, string> {
      const configuration = photonChannelConfigurationSchema.parse(input.photon ?? (credentials.allocation === "shared" ? { allocation: "shared", projectId: credentials.projectId } : { projectId: credentials.projectId, lineId: credentials.lineId }));
      const lineId = configuration.allocation === "shared" ? photonSharedScope(configuration.projectId) : configuration.lineId;
      if (endpoint.botExternalId && (configuration.projectId !== endpoint.providerAccountId || credentials.lineId && lineId !== credentials.lineId)) throw conflict("A different Photon identity requires a new channel");
      return { ...credentials, ...configuration, lineId };
    }

export function createPhotonConfiguration(db: Db, options: { invalidateRuntime: (endpointId: string) => Promise<boolean> }) {
  const { invalidateRuntime } = options;
  async function persistPhotonConfiguration(record: EndpointRecord, credentials: Record<string, string>, credentialLease: CredentialMutationLeaseGuard) {
       const endpoint = record.endpoint;
      await invalidateRuntime(endpoint.id);
       await credentialLease.assertOwned();
       const identity = { companyId: endpoint.companyId, endpointId: endpoint.id, connectionId: endpoint.connectionId,
         runtimeGeneration: Number((endpoint.setup as InternalSetupState).runtimeGeneration ?? 0),
         credentialReferences: credentialFingerprint(record.credentialSecretRefs) };
       const readCurrent = async (tx: Db) => {
         await credentialLease.assertOwned(tx);
         const [current] = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.companyId, endpoint.companyId),
           eq(chatEndpoints.id, endpoint.id))).for("no key update", { skipLocked: true });
         const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.companyId, endpoint.companyId),
           eq(toolConnections.id, endpoint.connectionId))).for("share");
         if (!current || !connection || current.provider !== "imessage-photon" || current.connectionId !== endpoint.connectionId
           || Number((current.setup as InternalSetupState).runtimeGeneration ?? 0) !== identity.runtimeGeneration)
           throw conflict("Photon reconnect configuration owner changed");
         return { current, connection };
       };
       const prepared = await db.transaction(async tx => {
         const { connection } = await readCurrent(tx as unknown as Db);
         if (credentialFingerprint(connection.credentialSecretRefs) !== identity.credentialReferences)
           throw conflict("Photon reconnect credentials changed before checkpoint preparation");
         const state = new PhotonState({ companyId: endpoint.companyId, endpointId: endpoint.id }, createChatSdkStatePersistence(tx));
         const checkpoint = await preparePhotonCheckpointConfiguration(state, identity, credentials.lineId);
         if (!checkpoint) return null;
         const previous = photonChannelConfigurationSchema.safeParse(connection.config.photon);
         const previousLine = previous.success ? previous.data.allocation === "shared" ? photonSharedScope(previous.data.projectId) : previous.data.lineId : null;
         if (!previous.success || previous.data.projectId !== credentials.projectId || previousLine !== credentials.lineId
           || previous.data.allocation !== (credentials.allocation ?? "dedicated"))
           throw conflict("Photon reconnect checkpoint requires the same verified provider line");
         return checkpoint;
       });
       if (credentials.allocation === "shared") await db.update(chatEndpoints).set({ allowGroupChats: false }).where(eq(chatEndpoints.id, endpoint.id));
      await db.update(toolConnections).set({ config: { provider: endpoint.provider, photon: credentials.allocation === "shared" ? { allocation: "shared", projectId: credentials.projectId } : { allocation: "dedicated", projectId: credentials.projectId, lineId: credentials.lineId } } }).where(and(eq(toolConnections.companyId, endpoint.companyId), eq(toolConnections.id, endpoint.connectionId)));
       if (!prepared) return undefined;
       const currentConfiguration = async (tx: Db) => {
         const current = await readCurrent(tx);
         const configured = photonChannelConfigurationSchema.parse(current.connection.config.photon);
         const configuredLine = configured.allocation === "shared" ? photonSharedScope(configured.projectId) : configured.lineId;
         if (configured.projectId !== credentials.projectId || configuredLine !== credentials.lineId
           || configured.allocation !== (credentials.allocation ?? "dedicated")) throw conflict("Photon reconnect provider line changed before commit");
         return current;
       };
       return {
         async credentialsCommitted(tx: Db) {
           const { connection } = await currentConfiguration(tx);
           const state = new PhotonState({ companyId: endpoint.companyId, endpointId: endpoint.id }, createChatSdkStatePersistence(tx));
           await carryPhotonCheckpointConfiguration(state, prepared, { ...identity,
             credentialReferences: credentialFingerprint(connection.credentialSecretRefs) }, credentials.lineId, "credentials");
           await credentialLease.assertOwned(tx);
         },
         async commit(tx: Db, nextGeneration: number, expectedCredentialRefs: EndpointRecord["credentialSecretRefs"]) {
           const { connection } = await currentConfiguration(tx);
           const credentialReferences = credentialFingerprint(expectedCredentialRefs);
           if (credentialFingerprint(connection.credentialSecretRefs) !== credentialReferences)
             throw conflict("Photon reconnect credential writer result changed before commit");
           if (nextGeneration !== identity.runtimeGeneration + 1) throw conflict("Photon reconnect generation changed");
           const committed = { ...prepared, identity: { ...prepared.identity, credentialReferences },
             authority: { ...prepared.authority, credentialReferences } };
           const state = new PhotonState({ companyId: endpoint.companyId, endpointId: endpoint.id }, createChatSdkStatePersistence(tx));
           await carryPhotonCheckpointConfiguration(state, committed, { ...identity, runtimeGeneration: nextGeneration,
             credentialReferences }, credentials.lineId, "generation");
           await credentialLease.assertOwned(tx);
         },
       };
    }
  return { persistPhotonConfiguration };
}
