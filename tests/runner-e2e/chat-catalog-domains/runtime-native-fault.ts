import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { realpath } from "node:fs/promises";
import type { heartbeatRuns } from "../../../packages/db/src/schema/heartbeat_runs.js";
import type { HeartbeatRun } from "../../../packages/shared/src/types/heartbeat.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { readProcessStartedAt } from "../../../server/src/services/hot-restart.js";
import { defaultCapabilityRunnerdBinary } from "../../../server/src/vendor/paperclip-runner/index.js";
import { pollUntil } from "../api.js";
// The public full-run route selects these persisted native fields; the legacy
// shared HeartbeatRun DTO does not yet declare them. Keep this exact projection.
export type NativeFaultRun = HeartbeatRun & Pick<typeof heartbeatRuns.$inferSelect, "runtimeMode" | "nativeIssueId" | "runnerInstanceId" | "nativePhase" | "nativeSessionId" | "runnerProfileJson">;
export type NativeFaultBinding = Pick<NativeFaultRun, "id" | "companyId" | "agentId" | "status" | "runtimeMode" | "nativeIssueId" | "runnerInstanceId" | "processPid" | "processGroupId" | "processStartedAt">;
export interface OwnedNativeIdentity {
  pid: number; uid: number; group: number; startedAt: string; executable: string; commandRunId: string; commandRunnerId: string; runtimeRoot: string;
}
export function matchesOwnedNativeIdentity(input: { identity: OwnedNativeIdentity; run: NativeFaultBinding;
  expected: { companyId: string; agentId: string; issueId: string; uid: number; executable: string; root: string } }) {
  const { identity: p, run, expected: e } = input;
  return run.status === "running" && run.runtimeMode === "native" && run.companyId === e.companyId && run.agentId === e.agentId && run.nativeIssueId === e.issueId
    && Number.isSafeInteger(p.pid) && p.pid > 1 && p.pid !== process.pid && p.pid === run.processPid && p.group === run.processGroupId
    && p.uid === e.uid && p.commandRunId === run.id && p.commandRunnerId === run.runnerInstanceId
    && p.executable === e.executable && path.isAbsolute(p.runtimeRoot) && p.runtimeRoot.startsWith(`${e.root}${path.sep}`) && path.resolve(p.runtimeRoot) === p.runtimeRoot
    && !!run.processStartedAt && Number.isFinite(Date.parse(p.startedAt)) && Math.abs(Date.parse(p.startedAt) - Date.parse(String(run.processStartedAt))) < 2_000;
}
export function ownedNativeExecutablePath(pid: number, command: string, platform: NodeJS.Platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Executable identity requires an owned process candidate");
  if (platform === "linux") return `/proc/${pid}/exe`;
  if (platform === "darwin" && path.isAbsolute(command)) return command;
  throw new Error("Owned executable identity is unavailable on this platform");
}
async function processIdentity(run: NativeFaultRun): Promise<OwnedNativeIdentity> {
  const pid = run.processPid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 1) throw new Error("Native infrastructure fault lacks an actual public process identity");
  const read = async (field: string) => (await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", `${field}=`], { maxBuffer: 65_536, timeout: 5_000 })).stdout.trim();
  try {
    const [uid, group, executable, command, startedAt] = await Promise.all([read("uid"), read("pgid"), read("comm"), read("args"), readProcessStartedAt(pid)]);
    if (!startedAt) throw new Error("missing process start");
    // Source buildNativeRunnerArguments has exactly these finite identity flags.
    // Never retain or print the complete command line or transport URL.
    const argument = (name: string) => {
      const matches = [...command.matchAll(new RegExp(`(?:^|\\s)--${name}\\s+([^\\s]+)(?=\\s|$)`, "g"))];
      if (matches.length !== 1) throw new Error("ambiguous process argument identity");
      return matches[0]![1]!;
    };
    return { pid, uid: Number(uid), group: Number(group), startedAt, executable: await realpath(ownedNativeExecutablePath(pid, executable)), commandRunId: argument("run-id"), commandRunnerId: argument("runner-id"), runtimeRoot: await realpath(argument("state-dir")) };
  } catch { throw new Error("Native infrastructure fault could not independently verify the actual process; private diagnostics withheld"); }
}
/** Authoring primitive only: this function is invoked solely inside the coordinator's selected live attempt. */
export async function verifyOwnedNativeRunner(ctx: ChatCatalogContext, binding: { runId: string; issueId: string; agentId: string }) {
  if (ctx.input.execution.environment.id !== "local" || typeof process.getuid !== "function") throw new Error("Owned infrastructure fault requires a supported local UID/process identity");
  const isolated = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT; if (!isolated) throw new Error("Owned infrastructure fault requires the explicit isolated attempt root");
  const expected = { companyId: ctx.input.fixtures.company.id, agentId: binding.agentId, issueId: binding.issueId, uid: process.getuid(), executable: await realpath(defaultCapabilityRunnerdBinary()), root: await realpath(isolated) };
  const load = () => ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${binding.runId}`);
  const first = await load(), observed = await processIdentity(first);
  if (!matchesOwnedNativeIdentity({ identity: observed, run: first, expected })) throw new Error("Owned infrastructure fault rejected a foreign or mismatched native process identity");
  const current = await load(), confirmed = await processIdentity(current);
  if (!matchesOwnedNativeIdentity({ identity: confirmed, run: current, expected }) || JSON.stringify(confirmed) !== JSON.stringify(observed)) throw new Error("Owned infrastructure fault rejected process reuse or changed ownership");
  return { run: current, identity: confirmed };
}
export async function faultOwnedNativeProcess(ctx: ChatCatalogContext, binding: { runId: string; issueId: string; agentId: string }) {
  const { run: current, identity: confirmed } = await verifyOwnedNativeRunner(ctx, binding);
  const load = () => ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${binding.runId}`);
  // Deliberately signal only the verified Runner PID. Its provider/tools remain
  // subject to the production cleanup/quarantine rules; never signal a group.
  process.kill(confirmed.pid, "SIGKILL");
  await ctx.input.evidence("runtime-owned-native-process-fault.json", { runId: current.id, companyId: current.companyId, agentId: current.agentId,
    issueId: current.nativeIssueId, runnerInstanceId: current.runnerInstanceId, processPid: confirmed.pid, processGroupId: confirmed.group, processStartedAt: confirmed.startedAt,
    uidMatches: true, executableMatches: true, runtimeRootWithinAttempt: true, identityReadTwice: true, signal: "SIGKILL", processGroupSignalled: false });
  const failed = await pollUntil({ label: "Real owned native infrastructure failure after verified Runner process loss", deadlineAt: Date.now() + 150_000,
    load, accept: run => run.status === "failed" && !!run.finishedAt && !!run.errorCode,
    reject: run => ["cancelled", "succeeded", "timed_out"].includes(run.status) ? "The real process fault did not produce a failed native infrastructure run" : undefined });
  if (!["native_runner_process_exited", "provider_transport_failed", "provider_stdout_closed", "provider_process_output_closed", "native_session_cleanup_quarantined"].includes(failed.errorCode ?? ""))
    throw new Error("The owned process fault did not retain a source-qualified infrastructure/cleanup failure; actual classification is not relabelled");
  await ctx.input.evidence("runtime-owned-native-process-failure.json", { runId: failed.id, status: failed.status, errorCode: failed.errorCode, finishedAt: failed.finishedAt, nativePhase: (failed as NativeFaultRun & { nativePhase?: string }).nativePhase ?? null });
  return failed;
}
