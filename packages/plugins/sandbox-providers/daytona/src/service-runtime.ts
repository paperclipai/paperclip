import type { Sandbox } from "@daytonaio/sdk";
import { runtimeServiceRemoteControlSource, runtimeServiceStorageSource, type PluginEnvironmentServiceParams, type PluginEnvironmentServiceResult } from "@paperclipai/plugin-sdk";
import { assertDaytonaServiceDataAvailable } from "./service-data-deletion.js";
import { verifyDaytonaServiceAllocationResources } from "./service-resources.js";

export const SERVICE_RETENTION_LABEL = "paperclip-services-retained";
const uuid = /^[a-f0-9-]{36}$/i;
function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Provider calls receive only server-owned allocation identities. */
export async function handleDaytonaServiceOperation(sandbox: Sandbox, input: PluginEnvironmentServiceParams): Promise<PluginEnvironmentServiceResult> {
  if (![input.companyId, input.serviceId, input.generation].every((value) => uuid.test(value))) throw new Error("Invalid service identity");
  await sandbox.refreshData();
  if (sandbox.id !== input.providerLeaseId || sandbox.labels["paperclip-company-id"] !== input.companyId || sandbox.labels["paperclip-environment-id"] !== input.environmentId) {
    throw new Error("Service allocation does not match the sandbox ownership labels");
  }
  assertDaytonaServiceDataAvailable(sandbox);
  if (["start", "inspect", "endpoint"].includes(input.action) && !verifyDaytonaServiceAllocationResources(sandbox, input.config)) {
    return { state: sandbox.state === "started" ? "running" : "stopped", errorCode: "RESOURCE_CONFIGURATION_MISMATCH", endpoints: [] };
  }
  const cancelLabel = `paperclip-service-stop-${input.serviceId}`;
  if (input.action === "storage_usage") {
    if (sandbox.state !== "started") {
      const stopped = sandbox.state === "stopped" || sandbox.state === "archived";
      return { state: stopped ? "stopped" : "retained", storageUsage: { unavailable: stopped ? "compute_stopped" : "measurement_failed" } };
    }
    if (!input.launch?.cwd?.startsWith("/") || input.launch.cwd === "/") throw new Error("A verified workspace root is required");
    const measured = await sandbox.process.executeCommand(`node -e ${quote(runtimeServiceStorageSource)} ${quote(input.launch.cwd)}`, "/tmp", {}, 12);
    const value = measured.exitCode === 0 ? parseObject(measured.result) as { bytes?: number } | null : null;
    if (!value || !Number.isSafeInteger(value.bytes) || value.bytes! < 0) return { state: "running", storageUsage: { unavailable: "measurement_failed" } };
    return { state: "running", storageUsage: { bytes: value.bytes! } };
  }
  if (input.action === "retain" || input.action === "start") {
    // These policies are reconciled explicitly by Paperclip. In particular,
    // Daytona's auto-delete value 0 means immediate deletion, not retention.
    await sandbox.setAutoDeleteInterval(-1);
    await sandbox.setTtl(0);
    await sandbox.setAutostopInterval(0);
    await sandbox.setAutoPauseInterval(0);
    await sandbox.setLabels({ ...sandbox.labels, [SERVICE_RETENTION_LABEL]: "true" });
    if (input.action === "retain") return { state: "retained" };
  }
  if (input.action === "release_compute") {
    if (sandbox.labels[SERVICE_RETENTION_LABEL] !== "true") throw new Error("Allocation is not retained for services");
    if (sandbox.state === "started") await sandbox.stop(30);
    if (sandbox.state !== "stopped" && sandbox.state !== "archived") {
      await sandbox.refreshData();
      if (!["stopped", "archived"].includes(String(sandbox.state))) throw new Error("Sandbox stop could not be verified");
    }
    return { state: "stopped" };
  }
  if (input.action === "stop") {
    await sandbox.setLabels({ ...sandbox.labels, [cancelLabel]: input.generation });
    if (sandbox.state === "stopped" || sandbox.state === "archived") return { state: "exited", endpoints: [] };
  }
  if (input.action === "start") {
    if (sandbox.labels[cancelLabel] === input.generation) return { state: "exited", endpoints: [] };
    if (sandbox.state !== "started") await sandbox.start(30);
    await sandbox.refreshData();
    if (sandbox.labels[cancelLabel] === input.generation) return { state: "exited", endpoints: [] };
    if (!verifyDaytonaServiceAllocationResources(sandbox, input.config)) {
      return { state: "running", errorCode: "RESOURCE_CONFIGURATION_MISMATCH", endpoints: [] };
    }
  }
  if (sandbox.state !== "started") {
    if (input.action === "logs") throw new Error("Start the retained sandbox to read its service logs");
    return { state: "exited", endpoints: [] };
  }
  // The command is fixed code; credentials and command text are never embedded
  // in argv, a persistent session command, or a bootstrap file.
  const payload = {
    action: input.action, companyId: input.companyId, serviceId: input.serviceId,
    generation: input.generation, launch: input.launch, processRef: input.processRef, limitBytes: input.limitBytes,
  };
  const encoded = JSON.stringify(payload);
  if (encoded.length > 1024 * 1024) throw new Error("Service request is too large");
  const result = await sandbox.process.executeCommand(
    `node -e ${quote(runtimeServiceRemoteControlSource)}`, "/tmp",
    { PAPERCLIP_SERVICE_CONTROL: encoded }, 15,
  );
  const parsed = parseObject(result.result);
  const error = typeof parsed?.error === "string" ? parsed.error : null;
  if (result.exitCode !== 0 || !parsed || error || !["missing", "running", "exited", "stopped", "retained"].includes(String(parsed.state))) {
    const code = ["EADDRINUSE", "ENOENT", "IDENTITY_LOST"].includes(error ?? "") ? error as PluginEnvironmentServiceResult["errorCode"] : "SERVICE_OPERATION_FAILED";
    return { state: "missing", errorCode: code };
  }
  const response = parsed as unknown as PluginEnvironmentServiceResult;
  if (input.action === "endpoint") {
    const endpoint = response.endpoints?.find((candidate) => candidate.name === input.endpointName);
    if (!endpoint?.healthy || endpoint.port < 1024 || endpoint.port > 65535) throw new Error("Service endpoint is not healthy or owned by this process");
    const preview = await sandbox.getPreviewLink(endpoint.port);
    const url = new URL(preview.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname.startsWith(`${endpoint.port}-${sandbox.id}.`)) throw new Error("Unexpected provider preview URL");
    if (!preview.token) throw new Error("A private preview token is required");
    response.upstream = { url: url.origin, headers: {
      "x-daytona-preview-token": preview.token,
      "x-daytona-skip-preview-warning": "true",
      // Paperclip owns browser access and activity policy. Preserve app CORS
      // and the stable public host instead of Daytona's proxy defaults.
      "x-daytona-disable-cors": "true",
      "x-daytona-trust-forwarded-host": "true",
      "x-daytona-skip-last-activity-update": "true",
    } };
  }
  return response;
}

/** Ordinary run cleanup cannot delete or stop a retained service allocation. */
export async function assertDaytonaSandboxNotRetained(sandbox: Sandbox) {
  await sandbox.refreshData();
  if (sandbox.labels?.[SERVICE_RETENTION_LABEL] === "true") throw new Error("Sandbox is retained by runtime services; use service allocation lifecycle controls");
}
