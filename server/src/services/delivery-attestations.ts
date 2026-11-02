import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { deliveryAttestations, heartbeatRuns, issues, projectWorkspaces, type Db } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

export async function resolveWorkspaceDeliveryTargetFingerprint(
  db: Db,
  input: { companyId: string; projectWorkspaceId: string | null },
): Promise<string | null> {
  if (!input.projectWorkspaceId) return null;
  const [workspace] = await db
    .select({ repoUrl: projectWorkspaces.repoUrl, repoRef: projectWorkspaces.repoRef, companyId: projectWorkspaces.companyId })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.id, input.projectWorkspaceId));
  if (!workspace || workspace.companyId !== input.companyId || !workspace.repoUrl) return null;
  return createHash("sha256").update(`${workspace.repoUrl}@@${workspace.repoRef ?? ""}`).digest("hex");
}

export async function recordDeliveryAttestation(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    outcome: "succeeded" | "failed";
    deliveredRevision?: string | null;
    notes?: string | null;
  },
) {
  const [run] = await db
    .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.issueId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.runId));
  if (!run || run.companyId !== input.companyId || !run.issueId) {
    throw notFound("Heartbeat run not found for this issue");
  }

  const [issue] = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectWorkspaceId: issues.projectWorkspaceId,
      completionRequirement: issues.completionRequirement,
      completionRequirementRevision: issues.completionRequirementRevision,
    })
    .from(issues)
    .where(eq(issues.id, run.issueId));
  if (!issue || issue.companyId !== input.companyId) throw notFound("Issue not found for this run");

  const targetFingerprint =
    input.outcome === "succeeded"
      ? await resolveWorkspaceDeliveryTargetFingerprint(db, { companyId: issue.companyId, projectWorkspaceId: issue.projectWorkspaceId })
      : null;
  if (input.outcome === "succeeded" && !targetFingerprint) {
    throw unprocessable("Issue has no repository-backed delivery target to attest to", {
      code: "delivery_target_not_repository_backed",
    });
  }

  const [existing] = await db
    .select({ id: deliveryAttestations.id })
    .from(deliveryAttestations)
    .where(eq(deliveryAttestations.runId, input.runId));
  if (existing) {
    throw conflict("This run already recorded a delivery attestation", {
      code: "delivery_attestation_already_recorded",
    });
  }

  const [attestation] = await db
    .insert(deliveryAttestations)
    .values({
      companyId: issue.companyId,
      issueId: issue.id,
      runId: input.runId,
      declarationRevision: issue.completionRequirementRevision,
      targetFingerprint: targetFingerprint ?? "",
      outcome: input.outcome,
      deliveredRevision: input.deliveredRevision ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  return attestation;
}

export async function findSucceededAttestation(
  db: Db,
  input: { companyId: string; issueId: string; declarationRevision: number; targetFingerprint: string },
) {
  const [attestation] = await db
    .select()
    .from(deliveryAttestations)
    .where(
      and(
        eq(deliveryAttestations.companyId, input.companyId),
        eq(deliveryAttestations.issueId, input.issueId),
        eq(deliveryAttestations.declarationRevision, input.declarationRevision),
        eq(deliveryAttestations.targetFingerprint, input.targetFingerprint),
        eq(deliveryAttestations.outcome, "succeeded"),
      ),
    )
    .limit(1);
  return attestation ?? null;
}

export async function assertDeliveryAttestationSatisfied(
  db: Db,
  input: { companyId: string; issueId: string; projectWorkspaceId: string | null; completionRequirement: string | null; completionRequirementRevision: number },
) {
  if (input.completionRequirement !== "workspace_delivery") return;

  const targetFingerprint = await resolveWorkspaceDeliveryTargetFingerprint(db, {
    companyId: input.companyId,
    projectWorkspaceId: input.projectWorkspaceId,
  });
  if (!targetFingerprint) {
    throw unprocessable("This issue requires a repository-backed delivery target before it can be completed", {
      code: "delivery_target_not_repository_backed",
    });
  }

  const attestation = await findSucceededAttestation(db, {
    companyId: input.companyId,
    issueId: input.issueId,
    declarationRevision: input.completionRequirementRevision,
    targetFingerprint,
  });
  if (!attestation) {
    throw unprocessable("Delivery attestation is required to complete this issue", {
      code: "delivery_attestation_required",
      completionRequirementRevision: input.completionRequirementRevision,
    });
  }
}
