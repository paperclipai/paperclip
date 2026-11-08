import childProcess, { execFileSync, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { requiresCodexCiSandbox } from "./codex-ci-sandbox.js";
import type { MatrixExecution } from "./types.js";

/**
 * The agent under test must not read the eval: its scenarios, fixtures,
 * graders or captured evidence. A local cell runs the product from the same
 * checkout and as the same OS user as the harness, so file modes cannot
 * separate them. The server launches every native agent through runnerd; the
 * E2E server entry starts runnerd inside a Linux Landlock domain that hides
 * these paths from runnerd and all of its descendants (provider, tools, shell).
 * The product server itself stays unrestricted because it loads its E2E entry
 * from the harness.
 */
export const AGENT_FILESYSTEM_SANDBOX_ENV = "PAPERCLIP_RUNNER_E2E_AGENT_FS_SANDBOX";
export const RUNNERD_EXECUTABLE_NAME = "paperclip-runnerd";

export interface AgentFilesystemSandboxConfig {
  hidden: string[];
  required: boolean;
}

function within(candidate: string, root: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Selects the paths hidden from local native agents, or null when not applicable. */
export function agentFilesystemSandboxConfig(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  executions: readonly MatrixExecution[];
  repositoryRoot: string;
  temporaryRoot: string;
  privateDir: string;
  evidenceRoot?: string;
  installedRelease: boolean;
}): AgentFilesystemSandboxConfig | null {
  if (input.platform !== "linux" || input.installedRelease) return null;
  if (!input.executions.some((execution) => execution.environment.id === "local" && execution.profile.generation === "native")) return null;
  // Codex's own bubblewrap sandbox mounts, which Landlock forbids. Those cells
  // keep their existing isolation until Codex permission profiles hide the eval.
  if (input.executions.some(requiresCodexCiSandbox)) return null;
  const sharedTemporary = path.resolve(input.env.TMPDIR?.trim() || os.tmpdir());
  const candidates = [
    path.join(input.repositoryRoot, "tests"),
    path.join(input.repositoryRoot, ".manual-private-trusted"),
    input.privateDir,
    input.evidenceRoot,
    input.env.RUNNER_TEMP,
  ];
  const hidden: string[] = [];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    // Never hide a path that holds the agent's own state, or one beneath the
    // shared temporary directory: its ancestors would lose new entries.
    if (within(input.temporaryRoot, resolved) || within(input.repositoryRoot, resolved)) continue;
    if (within(resolved, sharedTemporary) || within(sharedTemporary, resolved)) continue;
    if (!hidden.includes(resolved)) hidden.push(resolved);
  }
  return hidden.length ? { hidden, required: input.env.GITHUB_ACTIONS === "true" } : null;
}

export function parseAgentFilesystemSandboxConfig(value: string | undefined): AgentFilesystemSandboxConfig | null {
  if (!value?.trim()) return null;
  const parsed = JSON.parse(value) as Partial<AgentFilesystemSandboxConfig>;
  if (!Array.isArray(parsed.hidden) || parsed.hidden.some((entry) => typeof entry !== "string" || !path.isAbsolute(entry)) || typeof parsed.required !== "boolean") {
    throw new Error(`${AGENT_FILESYSTEM_SANDBOX_ENV} is malformed`);
  }
  return { hidden: parsed.hidden, required: parsed.required };
}

export const agentFilesystemSandboxHelper = path.join(import.meta.dirname, "agent-filesystem-sandbox.py");

/** Rewrites one launch so the helper applies the domain and then execs it unchanged. */
export function sandboxedInvocation(
  config: AgentFilesystemSandboxConfig,
  python: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  // Python may coerce a C locale by exporting LC_CTYPE; restore the caller's value.
  const locale = env.LC_CTYPE === undefined ? ["--unset", "LC_CTYPE"] : ["--set", `LC_CTYPE=${env.LC_CTYPE}`];
  return {
    command: python,
    args: [
      "-I", "-S", agentFilesystemSandboxHelper,
      ...(config.required ? ["--required"] : []),
      ...locale,
      ...config.hidden.flatMap((hidden) => ["--hide", hidden]),
      "--", command, ...args,
    ],
  };
}

export function isRunnerdLaunch(command: unknown, options: SpawnOptions | undefined) {
  return typeof command === "string" && path.isAbsolute(command) && !options?.shell &&
    path.basename(command) === RUNNERD_EXECUTABLE_NAME;
}

export function pythonExecutable() {
  for (const candidate of ["/usr/bin/python3", "/usr/local/bin/python3"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "python3";
}

/** Proves, before any agent starts, that a sandboxed process cannot read the eval. */
export function probeAgentFilesystemSandbox(
  config: AgentFilesystemSandboxConfig,
  repositoryRoot: string,
  python = pythonExecutable(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const harness = path.join(repositoryRoot, "tests", "runner-e2e");
  const script = [
    'out=""; add() { out="$out$1=$2;"; }',
    'if cat "$1" >/dev/null 2>&1; then add harnessFile readable; else add harnessFile denied; fi',
    'if ls "$2" >/dev/null 2>&1; then add harnessDirectory listable; else add harnessDirectory denied; fi',
    'if test -e "$2"; then add harnessDirectoryStat visible; else add harnessDirectoryStat absent; fi',
    'if cat "$3" >/dev/null 2>&1; then add productFile readable; else add productFile denied; fi',
    'probe=$(mktemp) && rm -f "$probe" && add temporaryWrite allowed || add temporaryWrite denied',
    'shift 3; for hidden in "$@"; do if ls "$hidden" >/dev/null 2>&1; then add "hidden:$hidden" listable; else add "hidden:$hidden" denied; fi; done',
    'printf "%s\\n" "$out"',
  ].join("\n");
  const invocation = sandboxedInvocation(config, python, "/bin/sh", [
    "-c", script, "sh",
    path.join(harness, "agent-filesystem-sandbox.ts"),
    harness,
    path.join(repositoryRoot, "packages", "paperclip-runner", "package.json"),
    ...config.hidden,
  ], env);
  const output = execFileSync(invocation.command, invocation.args, { encoding: "utf8", cwd: "/", env, timeout: 30_000 });
  const result = Object.fromEntries(output.trim().split(";").filter(Boolean).map((entry) => {
    const separator = entry.lastIndexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const failures = [
    result.harnessFile !== "denied" && "harness file is readable",
    result.harnessDirectory !== "denied" && "harness directory is listable",
    result.productFile !== "readable" && "product package is unreadable",
    result.temporaryWrite !== "allowed" && "temporary directory is not writable",
    ...config.hidden.map((hidden) => result[`hidden:${hidden}`] === "listable" && `${hidden} is listable`),
  ].filter((failure): failure is string => Boolean(failure));
  return { result, failures };
}

/**
 * Wraps runnerd launches made by this process. Runs only in the E2E server
 * entry; the wrapper execs runnerd, so its PID, argv, cwd and environment are
 * the ones the product requested.
 */
export function installAgentFilesystemSandbox(repositoryRoot: string, env: NodeJS.ProcessEnv = process.env) {
  const config = parseAgentFilesystemSandboxConfig(env[AGENT_FILESYSTEM_SANDBOX_ENV]);
  delete env[AGENT_FILESYSTEM_SANDBOX_ENV];
  if (!config) return null;
  const python = pythonExecutable();
  let probe: ReturnType<typeof probeAgentFilesystemSandbox>;
  try {
    probe = probeAgentFilesystemSandbox(config, repositoryRoot, python);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (config.required) throw new Error(`agent_filesystem_sandbox_unavailable: ${message}`);
    console.warn(`[agent-filesystem-sandbox] disabled: ${message}`);
    return null;
  }
  console.log(`[agent-filesystem-sandbox] probe ${JSON.stringify({ hidden: config.hidden, required: config.required, ...probe })}`);
  if (probe.failures.length) {
    if (config.required) throw new Error(`agent_filesystem_sandbox_ineffective: ${probe.failures.join("; ")}`);
    console.warn(`[agent-filesystem-sandbox] disabled: ${probe.failures.join("; ")}`);
    return null;
  }
  const original = childProcess.spawn;
  const spawn = function (this: unknown, command: string, ...rest: unknown[]) {
    const args = Array.isArray(rest[0]) ? rest[0] as string[] : [];
    const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as SpawnOptions | undefined;
    if (isRunnerdLaunch(command, options)) {
      const invocation = sandboxedInvocation(config, python, command, args, options?.env ?? process.env);
      const child = Reflect.apply(original, this, [invocation.command, invocation.args, options ?? {}]) as ReturnType<typeof original>;
      console.log(`[agent-filesystem-sandbox] runnerd launched inside the sandbox (pid ${child.pid ?? "unknown"})`);
      return child;
    }
    return Reflect.apply(original, this, [command, ...rest]);
  } as typeof childProcess.spawn;
  childProcess.spawn = spawn;
  syncBuiltinESMExports();
  return config;
}
