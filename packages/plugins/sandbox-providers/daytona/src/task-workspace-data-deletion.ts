import { DaytonaNotFoundError, type Daytona, type Sandbox } from "@daytonaio/sdk";
import type { PluginEnvironmentTaskWorkspaceOwnership, PluginEnvironmentTaskWorkspaceDataDeletionReceipt } from "@paperclipai/plugin-sdk";
import { SERVICE_DATA_DELETION_LABEL } from "./service-data-deletion.js";

export const TASK_WORKSPACE_LABEL = "paperclip-task-workspace-id";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Only provider-created labels establish this receipt. A host-supplied task ID
 * must never relabel an arbitrary retained sandbox during deletion. */
export function daytonaTaskWorkspaceOwnership(sandbox: Sandbox): PluginEnvironmentTaskWorkspaceOwnership | null {
  const executionWorkspaceId = sandbox.labels?.[TASK_WORKSPACE_LABEL];
  const createdByRunId = sandbox.labels?.["paperclip-run-id"];
  if (!executionWorkspaceId || !createdByRunId || !uuid.test(executionWorkspaceId) || !uuid.test(createdByRunId)
    || sandbox.labels?.["paperclip-service-allocation-id"] || sandbox.labels?.["paperclip-purpose"]
    || !sandbox.name || sandbox.name.startsWith("paperclip-service-")) return null;
  return { version: 1, executionWorkspaceId, createdByRunId, sandboxName: sandbox.name };
}

/** Deletes only the reviewed run-created sandbox. Caller freezes the original
 * connection and drains all activity first. Never wakes, replaces or relabels
 * ownership; only the deletion fence may be added. */
export async function deleteDaytonaTaskWorkspaceData(input: {
  client: Pick<Daytona, "get">;
  companyId: string;
  environmentId: string;
  providerLeaseId: string;
  ownership: PluginEnvironmentTaskWorkspaceOwnership;
  deletionId: string;
  timeoutSeconds: number;
}): Promise<PluginEnvironmentTaskWorkspaceDataDeletionReceipt> {
  const expected = input.ownership;
  if (!expected || expected.version !== 1 || ![input.companyId, input.environmentId, input.providerLeaseId, input.deletionId,
    expected.executionWorkspaceId, expected.createdByRunId].every((value) => typeof value === "string" && uuid.test(value))
    || typeof expected.sandboxName !== "string" || !expected.sandboxName || expected.sandboxName.length > 255
    || expected.sandboxName.startsWith("paperclip-service-") || /[\r\n\0]/.test(expected.sandboxName)) throw new Error("Invalid task workspace data deletion identity");
  if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0 || input.timeoutSeconds > 120) throw new Error("Task workspace data deletion requires a bounded timeout");
  const receipt = { providerLeaseId: input.providerLeaseId, executionWorkspaceId: expected.executionWorkspaceId, deletionId: input.deletionId, state: "destroyed" as const };
  const lookup = async () => {
    try { return await input.client.get(input.providerLeaseId); }
    catch (error) { if (error instanceof DaytonaNotFoundError) return null; throw error; }
  };
  const verify = (sandbox: Sandbox) => {
    const actual = daytonaTaskWorkspaceOwnership(sandbox);
    if (sandbox.id !== input.providerLeaseId || sandbox.labels?.["paperclip-provider"] !== "daytona"
      || sandbox.labels?.["paperclip-company-id"] !== input.companyId || sandbox.labels?.["paperclip-environment-id"] !== input.environmentId
      || sandbox.labels?.["paperclip-services-retained"] !== "true" || actual?.executionWorkspaceId !== expected.executionWorkspaceId
      || actual?.createdByRunId !== expected.createdByRunId || actual?.sandboxName !== expected.sandboxName) throw new Error("Task workspace data deletion does not match the owned sandbox");
    const deletion = sandbox.labels[SERVICE_DATA_DELETION_LABEL];
    if (deletion && deletion !== input.deletionId) throw new Error("A different deletion already owns this task workspace");
  };
  const sandbox = await lookup();
  if (!sandbox) return receipt;
  await sandbox.refreshData(); verify(sandbox);
  if (sandbox.state === "destroyed") return receipt;
  if (!sandbox.labels[SERVICE_DATA_DELETION_LABEL]) {
    await sandbox.setLabels({ ...sandbox.labels, [SERVICE_DATA_DELETION_LABEL]: input.deletionId });
    await sandbox.refreshData(); verify(sandbox);
    if (sandbox.labels[SERVICE_DATA_DELETION_LABEL] !== input.deletionId) throw new Error("Task workspace deletion fence was not confirmed");
  }
  let error: unknown;
  try { await sandbox.delete(input.timeoutSeconds, true); } catch (caught) { error = caught; }
  const remaining = await lookup();
  if (!remaining) return receipt;
  await remaining.refreshData(); verify(remaining);
  if (remaining.state === "destroyed") return receipt;
  if (error) throw error;
  throw new Error("Task workspace data deletion has not completed");
}
