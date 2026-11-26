import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, managedAgentProfiles } from "@paperclipai/db";

import { conflict, notFound, unprocessable } from "../errors.js";
import {
  assertClaudeManagedQualification,
  assertProfileMetadataContainsNoSecrets,
  CLAUDE_MANAGED_QUALIFIED_MODEL,
  computeQualifiedProfileRevision,
  isQualifiedProfileRevision,
} from "./provider-profile-qualification.js";

export const CLAUDE_MANAGED_BETA_VERSION = "managed-agents-2026-04-01" as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANTHROPIC_AGENT_VERSION_RE = /^[1-9][0-9]*$/;
const ANTHROPIC_AGENT_VERSION_MAX = 2_147_483_647;

export interface ManagedAgentProfileInput {
  profileKey: string;
  displayName: string;
  anthropicAgentId: string;
  agentVersion: string;
  environmentId: string;
  defaultModel: string;
  defaultMaxListCostUsd: number;
  apiKeySecretId: string;
  enabled: boolean;
  retentionAcknowledged: boolean;
  qualification?: Record<string, unknown>;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw unprocessable(`${label} is required`);
  return normalized;
}

function toCents(value: number): number {
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw unprocessable("Managed Agent default spend ceiling must be positive");
  }
  return cents;
}

function requiredUuid(value: string, label: string): string {
  const normalized = required(value, label);
  if (!UUID_RE.test(normalized)) throw unprocessable(`${label} must be a UUID`);
  return normalized;
}

function requiredAgentVersion(value: string): string {
  const normalized = required(value, "Agent version");
  const numeric = Number(normalized);
  if (
    !ANTHROPIC_AGENT_VERSION_RE.test(normalized)
    || !Number.isSafeInteger(numeric)
    || numeric > ANTHROPIC_AGENT_VERSION_MAX
  ) {
    throw unprocessable("Agent version must be a canonical positive 32-bit integer");
  }
  return normalized;
}

interface ManagedAgentProfileRevisionInput {
  anthropicAgentId: string;
  agentVersion: string;
  environmentId: string;
  betaVersion: string;
  retentionAcknowledged: boolean;
  qualification: Record<string, unknown>;
}

export function computeManagedAgentProfileRevision(
  input: ManagedAgentProfileRevisionInput,
): string {
  return computeQualifiedProfileRevision({
    service: "anthropic_managed_agents",
    anthropicAgentId: input.anthropicAgentId,
    agentVersion: input.agentVersion,
    environmentId: input.environmentId,
    betaVersion: input.betaVersion,
    retentionAcknowledged: input.retentionAcknowledged,
    qualification: input.qualification,
  });
}

function assertQualifiedRevisionUnchanged(
  existing: typeof managedAgentProfiles.$inferSelect | null,
  revision: string | null,
): void {
  if (!existing?.qualifiedAt) return;
  if (!revision || existing.qualifiedRevision !== revision) {
    throw conflict("Qualified Managed Agent configuration revision is immutable; create a new profile key");
  }
}

export function managedAgentProfileService(db: Db) {
  async function list(companyId: string) {
    return db
      .select()
      .from(managedAgentProfiles)
      .where(eq(managedAgentProfiles.companyId, companyId))
      .orderBy(asc(managedAgentProfiles.displayName));
  }

  async function get(companyId: string, profileIdOrKey: string) {
    const isUuid = UUID_RE.test(profileIdOrKey);
    const rows = await db
      .select()
      .from(managedAgentProfiles)
      .where(and(
        eq(managedAgentProfiles.companyId, companyId),
        isUuid
          ? eq(managedAgentProfiles.id, profileIdOrKey)
          : eq(managedAgentProfiles.profileKey, profileIdOrKey),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  async function getByProfileKey(companyId: string, profileKey: string) {
    const rows = await db
      .select()
      .from(managedAgentProfiles)
      .where(and(
        eq(managedAgentProfiles.companyId, companyId),
        eq(managedAgentProfiles.profileKey, profileKey),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  async function requireQualified(companyId: string, profileIdOrKey: string) {
    const profile = await get(companyId, profileIdOrKey);
    if (!profile) throw notFound("Managed Agent profile not found");
    if (!profile.enabled || !profile.retentionAcknowledged || !profile.qualifiedAt) {
      throw conflict("Managed Agent profile is not enabled and qualified");
    }
    if (profile.defaultModel !== CLAUDE_MANAGED_QUALIFIED_MODEL) {
      throw conflict("Managed Agent profile model is not qualified");
    }
    try {
      requiredAgentVersion(profile.agentVersion);
    } catch {
      throw conflict("Managed Agent profile version is not qualified");
    }
    try {
      assertClaudeManagedQualification(profile.qualification, { required: true });
    } catch {
      throw conflict("Managed Agent profile qualification attestation is invalid");
    }
    const currentRevision = computeManagedAgentProfileRevision(profile);
    if (
      !isQualifiedProfileRevision(profile.qualifiedRevision)
      || profile.qualifiedRevision !== currentRevision
    ) {
      throw conflict("Managed Agent profile configuration does not match its qualified revision");
    }
    return profile;
  }

  async function upsert(companyId: string, input: ManagedAgentProfileInput) {
    const profileKey = required(input.profileKey, "Profile key");
    if (UUID_RE.test(profileKey)) {
      throw unprocessable("Profile key must not be UUID-shaped");
    }
    const displayName = required(input.displayName, "Display name");
    const anthropicAgentId = required(input.anthropicAgentId, "Anthropic Agent ID");
    const agentVersion = requiredAgentVersion(input.agentVersion);
    const environmentId = required(input.environmentId, "Anthropic Environment ID");
    const defaultModel = required(input.defaultModel, "Default model");
    if (defaultModel !== CLAUDE_MANAGED_QUALIFIED_MODEL) {
      throw unprocessable(`Managed Agent model must be ${CLAUDE_MANAGED_QUALIFIED_MODEL}`);
    }
    const defaultMaxListCostCents = toCents(input.defaultMaxListCostUsd);
    const apiKeySecretId = requiredUuid(input.apiKeySecretId, "Managed Agent API-key secret ID");
    const qualification = structuredClone(input.qualification ?? {});
    assertProfileMetadataContainsNoSecrets({
      profileKey,
      displayName,
      anthropicAgentId,
      agentVersion,
      environmentId,
      defaultModel,
    }, "Managed Agent profile");
    if (input.enabled && !input.retentionAcknowledged) {
      throw unprocessable("Enabling Managed Agents requires the retention acknowledgement");
    }
    const qualificationAttested = assertClaudeManagedQualification(qualification, {
      required: input.enabled,
    });

    const existing = await getByProfileKey(companyId, profileKey);
    const qualifiedRevision = qualificationAttested
      ? computeManagedAgentProfileRevision({
          anthropicAgentId,
          agentVersion,
          environmentId,
          betaVersion: CLAUDE_MANAGED_BETA_VERSION,
          retentionAcknowledged: input.retentionAcknowledged,
          qualification,
        })
      : null;
    assertQualifiedRevisionUnchanged(existing, qualifiedRevision);

    const secret = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.id, apiKeySecretId),
        eq(companySecrets.scope, "company"),
        eq(companySecrets.status, "active"),
      ))
      .limit(1);
    if (!secret[0]) throw unprocessable("Managed Agent API-key secret reference is invalid");

    const values = {
      companyId,
      profileKey,
      displayName,
      service: "anthropic_managed_agents",
      anthropicAgentId,
      agentVersion,
      environmentId,
      betaVersion: CLAUDE_MANAGED_BETA_VERSION,
      defaultModel,
      defaultMaxListCostCents,
      apiKeySecretId,
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
      .insert(managedAgentProfiles)
      .values(values)
      .onConflictDoUpdate({
        target: [managedAgentProfiles.companyId, managedAgentProfiles.profileKey],
        set: values,
      })
      .returning();
    return row!;
  }

  return { list, get, requireQualified, upsert };
}
