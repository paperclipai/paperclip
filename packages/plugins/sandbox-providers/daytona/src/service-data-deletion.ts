import { DaytonaNotFoundError, type Daytona, type Sandbox } from "@daytonaio/sdk";
import type { PluginEnvironmentServiceDataDeletionReceipt } from "@paperclipai/plugin-sdk";

export const SERVICE_DATA_DELETION_LABEL = "paperclip-service-data-deletion-id";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Provider-side fence survives a lost response or worker restart. The host must
 * commit its deletion intent and exclude every service/task writer first. */
export async function deleteDaytonaServiceData(input: {
  client: Pick<Daytona, "get">;
  companyId: string;
  environmentId: string;
  allocationId: string;
  providerLeaseId: string;
  deletionId: string;
  timeoutSeconds: number;
}): Promise<PluginEnvironmentServiceDataDeletionReceipt> {
  if (![input.companyId, input.environmentId, input.allocationId, input.providerLeaseId, input.deletionId].every((id) => uuid.test(id))) {
    throw new Error("Invalid service data deletion identity");
  }
  if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0 || input.timeoutSeconds > 120) {
    throw new Error("Service data deletion requires a bounded timeout");
  }
  const receipt = { providerLeaseId: input.providerLeaseId, serviceAllocationId: input.allocationId, deletionId: input.deletionId, state: "destroyed" as const };
  async function lookup() {
    try { return await input.client.get(input.providerLeaseId); }
    catch (error) { if (error instanceof DaytonaNotFoundError) return null; throw error; }
  }
  function verify(sandbox: Sandbox) {
    const expected = {
      "paperclip-provider": "daytona", "paperclip-company-id": input.companyId,
      "paperclip-environment-id": input.environmentId, "paperclip-purpose": "runtime_service",
      "paperclip-service-allocation-id": input.allocationId, "paperclip-services-retained": "true",
    };
    if (sandbox.id !== input.providerLeaseId || sandbox.name !== `paperclip-service-${input.allocationId}` ||
        Object.entries(expected).some(([key, value]) => sandbox.labels?.[key] !== value)) {
      throw new Error("Service data deletion does not match the owned allocation");
    }
    const existing = sandbox.labels[SERVICE_DATA_DELETION_LABEL];
    if (existing && existing !== input.deletionId) throw new Error("A different deletion already owns this allocation");
  }
  // Never fall back to a reusable name, cached handle, newly created sandbox or
  // another account. The hook verifies the original connection before lookup.
  const sandbox = await lookup();
  if (!sandbox) return receipt;
  await sandbox.refreshData();
  verify(sandbox);
  if (sandbox.state === "destroyed") return receipt;
  if (!sandbox.labels[SERVICE_DATA_DELETION_LABEL]) {
    await sandbox.setLabels({ ...sandbox.labels, [SERVICE_DATA_DELETION_LABEL]: input.deletionId });
    await sandbox.refreshData();
    verify(sandbox);
    if (sandbox.labels[SERVICE_DATA_DELETION_LABEL] !== input.deletionId) throw new Error("Service deletion fence was not confirmed");
  }
  // The SDK defaults to returning when deletion is merely accepted. A receipt
  // requires its destruction wait, followed by fresh provider evidence.
  let deleteError: unknown;
  try { await sandbox.delete(input.timeoutSeconds, true); } catch (error) { deleteError = error; }
  const remaining = await lookup();
  if (!remaining) return receipt;
  await remaining.refreshData();
  verify(remaining);
  if (remaining.state === "destroyed") return receipt;
  if (deleteError) throw deleteError;
  throw new Error("Service data deletion has not completed");
}

/** Call after refreshing ownership metadata and before resuming or executing. */
export function assertDaytonaServiceDataAvailable(sandbox: Sandbox) {
  if (sandbox.labels?.[SERVICE_DATA_DELETION_LABEL]) throw new Error("Service workspace data is being deleted; it cannot be resumed");
}
