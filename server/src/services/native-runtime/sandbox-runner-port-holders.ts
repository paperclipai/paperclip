import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { persistActivity } from "../activity-log.js";
import { NativePredecessorRetirementUnprovenError } from "./predecessor-retirement.js";
import { REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT } from "./remote-runner-recovery-diagnostics.js";

export const SANDBOX_RUNNER_HOLDER_LIST_SCRIPT = [
  "set -eu",
  'root=$1; own=$2',
  'test -d "$root/sessions" && test ! -L "$root/sessions" || exit 0',
  'for session in "$root"/sessions/*; do',
  '  test -d "$session" && test ! -L "$session" || continue',
  '  case "${session##*/}" in *.*) continue;; esac',
  '  test "$session" = "$own" && continue',
  '  identity="$session/runner/runner-process.identity"; state="$session/runner/runner-state.json"',
  '  test -f "$identity" && test ! -L "$identity" || continue',
  '  encoded_state=""',
  '  if test -f "$state" && test ! -L "$state"; then encoded_state=$(base64 < "$state" | tr -d "\\n"); fi',
  '  printf "%s\\t%s\\t%s\\n" "$identity" "$(base64 < "$identity" | tr -d "\\n")" "$encoded_state"',
  "done",
].join("\n");

const RETIRABLE_HOLDER_RUN_STATUSES = new Set(["succeeded", "cancelled"]);
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SandboxRunnerHolder = {
  identityPath: string;
  nonce: string;
  pid: number;
  runnerInstanceId: string;
  processStartFingerprint: string | null;
  runId: string | null;
  idle: boolean;
};

function decode(value: string | undefined): string | null {
  if (!value) return null;
  try { return Buffer.from(value, "base64").toString("utf8"); } catch { return null; }
}

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export function parseSandboxRunnerHolders(stdout: string): SandboxRunnerHolder[] {
  const holders: SandboxRunnerHolder[] = [];
  for (const line of stdout.split("\n")) {
    const [identityPath, encodedIdentity, encodedState] = line.split("\t");
    const identity = decode(encodedIdentity)?.trim().split("\n");
    if (!identityPath || !identity) continue;
    const [nonce, rawPid, startedAt, runnerInstanceId, fingerprint] = identity;
    const pid = Number(rawPid);
    if (!nonce || !/^[a-zA-Z0-9_-]+$/.test(nonce) || !Number.isSafeInteger(pid) || pid <= 0 || !startedAt
      || !runnerInstanceId || (fingerprint !== undefined && !/^linux:[0-9a-f-]+:[0-9]+$/.test(fingerprint))) continue;
    const state = parseObject(decode(encodedState));
    const runId = typeof state?.runId === "string" && state.runnerInstanceId === runnerInstanceId ? state.runId : null;
    const idle = state !== null && Array.isArray(state.outbox) && state.outbox.length === 0
      && state.pendingTerminalDelivery === null && state.pendingProviderCleanup == null && state.warmTransition == null;
    holders.push({ identityPath, nonce, pid, runnerInstanceId, processStartFingerprint: fingerprint ?? null, runId, idle });
  }
  return holders;
}

type HolderProbe = "alive" | "gone" | "unproven";

async function probeHolder(runner: CommandManagedRuntimeRunner, holder: SandboxRunnerHolder,
  signal?: "TERM" | "KILL"): Promise<HolderProbe> {
  const result = await runner.execute({
    command: "sh",
    args: ["-c", REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT + (signal ? '; kill -"$6" "$pid"' : ""),
      "paperclip-runner-port-holder-check", holder.identityPath, holder.nonce, holder.runnerInstanceId, String(holder.pid),
      holder.processStartFingerprint ?? "", ...(signal ? [signal] : [])],
    bypassSession: true,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!result || result.timedOut) return "unproven";
  if (result.exitCode === 0) return "alive";
  if (result.exitCode === 45 || result.exitCode === 47) return "gone";
  return "unproven";
}

async function waitUntilGone(runner: CommandManagedRuntimeRunner, holder: SandboxRunnerHolder, waitMs: number, pollMs: number) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const probe = await probeHolder(runner, holder);
    if (probe !== "alive") return probe;
    if (Date.now() >= deadline) return "alive" as const;
    await new Promise(done => setTimeout(done, pollMs));
  }
}

export async function retireSandboxRunnerPortHolders(input: {
  db: Db;
  companyId: string;
  agentId: string;
  runId: string;
  runner: CommandManagedRuntimeRunner;
  runtimeRoot: string;
  ownSessionRoot: string;
  providerLeaseId: string | null;
  adoptedRunId?: string | null;
  retireInProcess: (holderRunId: string) => Promise<boolean>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
}): Promise<string[]> {
  const listed = await input.runner.execute({
    command: "sh",
    args: ["-c", SANDBOX_RUNNER_HOLDER_LIST_SCRIPT, "paperclip-runner-port-holders", input.runtimeRoot, input.ownSessionRoot],
    bypassSession: true,
    timeoutMs: 15_000,
  }).catch(() => null);
  if (!listed || listed.exitCode !== 0 || listed.timedOut) {
    throw new NativePredecessorRetirementUnprovenError(null, input.providerLeaseId,
      new Error(`runner_port_holder_inventory_unavailable: exit=${listed?.exitCode ?? "none"} timedOut=${listed?.timedOut ?? false}`));
  }
  const retired: string[] = [];
  for (const holder of parseSandboxRunnerHolders(listed.stdout)) {
    if (holder.runId === input.runId || (holder.runId !== null && holder.runId === input.adoptedRunId)) continue;
    const initial = await probeHolder(input.runner, holder);
    if (initial === "gone") continue;
    const unproven = (reason: string) => new NativePredecessorRetirementUnprovenError(holder.runId, input.providerLeaseId,
      new Error(`runner_port_holder_${reason}`));
    if (initial === "unproven") throw unproven("unverifiable");
    if (holder.runId && await input.retireInProcess(holder.runId)) {
      if (await waitUntilGone(input.runner, holder, input.waitMs ?? 10_000, input.pollMs ?? 500) !== "gone") throw unproven("still_running");
      retired.push(holder.runId);
      continue;
    }
    if (!holder.runId || !RUN_ID_PATTERN.test(holder.runId)) throw unproven("unknown_owner");
    const [owner] = await input.db.select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, holder.runId))).limit(1);
    if (!owner) throw unproven("unknown_owner");
    if (!RETIRABLE_HOLDER_RUN_STATUSES.has(owner.status) || owner.agentId !== input.agentId || !holder.idle) {
      throw unproven("owner_not_settled");
    }
    let outcome: "stopped" | "killed" = "stopped";
    let probe = await probeHolder(input.runner, holder, "TERM");
    if (probe === "alive") probe = await waitUntilGone(input.runner, holder, input.waitMs ?? 10_000, input.pollMs ?? 500);
    if (probe === "alive") {
      outcome = "killed";
      probe = await probeHolder(input.runner, holder, "KILL");
      if (probe === "alive") probe = await waitUntilGone(input.runner, holder, input.waitMs ?? 10_000, input.pollMs ?? 500);
    }
    if (probe !== "gone") throw unproven("stop_unconfirmed");
    await persistActivity(input.db, {
      companyId: input.companyId, actorType: "system", actorId: "native-runtime", agentId: input.agentId,
      action: "native.runner_port_holder_retired", entityType: "heartbeat_run", entityId: input.runId, runId: input.runId,
      details: { holderRunId: holder.runId, holderRunnerInstanceId: holder.runnerInstanceId, holderStatus: owner.status, outcome,
        providerLeaseId: input.providerLeaseId },
    });
    await input.onLog?.("stdout",
      `[paperclip-runner] Stopped the finished run ${holder.runId}'s idle Runner that still held this sandbox's Runner port (${outcome}).\n`)
      .catch(() => undefined);
    retired.push(holder.runId);
  }
  return retired;
}
