import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { completionContracts, heartbeatRuns } from "@paperclipai/db";

import { ensureNativeCompletionContract } from "./completion-contracts.js";
import { NATIVE_RUNTIME_RESOLVER_VERSION } from "./runtime-mode.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function contractBinding(
  contractJson: unknown,
  persistedRevision: number,
): { revision: string; criterionIds: string[] } {
  const contract = record(contractJson);
  const revision = typeof contract.revision === "string" ? contract.revision : "";
  const criteria = Array.isArray(contract.criteria) ? contract.criteria : [];
  const criterionIds = criteria
    .map((criterion) => record(criterion).id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (
    (revision && revision !== String(persistedRevision))
    || criterionIds.length === 0
    || criterionIds.length !== criteria.length
  ) {
    throw new Error("native_completion_contract_binding_invalid");
  }
  return { revision: String(persistedRevision), criterionIds };
}

export async function prepareNativeHeartbeatRun(input: {
  db: Db;
  run: {
    id: string;
    companyId: string;
    agentId: string;
    runtimeMode: string | null;
    runtimeModeResolvedAt: Date | null;
    runnerProfileJson: Record<string, unknown> | null;
    runnerInstanceId: string | null;
    nativeSessionId: string | null;
    nativeIssueId: string | null;
    completionContractId: string | null;
    completionContractSha256: string | null;
  };
  issue: {
    id: string;
    title: string;
    description: string | null;
    reviewPolicy?: string | null;
  };
  environmentLeaseId: string;
}) {
  if (input.run.runtimeModeResolvedAt && input.run.runtimeMode !== "native") {
    throw new Error("native_runtime_mode_conflict");
  }
  const persistedProfile = record(input.run.runnerProfileJson);
  const runnerInstanceId = input.run.runnerInstanceId ?? randomUUID();
  const normalizedSessionId = input.run.nativeSessionId ?? randomUUID();
  const turnId = typeof persistedProfile.turnId === "string"
    ? persistedProfile.turnId
    : randomUUID();
  const itemId = typeof persistedProfile.itemId === "string"
    ? persistedProfile.itemId
    : randomUUID();
  const environmentLeaseId = typeof persistedProfile.environmentLeaseId === "string"
    ? persistedProfile.environmentLeaseId
    : input.environmentLeaseId;

  const persistedContract = input.run.completionContractId
    ? await input.db
      .select()
      .from(completionContracts)
      .where(and(
        eq(completionContracts.id, input.run.completionContractId),
        eq(completionContracts.companyId, input.run.companyId),
        eq(completionContracts.issueId, input.issue.id),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : null;
  const completion = persistedContract
    ? { row: persistedContract, contract: persistedContract.contractJson }
    : await ensureNativeCompletionContract({
      db: input.db,
      companyId: input.run.companyId,
      issue: input.issue,
      actorId: input.run.agentId,
    });
  const binding = contractBinding(completion.contract, completion.row.revision);

  await input.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.run.id))
      .for("update")
      .limit(1);
    if (!locked) throw new Error("native_runtime_run_missing");
    if (locked.runtimeModeResolvedAt && locked.runtimeMode !== "native") {
      throw new Error("native_runtime_mode_conflict");
    }
    if (
      locked.runtimeModeResolvedAt
      && (
        locked.runnerInstanceId !== runnerInstanceId
        || locked.nativeSessionId !== normalizedSessionId
        || locked.nativeIssueId !== input.issue.id
        || locked.completionContractId !== completion.row.id
      )
    ) {
      throw new Error("native_runtime_binding_conflict");
    }
    await tx
      .update(heartbeatRuns)
      .set({
        runtimeMode: "native",
        runtimeModeResolverVersion:
          locked.runtimeModeResolverVersion ?? NATIVE_RUNTIME_RESOLVER_VERSION,
        runtimeModeReason: locked.runtimeModeReason ?? "explicit_paperclip_runner",
        runtimeModeResolvedAt: locked.runtimeModeResolvedAt ?? new Date(),
        runnerProfileJson: {
          schema: "paperclip.runner.profile.v1",
          provider: "codex",
          turnId,
          itemId,
          environmentLeaseId,
        },
        runnerInstanceId,
        nativeSessionId: normalizedSessionId,
        nativeIssueId: input.issue.id,
        driverKind: "codex",
        driverVersion: "codex-app-server-v1",
        completionContractId: completion.row.id,
        completionContractSha256: completion.row.canonicalSha256,
        nativePhase: "provider_running",
        nativePhaseUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, input.run.id));
  });

  return {
    runnerInstanceId,
    normalizedSessionId,
    turnId,
    itemId,
    environmentLeaseId,
    completionContract: binding,
  };
}
