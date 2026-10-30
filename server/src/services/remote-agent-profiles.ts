import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { remoteAgentProfiles } from "@paperclipai/db";

import { conflict, notFound, unprocessable } from "../errors.js";
import {
  AGENTCORE_QUALIFIED_MODEL,
  AGENTCORE_QUALIFICATION_SUITE,
  assertAgentCoreQualification,
  assertProfileMetadataContainsNoSecrets,
  computeQualifiedProfileRevision,
  isQualifiedProfileRevision,
} from "./provider-profile-qualification.js";

export { assertProfileMetadataContainsNoSecrets } from "./provider-profile-qualification.js";

export type RemoteAgentService = "aws_bedrock_agentcore_harness";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RemoteAgentProfileInput {
  profileKey: string;
  displayName: string;
  service: RemoteAgentService;
  configuration: Record<string, unknown>;
  enabled: boolean;
  retentionAcknowledged: boolean;
  qualification?: Record<string, unknown>;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unprocessable(`${label} is required`);
  }
  return value.trim();
}

const AGENTCORE_CONFIGURATION_KEYS = new Set([
  "region",
  "accountId",
  "harnessArn",
  "harnessVersion",
  "endpointArn",
  "endpointQualifier",
  "agentRuntimeArn",
  "memoryArn",
  "memoryId",
  "invocationRoleArn",
  "contextBucket",
  "contextPrefix",
  "contextKmsKeyArn",
  "qualificationRevision",
  "defaultModel",
  "eventExpiryDays",
  "defaultMaxEstimatedSessionCostUsd",
]);

function validateConfiguration(service: RemoteAgentService, configuration: Record<string, unknown>) {
  if (service !== "aws_bedrock_agentcore_harness") {
    throw unprocessable("Unsupported remote agent service");
  }
  const requiredKeys = [
    "region",
    "accountId",
    "harnessArn",
    "harnessVersion",
    "endpointArn",
    "endpointQualifier",
    "agentRuntimeArn",
    "memoryArn",
    "memoryId",
    "invocationRoleArn",
    "contextBucket",
    "contextPrefix",
    "contextKmsKeyArn",
    "qualificationRevision",
    "defaultModel",
  ];
  const unknownKeys = Object.keys(configuration).filter((key) => !AGENTCORE_CONFIGURATION_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw unprocessable(`Unsupported configuration field: ${unknownKeys.sort()[0]}`);
  }
  assertProfileMetadataContainsNoSecrets(configuration, "Remote Agent configuration");
  for (const key of requiredKeys) required(configuration[key], `configuration.${key}`);
  if (configuration.eventExpiryDays !== 90) {
    throw unprocessable("AWS AgentCore profile requires a 90-day Memory expiry");
  }
  if (
    configuration.qualificationRevision !== AGENTCORE_QUALIFICATION_SUITE
  ) {
    throw unprocessable("AWS AgentCore profile requires the qualified harness revision");
  }
  if (configuration.defaultModel !== AGENTCORE_QUALIFIED_MODEL) {
    throw unprocessable(`Remote Agent model must be ${AGENTCORE_QUALIFIED_MODEL}`);
  }
  if (
    typeof configuration.defaultMaxEstimatedSessionCostUsd !== "number"
    || !Number.isFinite(configuration.defaultMaxEstimatedSessionCostUsd)
    || configuration.defaultMaxEstimatedSessionCostUsd <= 0
  ) {
    throw unprocessable("AWS AgentCore default estimated spend ceiling must be positive");
  }
}

export function computeRemoteAgentProfileRevision(input: {
  service: RemoteAgentService;
  configuration: Record<string, unknown>;
  retentionAcknowledged: boolean;
  qualification: Record<string, unknown>;
}): string {
  const immutableConfigurationKeys = [
    "region",
    "accountId",
    "harnessArn",
    "harnessVersion",
    "endpointArn",
    "endpointQualifier",
    "agentRuntimeArn",
    "memoryArn",
    "memoryId",
    "invocationRoleArn",
    "contextBucket",
    "contextPrefix",
    "contextKmsKeyArn",
    "qualificationRevision",
    "eventExpiryDays",
  ];
  const immutableConfiguration = Object.fromEntries(
    immutableConfigurationKeys.map((key) => [key, input.configuration[key]]),
  );
  return computeQualifiedProfileRevision({
    service: input.service,
    configuration: immutableConfiguration,
    retentionAcknowledged: input.retentionAcknowledged,
    qualification: input.qualification,
  });
}

function assertQualifiedRevisionUnchanged(
  existing: typeof remoteAgentProfiles.$inferSelect | null,
  revision: string | null,
): void {
  if (!existing?.qualifiedAt) return;
  if (!revision || existing.qualifiedRevision !== revision) {
    throw conflict("Qualified Remote Agent configuration revision is immutable; create a new profile key");
  }
}

export function remoteAgentProfileService(db: Db) {
  async function list(companyId: string, service?: RemoteAgentService) {
    return db
      .select()
      .from(remoteAgentProfiles)
      .where(
        service
          ? and(eq(remoteAgentProfiles.companyId, companyId), eq(remoteAgentProfiles.service, service))
          : eq(remoteAgentProfiles.companyId, companyId),
      )
      .orderBy(asc(remoteAgentProfiles.displayName));
  }

  async function get(companyId: string, profileIdOrKey: string) {
    const isUuid = UUID_RE.test(profileIdOrKey);
    const rows = await db
      .select()
      .from(remoteAgentProfiles)
      .where(and(
        eq(remoteAgentProfiles.companyId, companyId),
        isUuid
          ? eq(remoteAgentProfiles.id, profileIdOrKey)
          : eq(remoteAgentProfiles.profileKey, profileIdOrKey),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  async function getByProfileKey(companyId: string, profileKey: string) {
    const rows = await db
      .select()
      .from(remoteAgentProfiles)
      .where(and(
        eq(remoteAgentProfiles.companyId, companyId),
        eq(remoteAgentProfiles.profileKey, profileKey),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  async function requireQualified(
    companyId: string,
    profileIdOrKey: string,
    service?: RemoteAgentService,
  ) {
    const profile = await get(companyId, profileIdOrKey);
    if (!profile || (service && profile.service !== service)) {
      throw notFound("Remote Agent profile not found");
    }
    if (!profile.enabled || !profile.retentionAcknowledged || !profile.qualifiedAt) {
      throw conflict("Remote Agent profile is not enabled and qualified");
    }
    try {
      validateConfiguration(profile.service as RemoteAgentService, profile.configuration);
    } catch {
      throw conflict("Remote Agent profile configuration is not qualified");
    }
    try {
      assertAgentCoreQualification(profile.configuration, profile.qualification, { required: true });
    } catch {
      throw conflict("Remote Agent profile qualification attestation is invalid");
    }
    const currentRevision = computeRemoteAgentProfileRevision({
      service: profile.service as RemoteAgentService,
      configuration: profile.configuration,
      retentionAcknowledged: profile.retentionAcknowledged,
      qualification: profile.qualification,
    });
    if (
      !isQualifiedProfileRevision(profile.qualifiedRevision)
      || profile.qualifiedRevision !== currentRevision
    ) {
      throw conflict("Remote Agent profile configuration does not match its qualified revision");
    }
    return profile;
  }

  async function upsert(companyId: string, input: RemoteAgentProfileInput) {
    if ("credentialSecretId" in (input as unknown as Record<string, unknown>)) {
      throw unprocessable("AWS AgentCore profiles use workload identity, not a credential secret");
    }
    const profileKey = required(input.profileKey, "Profile key");
    if (UUID_RE.test(profileKey)) {
      throw unprocessable("Profile key must not be UUID-shaped");
    }
    const displayName = required(input.displayName, "Display name");
    const configuration = structuredClone(input.configuration);
    const qualification = structuredClone(input.qualification ?? {});
    assertProfileMetadataContainsNoSecrets(
      { profileKey, displayName },
      "Remote Agent profile",
    );
    validateConfiguration(input.service, configuration);
    if (input.enabled && !input.retentionAcknowledged) {
      throw unprocessable("Enabling a remote agent requires retention acknowledgement");
    }
    const qualificationAttested = assertAgentCoreQualification(
      configuration,
      qualification,
      { required: input.enabled },
    );

    const existing = await getByProfileKey(companyId, profileKey);

    const qualifiedRevision = qualificationAttested
      ? computeRemoteAgentProfileRevision({
          service: input.service,
          configuration,
          retentionAcknowledged: input.retentionAcknowledged,
          qualification,
        })
      : null;
    assertQualifiedRevisionUnchanged(existing, qualifiedRevision);

    const values = {
      companyId,
      profileKey,
      displayName,
      service: input.service,
      configuration,
      enabled: input.enabled,
      retentionAcknowledged: input.retentionAcknowledged,
      qualification,
      qualifiedAt: existing?.qualifiedAt ?? (input.enabled && qualificationAttested ? new Date() : null),
      qualifiedRevision:
        existing?.qualifiedAt || (input.enabled && qualificationAttested)
          ? qualifiedRevision
          : null,
      updatedAt: new Date(),
    } as const;
    const [row] = await db
      .insert(remoteAgentProfiles)
      .values(values)
      .onConflictDoUpdate({
        target: [remoteAgentProfiles.companyId, remoteAgentProfiles.profileKey],
        set: values,
      })
      .returning();
    return row!;
  }

  return { list, get, requireQualified, upsert };
}
