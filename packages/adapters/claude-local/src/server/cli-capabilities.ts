import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import path from "node:path";

const effortFlagSupportCache = new Map<string, Promise<boolean | null>>();

export function claudeCommandLooksLike(command: string, expected = "claude"): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function cacheKeyForTarget(command: string, target: AdapterExecutionTarget | null | undefined): string {
  if (!target) return `local::${command}`;
  if (target.kind === "local") {
    return `local:${target.environmentId ?? ""}:${target.leaseId ?? ""}:${command}`;
  }
  if (target.transport === "sandbox") {
    return [
      "sandbox",
      target.providerKey ?? "",
      target.environmentId ?? "",
      command,
    ].join(":");
  }
  return [
    "ssh",
    target.environmentId ?? "",
    target.leaseId ?? "",
    target.spec.host,
    target.spec.port ?? "",
    target.spec.username ?? "",
    command,
  ].join(":");
}

async function probeClaudeCommandSupportsEffortFlag(input: {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<boolean | null> {
  const help = await runAdapterExecutionTargetProcess(
    input.runId,
    input.target,
    input.command,
    ["--help"],
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: Math.max(1, Math.min(input.timeoutSec, 20)),
      graceSec: Math.max(1, Math.min(input.graceSec, 5)),
      onLog: async () => {},
    },
  );

  if (help.timedOut) return null;
  const output = `${help.stdout}\n${help.stderr}`;
  if (output.includes("--effort")) return true;
  if ((help.exitCode ?? 0) === 0) return false;
  return null;
}

export async function claudeCommandSupportsEffortFlag(input: {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<boolean | null> {
  if (!claudeCommandLooksLike(input.command, "claude")) return null;

  const key = cacheKeyForTarget(input.command, input.target);
  const cached = effortFlagSupportCache.get(key);
  if (cached) return cached;

  // A thrown probe (e.g. sandbox connection error, ENOENT spawning the binary)
  // must degrade to the conservative fallback rather than killing the run, so we
  // resolve to null and drop the cache entry to retry on the next lease.
  const probe = probeClaudeCommandSupportsEffortFlag(input).catch(() => {
    effortFlagSupportCache.delete(key);
    return null;
  });
  effortFlagSupportCache.set(key, probe);
  return probe;
}

export function resetClaudeCliCapabilitiesCacheForTests() {
  effortFlagSupportCache.clear();
}
