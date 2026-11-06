import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { issueThreadInteractions } from "@paperclipai/db";
import { and, desc, eq, or, sql } from "drizzle-orm";
import type { RequestConfirmationPayload, RequestConfirmationResult } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

export const AGENT_PROFILE_CHANGE_CONSENT_FIELDS = ["name", "role", "title", "capabilities"] as const;


export const AGENT_PROFILE_AUTHORITY_CONSENT_FIELDS = ["role"] as const;

export function touchesAgentProfileAuthorityConsentFields(patchData: Record<string, unknown>) {
  return AGENT_PROFILE_AUTHORITY_CONSENT_FIELDS.some((key) =>
    Object.prototype.hasOwnProperty.call(patchData, key),
  );
}

export function isAgentProfileChangeTargetKey(targetKey: string) {
  return /^agent:[^:]+:profile$/.test(targetKey);
}

export function consentValuesTouchAuthorityField(
  targetKey: string,
  proposedValues: Record<string, unknown> | null | undefined,
) {
  if (!proposedValues) return false;
  if (!isAgentProfileChangeTargetKey(targetKey)) return false;
  return touchesAgentProfileAuthorityConsentFields(proposedValues);
}

type ConsumedRequestConfirmationResult = RequestConfirmationResult & {
  consumedAt?: string | null;
  consumedByRunId?: string | null;
};

export function agentInstructionsChangeTargetKey(agentId: string) {
  return `agent:${agentId}:instructions`;
}

export function agentProfileChangeTargetKey(agentId: string) {
  return `agent:${agentId}:profile`;
}

export function skillChangeTargetKey(skillId: string) {
  return `skill:${skillId}`;
}

export function skillSlugChangeTargetKey(slug: string) {
  return `skill-slug:${slug}`;
}

export function skillImportChangeTargetKey(source: string) {
  return `skill-import:${source}`;
}

export function skillsScanProjectsChangeTargetKey() {
  return "skills:scan-projects";
}

export function touchesAgentProfileChangeConsentFields(patchData: Record<string, unknown>) {
  return AGENT_PROFILE_CHANGE_CONSENT_FIELDS.some((key) =>
    Object.prototype.hasOwnProperty.call(patchData, key),
  );
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function payloadHasDisplayedDiff(payload: RequestConfirmationPayload) {
  if (cardValueDigest(payload)) return true;
  const details = readNonEmptyString(payload.detailsMarkdown);
  if (!details) return false;
  if (/```diff\b/i.test(details)) return true;
  return /(^|\n)[+-][^\n]+/.test(details);
}

function requestConfirmationResultConsumed(result: RequestConfirmationResult | null) {
  const consumed = result as ConsumedRequestConfirmationResult | null;
  return Boolean(readNonEmptyString(consumed?.consumedByRunId) || readNonEmptyString(consumed?.consumedAt));
}

function markRequestConfirmationResultConsumed(
  result: RequestConfirmationResult,
  actorRunId: string,
  consumedAt: Date,
): ConsumedRequestConfirmationResult {
  return {
    ...result,
    consumedAt: consumedAt.toISOString(),
    consumedByRunId: actorRunId,
  };
}

function legacyTargetKeysFor(targetKey: string) {
  if (targetKey.startsWith("agent:") && targetKey.endsWith(":instructions")) {
    const agentId = targetKey.slice("agent:".length, -":instructions".length);
    if (agentId) return [`reflection-coach:agent-instructions:${agentId}`];
  }
  if (targetKey.startsWith("agent:") && targetKey.endsWith(":profile")) {
    const agentId = targetKey.slice("agent:".length, -":profile".length);
    if (agentId) return [`reflection-coach:agent-description:${agentId}`];
  }
  if (targetKey.startsWith("skill:")) {
    const skillId = targetKey.slice("skill:".length);
    if (skillId) return [`reflection-coach:company-skill:${skillId}`];
  }
  if (targetKey.startsWith("skill-slug:")) {
    const slug = targetKey.slice("skill-slug:".length);
    if (slug) return [`reflection-coach:company-skill-slug:${slug}`];
  }
  if (targetKey.startsWith("skill-import:")) {
    const source = targetKey.slice("skill-import:".length);
    if (source) {
      return [
        `reflection-coach:company-skill-import:${source}`,
        `reflection-coach:company-skill-catalog:${source}`,
      ];
    }
  }
  if (targetKey === "skills:scan-projects") {
    return ["reflection-coach:company-skills:scan-projects"];
  }
  return [];
}

function expandTargetKeysForLegacyCompatibility(targetKeys: string[]) {
  const expanded = new Set<string>();
  for (const targetKey of targetKeys) {
    expanded.add(targetKey);
    for (const legacyTargetKey of legacyTargetKeysFor(targetKey)) {
      expanded.add(legacyTargetKey);
    }
  }
  return [...expanded];
}


export const CONSENT_VALUE_DIGEST_VERSION = 1 as const;

export const CONSENT_VALUE_DIGEST_MAX_CANONICAL_BYTES = 8_000;

export type ConsentValueDigestMode = "enforce" | "warn" | "off";

export function consentValueDigestMode(): ConsentValueDigestMode {
  const raw = process.env.PAPERCLIP_CONSENT_VALUE_DIGEST?.trim().toLowerCase();
  if (raw === "warn") return "warn";
  if (raw === "off") return "off";
  return "enforce";
}

export function isConsentValueDigestTargetKey(targetKey: string) {
  return /^agent:[^:]+:profile$/.test(targetKey);
}

function assertDigestibleConsentValue(value: unknown, path: string): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      throw unprocessable(`Consent value at ${path} must be a finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertDigestibleConsentValue(entry, `${path}[${index}]`));
    return;
  }
  if (kind === "object") {
    const proto = Object.getPrototypeOf(value as object);
    if (proto !== Object.prototype && proto !== null) {
      throw unprocessable(`Consent value at ${path} must be a plain object`);
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      assertDigestibleConsentValue(entry, `${path}.${key}`);
    }
    return;
  }
  throw unprocessable(`Consent value at ${path} is not digestible (${kind})`);
}

function canonicalizeConsentValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalizeConsentValue);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      canonical[key] = canonicalizeConsentValue(entry);
    }
    return canonical;
  }
  return value;
}

export function canonicalizeConsentValues(values: Record<string, unknown>) {
  assertDigestibleConsentValue(values, "values");
  const canonicalJson = JSON.stringify(canonicalizeConsentValue(values));
  if (canonicalJson.length > CONSENT_VALUE_DIGEST_MAX_CANONICAL_BYTES) {
    throw unprocessable(
      `Consent values exceed ${CONSENT_VALUE_DIGEST_MAX_CANONICAL_BYTES} canonical bytes; `
        + "digest the content hash rather than the content",
    );
  }
  return canonicalJson;
}

export function consentValueDigest(targetKey: string, values: Record<string, unknown>) {
  const canonicalJson = canonicalizeConsentValues(values);
  return createHash("sha256")
    .update(`v${CONSENT_VALUE_DIGEST_VERSION}\n${targetKey}\n${canonicalJson}`)
    .digest("hex");
}

export const CONSENT_VALUES_MARKDOWN_HEADING = "#### Exact values this approval authorizes";

export function renderConsentValuesMarkdown(input: {
  targetKey: string;
  values: Record<string, unknown>;
  valueDigest: string;
}) {
  const canonicalJson = canonicalizeConsentValues(input.values);
  return [
    CONSENT_VALUES_MARKDOWN_HEADING,
    "",
    `Accepting this card authorizes **exactly** the end state below for \`${input.targetKey}\`.`,
    "A later write of any other values under this target is refused.",
    "",
    "```json",
    JSON.stringify(JSON.parse(canonicalJson) as unknown, null, 2),
    "```",
    "",
    `<sub>value digest \`${input.valueDigest}\` (v${CONSENT_VALUE_DIGEST_VERSION})</sub>`,
  ].join("\n");
}

type ConsentValueDigestTarget = {
  valueDigest?: string | null;
  digestVersion?: number | null;
};

function cardValueDigest(payload: RequestConfirmationPayload) {
  const target = payload.target as (ConsentValueDigestTarget | null | undefined);
  if (!target) return null;
  if (target.digestVersion !== CONSENT_VALUE_DIGEST_VERSION) return null;
  return readNonEmptyString(target.valueDigest);
}

function consentValueDigestMatches(cardDigest: string | null, expectedDigest: string) {
  if (!cardDigest) return false;
  const card = Buffer.from(cardDigest, "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  if (card.length !== expected.length) return false;
  return timingSafeEqual(card, expected);
}

export function changeConsentGateService(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0]) {
  return {
    assertConsented: async (input: {
      companyId: string;
      actorAgentId: string | null | undefined;
      actorRunId: string | null | undefined;
      targetKeys: string[];
      expectedValueDigest: string | null;
      requiresHumanResolver: boolean;
    }): Promise<boolean> => {
      const actorAgentId = readNonEmptyString(input.actorAgentId);
      if (!actorAgentId) return false;

      const actorRunId = readNonEmptyString(input.actorRunId);
      if (!actorRunId) {
        throw forbidden("Reflection Coach mutations require a run id", {
          code: "reflection_coach_mutation_run_id_required",
        });
      }

      const targetKeys = [...new Set(input.targetKeys.map(readNonEmptyString).filter((key): key is string => Boolean(key)))];
      if (targetKeys.length === 0) {
        throw forbidden("Reflection Coach mutation target is not gateable", {
          code: "reflection_coach_mutation_target_required",
        });
      }
      const queryTargetKeys = expandTargetKeysForLegacyCompatibility(targetKeys);

      const targetKeyPredicate = or(
        ...queryTargetKeys.map((targetKey) =>
          sql`${issueThreadInteractions.payload}->'target'->>'key' = ${targetKey}`,
        ),
      );

      const rows = await db
        .select({
          id: issueThreadInteractions.id,
          sourceRunId: issueThreadInteractions.sourceRunId,
          payload: issueThreadInteractions.payload,
          result: issueThreadInteractions.result,
          effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
          resolvedByUserId: issueThreadInteractions.resolvedByUserId,
          resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.createdByAgentId, actorAgentId),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "accepted"),
          targetKeyPredicate,
        ))
        .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.createdAt))
        .limit(50);

      let candidates = rows.filter((row) => {
        const payload = row.payload as RequestConfirmationPayload;
        const result = row.result as RequestConfirmationResult | null;
        return payload.target?.type === "custom"
          && queryTargetKeys.includes(payload.target.key)
          && result?.outcome === "accepted"
          && !requestConfirmationResultConsumed(result)
          && payloadHasDisplayedDiff(payload)
          && Boolean(row.sourceRunId)
          && row.sourceRunId !== actorRunId;
      });

      if (candidates.length === 0) {
        throw forbidden(
          "Reflection Coach mutations require an accepted request_confirmation with a displayed diff for this target, "
            + "created in a previous run and not already consumed.",
          {
            code: "reflection_coach_mutation_gate_required",
            targetKeys,
          },
        );
      }

      const digestMode = consentValueDigestMode();
      const expectedValueDigest = readNonEmptyString(input.expectedValueDigest);

      const logConsentGateOutcome = async (params: {
        action: string;
        interactionId: string;
        code: string;
        cardValueDigest: string | null;
      }) => {
        try {
          await logActivity(db as Db, {
            companyId: input.companyId,
            actorType: "agent",
            actorId: actorAgentId,
            agentId: actorAgentId,
            runId: actorRunId,
            action: params.action,
            entityType: "issue_thread_interaction",
            entityId: params.interactionId,
            details: {
              code: params.code,
              mode: digestMode,
              targetKeys,
              cardValueDigest: params.cardValueDigest,
              expectedValueDigest: expectedValueDigest ?? null,
            },
          });
        } catch {
        }
      };

      if (input.requiresHumanResolver) {
        const humanResolved = candidates.filter((row) =>
          Boolean(readNonEmptyString(row.resolvedByUserId))
          && !readNonEmptyString(row.resolvedByAgentId),
        );
        if (humanResolved.length === 0) {
          const newest = candidates[0]!;
          await logConsentGateOutcome({
            action: "agent.change_consent_authority_field_denied",
            interactionId: newest.id,
            code: "consent_authority_field_requires_human_resolver",
            cardValueDigest: cardValueDigest(newest.payload as RequestConfirmationPayload),
          });
          throw forbidden(
            "This change sets a field that carries company-level authority "
              + `(${AGENT_PROFILE_AUTHORITY_CONSENT_FIELDS.join(", ")}), so it requires an approval resolved by a person. `
              + "No accepted card for this target was resolved by one. "
              + "Re-raise a request_confirmation and have a human accept it.",
            {
              code: "consent_authority_field_requires_human_resolver",
              targetKeys,
              authorityFields: [...AGENT_PROFILE_AUTHORITY_CONSENT_FIELDS],
              resolvedByAgentId: readNonEmptyString(newest.resolvedByAgentId),
              effectiveResolverPolicy: newest.effectiveResolverPolicy,
            },
          );
        }
        candidates = humanResolved;
      }

      let accepted = expectedValueDigest
        ? candidates.find((row) =>
          consentValueDigestMatches(cardValueDigest(row.payload as RequestConfirmationPayload), expectedValueDigest),
        )
        : undefined;

      if (!accepted) {
        const newest = candidates[0]!;
        const newestCardDigest = cardValueDigest(newest.payload as RequestConfirmationPayload);
        const anyCardCarriesDigest = candidates.some((row) =>
          cardValueDigest(row.payload as RequestConfirmationPayload) !== null,
        );
        const code = !expectedValueDigest || !anyCardCarriesDigest
          ? "consent_value_digest_absent"
          : "consent_value_digest_mismatch";
        const unboundOnBothSides = !expectedValueDigest && !anyCardCarriesDigest;

        if (digestMode === "enforce" && !unboundOnBothSides) {
          await logConsentGateOutcome({
            action: "agent.change_consent_value_digest_denied",
            interactionId: newest.id,
            code,
            cardValueDigest: newestCardDigest,
          });
          throw forbidden(
            code === "consent_value_digest_mismatch"
              ? "This approval was granted for different values than the ones being written. "
                + "Re-raise a request_confirmation showing the current values."
              : "This approval is not bound to the values being written. "
                + "Re-raise a request_confirmation so the approval records exactly what it authorizes.",
            {
              code,
              targetKeys,
              digestVersion: CONSENT_VALUE_DIGEST_VERSION,
              cardValueDigest: newestCardDigest,
              expectedValueDigest: expectedValueDigest ?? null,
            },
          );
        }

        if (digestMode === "warn" && !unboundOnBothSides) {
          await logConsentGateOutcome({
            action: "agent.change_consent_value_digest_warned",
            interactionId: newest.id,
            code,
            cardValueDigest: newestCardDigest,
          });
        }

        accepted = newest;
      }

      const acceptedResult = accepted.result as RequestConfirmationResult | null;
      if (!acceptedResult) {
        throw forbidden(
          "Reflection Coach mutations require an accepted request_confirmation with a displayed diff for this target, "
            + "created in a previous run and not already consumed.",
          {
            code: "reflection_coach_mutation_gate_required",
            targetKeys,
          },
        );
      }

      const now = new Date();
      const [consumed] = await db
        .update(issueThreadInteractions)
        .set({
          result: markRequestConfirmationResultConsumed(acceptedResult, actorRunId, now),
          updatedAt: now,
        })
        .where(and(
          eq(issueThreadInteractions.id, accepted.id),
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.createdByAgentId, actorAgentId),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "accepted"),
          sql`${issueThreadInteractions.result}->>'outcome' = 'accepted'`,
          sql`coalesce(${issueThreadInteractions.result}->>'consumedByRunId', ${issueThreadInteractions.result}->>'consumedAt') is null`,
        ))
        .returning({ id: issueThreadInteractions.id });

      if (!consumed) {
        throw forbidden(
          "Reflection Coach mutations require an accepted request_confirmation with a displayed diff for this target, "
            + "created in a previous run and not already consumed.",
          {
            code: "reflection_coach_mutation_gate_required",
            targetKeys,
          },
        );
      }

      return true;
    },
  };
}
