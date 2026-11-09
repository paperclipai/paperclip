import childProcess, { execFileSync, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { promisify } from "node:util";
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

/** Harness-private directories inside the attempt's temporary root. */
export const HARNESS_PRIVATE_TEMPORARY_CHILDREN = [
  "artifacts-private",
  "control",
  "selected-private-inputs",
  // Playwright's compiled copy of the harness and graders, with source maps.
  "playwright-transform-cache",
] as const;

/** Playwright otherwise caches compiled harness code in the shared temporary directory. */
export function playwrightCacheDirectory(temporaryRoot: string) {
  return path.join(temporaryRoot, "playwright-transform-cache");
}

/** Playwright's default cache location for this user, which the launcher removes. */
export function defaultPlaywrightCacheDirectory(temporaryDirectory = os.tmpdir()) {
  return path.join(temporaryDirectory, `playwright-transform-cache-${process.geteuid?.() ?? ""}`);
}

export function agentFilesystemSandboxApplies(input: {
  platform: NodeJS.Platform;
  executions: readonly MatrixExecution[];
  installedRelease: boolean;
}) {
  if (input.platform !== "linux" || input.installedRelease) return false;
  if (!input.executions.some((execution) => execution.environment.id === "local" && execution.profile.generation === "native")) return false;
  // Codex's own bubblewrap sandbox mounts, which Landlock forbids. Those cells
  // keep their existing isolation until Codex permission profiles hide the eval.
  return !input.executions.some(requiresCodexCiSandbox);
}

/**
 * Landlock can only hide a path by leaving its ancestors ungranted, and an
 * ungranted directory accepts no new entries. Hiding the attempt's private
 * children of a root under /tmp would stop agents creating files in /tmp, so a
 * sandboxed attempt keeps its root in /var/tmp instead.
 */
export function agentTemporaryParent(applies: boolean, sharedTemporary = os.tmpdir()) {
  if (applies) {
    try {
      accessSync("/var/tmp", constants.W_OK | constants.X_OK);
      return realpathSync("/var/tmp");
    } catch {
      // Fall back to the shared directory; its private children stay visible.
    }
  }
  return realpathSync(sharedTemporary);
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
  sharedTemporary?: string;
  gitStores?: readonly string[];
}): AgentFilesystemSandboxConfig | null {
  if (!agentFilesystemSandboxApplies(input)) return null;
  const sharedTemporary = path.resolve(input.sharedTemporary ?? (input.env.TMPDIR?.trim() || os.tmpdir()));
  const required = input.env.GITHUB_ACTIONS === "true";
  // Harness material that must be hidden. Git holds the committed scenarios
  // and graders, so `git show HEAD:tests/...` would otherwise bypass `tests/`.
  const essential = [
    path.join(input.repositoryRoot, "tests"),
    ...(input.gitStores ?? gitStorePaths(input.repositoryRoot)),
    path.join(input.repositoryRoot, ".manual-private-trusted"),
    ...HARNESS_PRIVATE_TEMPORARY_CHILDREN.map((child) => path.join(input.temporaryRoot, child)),
    input.privateDir,
  ];
  const optional = [input.evidenceRoot, input.env.RUNNER_TEMP];
  const hidden: string[] = [];
  const exposed: string[] = [];
  for (const [candidate, mustHide] of [...essential.map((value) => [value, true] as const), ...optional.map((value) => [value, false] as const)]) {
    const value = candidate?.trim();
    if (!value || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    // Never hide a path that holds the agent's own state, or one beneath the
    // shared temporary directory: its ancestors would lose new entries.
    if (within(input.temporaryRoot, resolved) || within(input.repositoryRoot, resolved)
      || within(resolved, sharedTemporary) || within(sharedTemporary, resolved)) {
      if (mustHide) exposed.push(resolved);
      continue;
    }
    if (!hidden.includes(resolved)) hidden.push(resolved);
  }
  if (exposed.length) {
    const message = `agent_filesystem_sandbox_incomplete: cannot hide ${exposed.join(", ")}; keep the checkout and attempt root outside ${sharedTemporary}`;
    // A required sandbox fails closed rather than run an eval agents can read.
    if (required) throw new Error(message);
    console.warn(`[agent-filesystem-sandbox] ${message}`);
  }
  return hidden.length ? { hidden, required } : null;
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

/** Matches runnerd by executable name, whether absolute or resolved through PATH. */
export function isRunnerdLaunch(command: unknown) {
  return typeof command === "string" && path.basename(command) === RUNNERD_EXECUTABLE_NAME;
}

/**
 * The checkout's Git store holds the committed scenarios and graders. A linked
 * worktree's `.git` is a file that points into the main repository, so hide the
 * worktree's gitdir and the shared common directory as well.
 */
export function gitStorePaths(repositoryRoot: string): string[] {
  const dotGit = path.join(repositoryRoot, ".git");
  const stores = [dotGit];
  try {
    if (!statSync(dotGit).isFile()) return stores;
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!pointer) return stores;
    const gitDir = path.resolve(repositoryRoot, pointer);
    stores.push(gitDir);
    const common = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (common) stores.push(path.resolve(gitDir, common));
  } catch {
    // A missing .git or commondir leaves only the paths found so far.
  }
  return stores;
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
  playwrightCache = defaultPlaywrightCacheDirectory(),
) {
  const harness = path.join(repositoryRoot, "tests", "runner-e2e");
  const script = [
    'out=""; add() { out="$out$1=$2;"; }',
    'if cat "$1" >/dev/null 2>&1; then add harnessFile readable; else add harnessFile denied; fi',
    'if ls "$2" >/dev/null 2>&1; then add harnessDirectory listable; else add harnessDirectory denied; fi',
    'if test -e "$2"; then add harnessDirectoryStat visible; else add harnessDirectoryStat absent; fi',
    'if cat "$3" >/dev/null 2>&1; then add productFile readable; else add productFile denied; fi',
    'probe=$(mktemp) && rm -f "$probe" && add temporaryWrite allowed || add temporaryWrite denied',
    'if ls "$4" >/dev/null 2>&1; then add playwrightDefaultCache listable; else add playwrightDefaultCache denied; fi',
    'shift 4; for hidden in "$@"; do if ls "$hidden" >/dev/null 2>&1; then add "hidden:$hidden" listable; else add "hidden:$hidden" denied; fi; done',
    'printf "%s\\n" "$out"',
  ].join("\n");
  const invocation = sandboxedInvocation(config, python, "/bin/sh", [
    "-c", script, "sh",
    path.join(harness, "agent-filesystem-sandbox.ts"),
    harness,
    path.join(repositoryRoot, "packages", "paperclip-runner", "package.json"),
    playwrightCache,
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
    result.playwrightDefaultCache !== "denied" && "Playwright's default transform cache is listable",
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
  const launchers = childProcess as unknown as Record<RunnerdLaunchApi, (...args: unknown[]) => unknown>;
  for (const api of RUNNERD_LAUNCH_APIS) launchers[api] = wrapRunnerdLaunch(launchers[api], config, python, api);
  syncBuiltinESMExports();
  return config;
}

/** Every child_process API that can start an executable directly. */
export const RUNNERD_LAUNCH_APIS = ["spawn", "spawnSync", "execFile", "execFileSync"] as const;
export type RunnerdLaunchApi = typeof RUNNERD_LAUNCH_APIS[number];

/**
 * Wraps one launch API so runnerd starts inside the sandbox and other launches
 * pass through. A runnerd launch the wrapper cannot rewrite fails closed.
 */
export function wrapRunnerdLaunch<T extends (...args: any[]) => unknown>(original: T, config: AgentFilesystemSandboxConfig, python: string, api: RunnerdLaunchApi = "spawn", wrapCustom = true): T {
  const wrapped = function (this: unknown, command: unknown, ...rest: unknown[]) {
    if (!isRunnerdLaunch(command)) return Reflect.apply(original, this, [command, ...rest]);
    const hasArgs = Array.isArray(rest[0]);
    const args = hasArgs ? rest[0] as string[] : [];
    const afterArgs = hasArgs ? rest.slice(1) : rest;
    const options = afterArgs[0] && typeof afterArgs[0] === "object" ? afterArgs[0] as SpawnOptions : undefined;
    if (options?.shell) throw new Error("agent_filesystem_sandbox: refusing to start runnerd through a shell, outside the sandbox");
    const invocation = sandboxedInvocation(config, python, command as string, args, options?.env ?? process.env);
    const result = Reflect.apply(original, this, [invocation.command, invocation.args, ...afterArgs]);
    const pid = (result as { pid?: number } | undefined)?.pid;
    console.log(`[agent-filesystem-sandbox] runnerd launched inside the sandbox via ${api}${pid ? ` (pid ${pid})` : ""}`);
    return result;
  } as T;
  // execFile's promisified form resolves { stdout, stderr } through this hook;
  // keep it, wrapped the same way, so promisify(execFile) keeps its shape.
  const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
  if (wrapCustom && typeof custom === "function") {
    Object.defineProperty(wrapped, promisify.custom, {
      value: wrapRunnerdLaunch(custom as (...args: any[]) => unknown, config, python, api, false),
      configurable: true,
    });
  }
  return wrapped;
}

/** Back-compatible name for the spawn wrapper. */
export function wrapRunnerdSpawn(original: typeof childProcess.spawn, config: AgentFilesystemSandboxConfig, python: string) {
  return wrapRunnerdLaunch(original, config, python, "spawn");
}
