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
    return ["sandbox", target.providerKey ?? "", target.environmentId ?? "", command].join(":");
  }
  return ["ssh", target.environmentId ?? "", target.leaseId ?? "", target.spec.host, target.spec.port ?? "", target.spec.username ?? "", command].join(":");
}

export async function claudeCommandSupportsEffortFlag(
  command: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  env: Record<string, string>,
  timeoutSec: number,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<boolean | null> {
  if (!claudeCommandLooksLike(command, "claude")) {
    return true;
  }

  const key = cacheKeyForTarget(command, target);
  const existing = effortFlagSupportCache.get(key);
  if (existing) return existing;

  const probe = (async (): Promise<boolean | null> => {
    try {
      const proc = await runAdapterExecutionTargetProcess(
        `probe-effort-${Date.now()}`,
        target,
        command,
        ["--help"],
        {
          cwd,
          env,
          timeoutSec: Math.min(timeoutSec, 15),
          graceSec: 5,
          onLog: async () => {},
        },
      );

      if (proc.exitCode !== 0) {
        return null;
      }

      const output = proc.stdout + proc.stderr;
      return output.includes("--effort");
    } catch {
      return null;
    }
  })();

  effortFlagSupportCache.set(key, probe);
  return probe;
}

export function resetClaudeCliCapabilitiesCacheForTests(): void {
  effortFlagSupportCache.clear();
}
