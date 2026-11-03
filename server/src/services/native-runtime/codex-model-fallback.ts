import { posix } from "node:path";
import {
  codexCliVersionAtLeast,
  DEFAULT_CODEX_LOCAL_MODEL,
  minimumCodexCliVersionForModel,
  models,
  normalizeCodexModel,
} from "@paperclipai/adapter-codex-local";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createNativeSshCommandRunner } from "./native-ssh-command-runner.js";
import { isSupportedRemoteCodexVersion, parseCodexCliVersion } from "./codex-runtime-compatibility.js";

/** Newest older model in the same class first, then the stable Runner default. */
export function codexModelFallbackCandidates(requestedModel: string): string[] {
  const requested = normalizeCodexModel(requestedModel);
  const identity = /^gpt-(\d+(?:\.\d+)?)-(astra|sol|terra|luna)$/.exec(requested);
  const sameClass = identity ? models.flatMap(({ id }) => {
    const candidate = /^gpt-(\d+(?:\.\d+)?)-(astra|sol|terra|luna)$/.exec(id);
    return candidate && candidate[2] === identity[2] && Number(candidate[1]) < Number(identity[1])
      ? [id] : [];
  }) : [];
  return [...new Set([...sameClass, DEFAULT_CODEX_LOCAL_MODEL])].filter((model) => model !== requested);
}

export function compatibleCodexModel(model: string | null, version: string | null): string | null {
  if (!version || !isSupportedRemoteCodexVersion(version)) return model;
  const minimum = minimumCodexCliVersionForModel(model);
  if (!minimum || codexCliVersionAtLeast(version, minimum)) return model;
  return selectCodexModelFallback(model!, (candidate) => {
    const floor = minimumCodexCliVersionForModel(candidate);
    return !floor || codexCliVersionAtLeast(version, floor);
  }) ?? model;
}

export function selectCodexModelFallback(requestedModel: string, compatible: (model: string) => boolean): string | null {
  for (const candidate of codexModelFallbackCandidates(requestedModel)) {
    if (compatible(candidate)) return candidate;
  }
  // Keep the verifier's existing actionable failure when no candidate is safe.
  return null;
}

export function parseRemoteExecutableCandidate(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  const candidate = lines[0]!;
  if (!candidate.startsWith("/") || candidate.length > 4_096 || !/^\/[A-Za-z0-9_./+@-]+$/.test(candidate)) return null;
  return posix.normalize(candidate);
}

/** Shared with the launch verifier so preparation checks the same image CLI. */
export async function discoverRemoteExecutable(
  runner: CommandManagedRuntimeRunner,
  cwd: string,
  name: "paperclip-runnerd" | "codex",
): Promise<string | null> {
  const result = await runner.execute({
    command: "sh",
    args: ["-c", `for candidate in /opt/paperclip-runner/bin/${name} "$HOME/.local/bin/${name}"; do ` +
      `if [ -x "$candidate" ]; then printf '%s\\n' "$candidate"; exit 0; fi; done; ` +
      `command -v ${name} 2>/dev/null || true`],
    cwd, bypassSession: true, timeoutMs: 10_000,
  });
  return result.exitCode === 0 && !result.timedOut ? parseRemoteExecutableCandidate(result.stdout) : null;
}

export async function readRemoteCodexModelCliVersion(input: {
  model: string | null;
  target?: AdapterExecutionTarget | null;
  remoteCodexPath?: string | null;
  remoteCodexNpmSpec?: string | null;
}): Promise<string | null> {
  const target = input.target;
  // An explicit artifact or install pin takes precedence over the image CLI.
  if (target?.kind !== "remote" || !minimumCodexCliVersionForModel(input.model)
    || input.remoteCodexPath?.trim() || input.remoteCodexNpmSpec?.trim()) return null;
  try {
    const runner = target.transport === "ssh"
      ? createNativeSshCommandRunner({ spec: target.spec, defaultCwd: target.remoteCwd })
      : target.runner;
    if (!runner) return null;
    const executable = await discoverRemoteExecutable(runner, target.remoteCwd, "codex");
    if (!executable) return null;
    const result = await runner.execute({ command: executable, args: ["--version"],
      cwd: target.remoteCwd, bypassSession: true, timeoutMs: 30_000 });
    if (result.exitCode !== 0 || result.timedOut) return null;
    const version = parseCodexCliVersion(`${result.stdout}\n${result.stderr}`);
    return version && isSupportedRemoteCodexVersion(version) ? version : null;
  } catch {
    // Optional preparation probes must not bypass launch verification or its
    // existing recovery policy when a remote command rejects or times out.
    return null;
  }
}
