import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile, lstat } from "node:fs/promises";
import { test, type Cookie } from "@playwright/test";
import type { Environment, EnvironmentLease } from "../../../packages/shared/src/types/environment.js";
import type { IssueRecoveryAction } from "../../../packages/shared/src/types/issue.js";
import type { NativeFaultRun } from "./runtime-native-fault.js";
import { createRemoteFixtureClient } from "../remote-native-bootstrap.js";
import { providerSandboxIsOwned, type DestroySandboxBinding, type DestroySandboxReceipt } from "./runtime-daytona-destroy.js";
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
async function main(): Promise<DestroySandboxReceipt> {
  let attached = false; try { test.info(); attached = true; } catch { /* standalone child only */ } if (attached) throw new Error("Private provider fault must not execute in Test");
  const file = process.argv[2]!; const info = await lstat(file); if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > 65536) throw new Error("Invalid private provider fault request");
  const input = JSON.parse(await readFile(file, "utf8")) as { scenarioId: string; executionId: string; binding: DestroySandboxBinding; baseURL: string; cookies: Cookie[]; credential: string };
  const base = new URL(input.baseURL), b = input.binding;
  if (input.scenarioId !== "workspaces.recover-lost-sandbox" || !/^chat-features\.[a-z0-9-]+\.local\.workspaces\.recover-lost-sandbox$/.test(input.executionId) || base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.origin !== input.baseURL || ![b.companyId, b.environmentId, b.taskId, b.runId, b.leaseId, b.sandboxId, b.actionId].every(id => /^[a-f0-9-]{36}$/i.test(id)) || !/^[a-zA-Z0-9_-]{1,160}$/.test(b.attempt)) throw new Error("Provider fault requires exact owned loopback fixture identities");
  async function get<T>(pathname: string): Promise<T> { const response = await fetch(base.origin + pathname, { headers: { Cookie: input.cookies.map(row => `${row.name}=${row.value}`).join("; "), Origin: base.origin }, redirect: "error", signal: AbortSignal.timeout(15000) }); if (!response.ok) { await response.body?.cancel(); throw new Error("Exact provider fault public ownership check failed"); } return response.json() as Promise<T>; }
  const check = async () => {
    const [environment, listed, lease, leases, run, recovery] = await Promise.all([get<Environment>(`/api/environments/${b.environmentId}`), get<Environment[]>(`/api/companies/${b.companyId}/environments`), get<EnvironmentLease>(`/api/environment-leases/${b.leaseId}`), get<EnvironmentLease[]>(`/api/environments/${b.environmentId}/leases`), get<NativeFaultRun>(`/api/heartbeat-runs/${b.runId}`), get<{ actions: IssueRecoveryAction[] }>(`/api/issues/${b.taskId}/recovery-actions`)]);
    const ref = record(record(run.runnerProfileJson).nativeWorkspaceSync), action = recovery.actions.find(row => row.id === b.actionId);
    if (environment.config.provider !== "daytona" || environment.metadata?.attempt !== b.attempt || environment.metadata.companyId !== b.companyId || !listed.some(row => row.id === environment.id)
      || lease.companyId !== b.companyId || lease.environmentId !== b.environmentId || lease.issueId !== b.taskId || lease.heartbeatRunId !== b.runId || lease.providerLeaseId !== b.sandboxId || lease.provider !== "daytona" || lease.metadata?.pendingCleanupInFlight === true
      || leases.some(row => row.id !== lease.id && row.providerLeaseId === b.sandboxId && ["active", "retained", "pending_cleanup"].includes(row.status))
      || run.companyId !== b.companyId || run.nativeIssueId !== b.taskId || run.runtimeMode !== "native" || run.status !== "failed" || run.nativePhase !== "terminal_failure" || ref.state !== "prepared" || ref.leaseId !== b.leaseId || ref.providerLeaseId !== b.sandboxId
      || !action || action.ownerType !== "board" || !["active", "escalated"].includes(action.status) || action.evidence.runId !== b.runId || !["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"].includes(action.cause)) throw new Error("Refusing sandbox mutation without exact quiescent failed native source/board-owned scope");
  };
  await check();
  const client = await createRemoteFixtureClient(input.credential) as unknown as { get(id: string): Promise<{ id: string; name: string; labels: Record<string, string>; refreshData(): Promise<void>; delete(timeout: number, force: boolean): Promise<void> }> };
  const sandbox = await client.get(b.sandboxId); await sandbox.refreshData(); if (!providerSandboxIsOwned(sandbox, b)) throw new Error("Actual provider labels/name do not bind the owned failed sandbox");
  const ownership = sandbox.labels["paperclip-create-attempt"];
  await check(); await sandbox.refreshData(); if (!providerSandboxIsOwned(sandbox, b) || sandbox.labels["paperclip-create-attempt"] !== ownership) throw new Error("Provider sandbox ownership changed before exact deletion");
  await sandbox.delete(60, true);
  const require = createRequire(new URL("../../../packages/plugins/sandbox-providers/daytona/package.json", import.meta.url));
  const { DaytonaNotFoundError } = await import(pathToFileURL(require.resolve("@daytonaio/sdk")).href);
  let absent = false;
  try { await client.get(b.sandboxId); } catch (error) { absent = error instanceof DaytonaNotFoundError; }
  if (!absent) throw new Error("Actual provider did not independently confirm the exact destroyed sandbox absent");
  return { ...b, processIsolation: true, testRunnerAttached: false, apiStepRecorder: false, actualOwnedProviderLabels: true, actualDeleteAccepted: true, independentlyAbsent: true };
}
main().then(value => process.stdout.write(JSON.stringify(value))).catch(() => { process.stderr.write("Exact owned sandbox fault failed; private diagnostics withheld"); process.exitCode = 1; });
