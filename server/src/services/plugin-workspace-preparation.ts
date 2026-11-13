import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { executionWorkspaces, type Db } from "@paperclipai/db";
import { readWorkspaceProviderBinding } from "@paperclipai/shared";
import {
  parseWorkspacePrepareResult,
  parseWorkspaceProviderResult,
  workspaceProviderOperationSchema,
  type PluginWorkspaceOperation,
  type PluginWorkspaceParams,
  type PluginWorkspaceResult,
} from "@paperclipai/plugin-sdk";
import { conflict } from "../errors.js";
import { requireWorkspaceProviderWorker, type WorkspaceWorkers } from "./project-workspace-provider.js";
import { WorkspaceProviderFailureError, workspaceProviderCallFailure } from "./workspace-provider-failure.js";

type Workspace = typeof executionWorkspaces.$inferSelect;
type ProviderRequest = Omit<PluginWorkspaceParams, "deadline">;
const legacyWorkspaceOperationMs = 300_000;
const legacyRpcGraceMs = 10_000;

/** No paths or provider credentials are accepted from task callers. */
export async function callWorkspaceProvider(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  input: {
    workspace: Workspace;
    operation: PluginWorkspaceOperation;
    pluginId?: string;
    advanceGeneration?: boolean;
    runId?: string | null;
    agentId?: string | null;
    removalOperationId?: string;
    taskLease?: PluginWorkspaceParams["taskLease"];
    assertOwned?: () => void;
  },
) {
  const { workspace } = input;
  const binding = readWorkspaceProviderBinding(workspace.metadata);
  const pluginId = binding?.pluginId ?? input.pluginId;
  if (!pluginId || !workspace.projectId)
    throw conflict("Workspace storage ownership is missing");
  const selectedProvider = await requireWorkspaceProviderWorker(db, workers, workspace.companyId, pluginId, true);
  const verifyExisting = input.operation.kind === "prepare" && input.operation.verifyExisting === true;
  if (verifyExisting && selectedProvider.manifestJson.workspaceProvider?.workspaceVerificationVersion !== 1)
    throw conflict("Workspace verification is unavailable");
  if (input.operation.kind === "prepare" && input.operation.fresh && selectedProvider.manifestJson.workspaceProvider?.freshWorkspaceVersion !== 1)
    throw conflict("Fresh workspace preparation is unavailable");
  if (input.operation.kind === "finalize" &&
    (selectedProvider.manifestJson.workspaceProvider?.finalizationVersion !== 1 || !input.runId || !input.agentId))
    throw conflict("Workspace finalization is unavailable");
  const generation =
    typeof workspace.metadata?.lifecycleGeneration === "number"
      ? workspace.metadata.lifecycleGeneration
      : 0;
  const operationGeneration = generation + (input.advanceGeneration ? 1 : 0);
  const operation = workspaceProviderOperationSchema.parse(input.operation);
  if (input.removalOperationId !== undefined && (operation.kind !== "remove" ||
    input.removalOperationId !== createHash("sha256").update(JSON.stringify([workspace.id, operationGeneration, operation])).digest("hex")))
    throw conflict("Workspace removal identity does not match its recorded payload");
  if ((operation.kind === "inspect" || operation.kind === "remove") && input.removalOperationId === undefined
    && selectedProvider.manifestJson.workspaceProvider?.recoveryPullRequestVersion !== 1) delete operation.recoveryPullRequest;
  if (operation.kind === "prepare" && operation.fresh && !verifyExisting) {
    if (!workspace.sourceIssueId) throw conflict("Fresh workspace task ownership is missing");
    const { stageProviderFreshWorkspace } = await import("./provider-fresh-workspace.js");
    operation.fresh = await stageProviderFreshWorkspace({ db, companyId: workspace.companyId,
      issueId: workspace.sourceIssueId, ...operation.fresh, existing: operation.fresh });
  }
  const params: ProviderRequest = {
    pluginId,
    companyId: workspace.companyId,
    projectId: workspace.projectId,
    executionWorkspaceId: workspace.id,
    operationId: input.removalOperationId ?? (
      operation.kind === "inspect"
        ? randomUUID()
        : createHash("sha256")
            .update(
              JSON.stringify([workspace.id, operationGeneration, operation,
                ...(operation.kind === "finalize" ? [input.runId, input.agentId] : []),
                ...(input.taskLease ? [input.taskLease.environmentId, input.taskLease.driverKey, input.taskLease.providerLeaseId] : [])]),
            )
            .digest("hex")),
    generation: operationGeneration,
    runId: input.runId ?? null,
    agentId: input.agentId ?? null,
    ...(input.taskLease ? { taskLease: input.taskLease } : {}),
    operation,
  };
  input.assertOwned?.();
  let result: PluginWorkspaceResult;
  try {
    result = await invokeWorkspaceProvider(workers!, params);
  } catch (error) {
    // A worker that never received the call, a lost reply and a provider-reported
    // failure need different recovery; only a closed provider reason crosses over.
    if (error instanceof WorkspaceProviderFailureError) throw error;
    throw workspaceProviderCallFailure(error);
  }
  // Recheck enablement and ownership after an external effect, including an ambiguous retry.
  await requireWorkspaceProviderWorker(db, workers, workspace.companyId, pluginId);
  const [fresh] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.id, workspace.id),
        eq(executionWorkspaces.companyId, workspace.companyId),
      ),
    );
  if (
    !fresh ||
    fresh.status !== workspace.status ||
    (fresh.metadata?.lifecycleGeneration ?? 0) !== generation ||
    fresh.providerRef !== workspace.providerRef
  ) {
    throw conflict("Workspace changed during storage preparation");
  }
  if (result.kind === "prepared" && result.binding.pluginId !== pluginId)
    throw conflict("Workspace provider ownership changed");
  return result;
}

export async function invokeWorkspaceProvider(workers: WorkspaceWorkers, params: ProviderRequest) {
  const verifyExisting = params.operation.kind === "prepare" && params.operation.verifyExisting;
  if (!verifyExisting && params.operation.kind === "prepare" && workers.getWorker(params.pluginId)?.supportedMethods?.includes("workspacePrepare")) {
    const result = await prepareWorkspaceWithPolling(workers, params);
    if (result) return result;
  }
  const timeout = verifyExisting ? 10_000 : params.operation.kind === "finalize" ? 30_000 : legacyWorkspaceOperationMs;
  const request = { ...params, deadline: new Date(Date.now() + timeout).toISOString() };
  return parseWorkspaceProviderResult(request, await workers.call(
    params.pluginId, "workspaceOperation", request, timeout + (verifyExisting ? 2_000 : legacyRpcGraceMs),
  ));
}

async function prepareWorkspaceWithPolling(workers: Pick<WorkspaceWorkers, "call">, params: ProviderRequest) {
  const rpcTimeout = 15_000;
  const submit = { ...params, phase: "submit" as const, deadline: new Date(Date.now() + rpcTimeout).toISOString() };
  const receipt = parseWorkspacePrepareResult(submit, await workers.call(params.pluginId, "workspacePrepare", submit, rpcTimeout));
  if (receipt.kind === "unsupported") return null;
  if (receipt.kind === "prepared") return receipt;
  const offeredMs = Date.parse(receipt.deadline) - Date.now();
  if (offeredMs > legacyWorkspaceOperationMs + legacyRpcGraceMs)
    throw new WorkspaceProviderFailureError({
      kind: "provider", reason: "unsupported_operation", retryable: false,
      message: "Workspace provider offered a deadline outside the supported lifecycle budget",
    });
  const expiresAt = performance.now() + offeredMs;
  const remaining = () => {
    const ms = Math.ceil(expiresAt - performance.now());
    if (ms <= 0) throw new WorkspaceProviderFailureError({
      kind: "provider", reason: "deadline_exceeded", retryable: true,
      message: "Workspace storage operation expired; retry the same workspace",
    });
    return ms;
  };
  const poll = { ...params, phase: "poll" as const, deadline: receipt.deadline };
  for (;;) {
    await delay(Math.min(1000, remaining()));
    const timeout = Math.min(rpcTimeout, remaining());
    let response: unknown;
    try {
      response = await workers.call(params.pluginId, "workspacePrepare", poll, timeout);
    } catch (error) {
      const failure = workspaceProviderCallFailure(error);
      if (failure.kind === "transport" || failure.kind === "timeout") continue;
      throw failure;
    }
    remaining();
    const status = parseWorkspacePrepareResult(poll, response);
    if (status.kind === "prepared") return status;
    if (status.kind === "unsupported" || status.deadline !== receipt.deadline)
      throw new Error("Workspace provider changed the preparation deadline");
  }
}
