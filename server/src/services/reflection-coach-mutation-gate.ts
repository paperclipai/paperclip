import type { Db } from "@paperclipai/db";
import { agents, issueThreadInteractions } from "@paperclipai/db";
import { and, desc, eq, or, sql } from "drizzle-orm";
import type { RequestConfirmationPayload, RequestConfirmationResult } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";

export function reflectionCoachAgentInstructionsTargetKey(agentId: string) {
  return `reflection-coach:agent-instructions:${agentId}`;
}

export function reflectionCoachAgentDescriptionTargetKey(agentId: string) {
  return `reflection-coach:agent-description:${agentId}`;
}

export function reflectionCoachCompanySkillTargetKey(skillId: string) {
  return `reflection-coach:company-skill:${skillId}`;
}

export function reflectionCoachCompanySkillSlugTargetKey(slug: string) {
  return `reflection-coach:company-skill-slug:${slug}`;
}

export function reflectionCoachCompanySkillImportTargetKey(source: string) {
  return `reflection-coach:company-skill-import:${source}`;
}

export function reflectionCoachCompanySkillCatalogTargetKey(catalogSkillId: string) {
  return `reflection-coach:company-skill-catalog:${catalogSkillId}`;
}

export function reflectionCoachCompanySkillScanTargetKey() {
  return "reflection-coach:company-skills:scan-projects";
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function payloadHasDisplayedDiff(payload: RequestConfirmationPayload) {
  const details = readNonEmptyString(payload.detailsMarkdown);
  if (!details) return false;
  if (/```diff\b/i.test(details)) return true;
  return /(^|\n)[+-][^\n]+/.test(details);
}

export function reflectionCoachMutationGateService(db: Db) {
  return {
    assertAllowed: async (input: {
      companyId: string;
      actorAgentId: string | null | undefined;
      actorRunId: string | null | undefined;
      targetKeys: string[];
    }): Promise<boolean> => {
      const actorAgentId = readNonEmptyString(input.actorAgentId);
      if (!actorAgentId) return false;

      const actorAgent = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          metadata: agents.metadata,
        })
        .from(agents)
        .where(eq(agents.id, actorAgentId))
        .then((rows) => rows[0] ?? null);

      if (!actorAgent || actorAgent.companyId !== input.companyId) {
        throw forbidden("Agent key cannot access another company");
      }

      const marker = readBuiltInAgentMarker(actorAgent.metadata);
      if (marker?.key !== "reflection-coach") return false;

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

      const targetKeyPredicate = or(
        ...targetKeys.map((targetKey) =>
          sql`${issueThreadInteractions.payload}->'target'->>'key' = ${targetKey}`,
        ),
      );

      const rows = await db
        .select({
          id: issueThreadInteractions.id,
          sourceRunId: issueThreadInteractions.sourceRunId,
          payload: issueThreadInteractions.payload,
          result: issueThreadInteractions.result,
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
        .limit(10);

      const accepted = rows.find((row) => {
        const payload = row.payload as RequestConfirmationPayload;
        const result = row.result as RequestConfirmationResult | null;
        return payload.target?.type === "custom"
          && targetKeys.includes(payload.target.key)
          && result?.outcome === "accepted"
          && payloadHasDisplayedDiff(payload)
          && Boolean(row.sourceRunId)
          && row.sourceRunId !== actorRunId;
      });

      if (!accepted) {
        throw forbidden(
          "Reflection Coach mutations require an accepted request_confirmation with a displayed diff for this target, "
            + "created in a previous run.",
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
