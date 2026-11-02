import type { createPhotonCredentialChecks } from "./credentials.js";

import type { EndpointRow } from "../runtime-types.js";

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
  async function persistPhotonConfiguration(endpoint: EndpointRow, credentials: Record<string, string>, credentialLease: CredentialMutationLeaseGuard) {
      await invalidateRuntime(endpoint.id);
      await credentialLease.assertOwned();
      if (credentials.allocation === "shared") await db.update(chatEndpoints).set({ allowGroupChats: false }).where(eq(chatEndpoints.id, endpoint.id));
      await db.update(toolConnections).set({ config: { provider: endpoint.provider, photon: credentials.allocation === "shared" ? { allocation: "shared", projectId: credentials.projectId } : { allocation: "dedicated", projectId: credentials.projectId, lineId: credentials.lineId } } }).where(and(eq(toolConnections.companyId, endpoint.companyId), eq(toolConnections.id, endpoint.connectionId)));
    }
  return { persistPhotonConfiguration };
}
