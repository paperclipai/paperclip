import type { PluginEnvironmentWorkspaceAllocationFiles } from "@paperclipai/plugin-sdk";
import type { EnvironmentLease } from "@paperclipai/shared";

export function workspaceAllocationFiles(lease: EnvironmentLease, remoteCwd: string) {
  const raw = lease.metadata?.workspaceAllocationFiles;
  if (raw === undefined) return [];
  const receipt = raw as PluginEnvironmentWorkspaceAllocationFiles | null;
  if (!receipt || receipt.providerLeaseId !== lease.providerLeaseId || receipt.remoteCwd !== remoteCwd
    || !Array.isArray(receipt.files) || receipt.files.length > 8
    || receipt.files.some(file => !file || typeof file.relativePath !== "string"
      || !/^\.paperclip-runtime\/[a-zA-Z0-9_-]+\.json$/.test(file.relativePath)
      || file.relativePath === ".paperclip-runtime/workspace-restored.json"
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))
    || new Set(receipt.files.map(file => file.relativePath)).size !== receipt.files.length) {
    throw new Error("remote_workspace_allocation_receipt_invalid");
  }
  return receipt.files;
}
