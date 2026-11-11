import { setTimeout as delay } from "node:timers/promises";
import { parseWorkspacePrepareResult, parseWorkspaceProviderResult, type PluginWorkspaceParams } from "@paperclipai/plugin-sdk";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { WorkspaceProviderFailureError, workspaceProviderCallFailure } from "./workspace-provider-failure.js";

type ProviderRequest = Omit<PluginWorkspaceParams, "deadline">;
type WorkspaceWorker = Pick<PluginWorkerManager, "call" | "getWorker">;

export async function invokeWorkspaceProvider(workers: WorkspaceWorker, params: ProviderRequest) {
  const verifyExisting = params.operation.kind === "prepare" && params.operation.verifyExisting;
  if (!verifyExisting && params.operation.kind === "prepare" && workers.getWorker(params.pluginId)?.supportedMethods?.includes("workspacePrepare")) {
    const result = await prepareWorkspaceWithPolling(workers, params);
    if (result) return result;
  }
  // Compatibility for providers without asynchronous preparation.
  const timeout = verifyExisting ? 10_000 : params.operation.kind === "finalize" ? 30_000 : 300_000;
  const request = { ...params, deadline: new Date(Date.now() + timeout).toISOString() };
  return parseWorkspaceProviderResult(request, await workers.call(
    params.pluginId, "workspaceOperation", request, timeout + (verifyExisting ? 2_000 : 10_000),
  ));
}

async function prepareWorkspaceWithPolling(workers: Pick<PluginWorkerManager, "call">, params: ProviderRequest) {
  const rpcTimeout = 15_000; // Transport bound. The provider selects the operation deadline.
  const submit = { ...params, phase: "submit" as const, deadline: new Date(Date.now() + rpcTimeout).toISOString() };
  const receipt = parseWorkspacePrepareResult(submit, await workers.call(params.pluginId, "workspacePrepare", submit, rpcTimeout));
  if (receipt.kind === "unsupported") return null;
  if (receipt.kind === "prepared") return receipt;
  const expiresAt = Date.parse(receipt.deadline);
  const remaining = () => {
    const ms = expiresAt - Date.now();
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
