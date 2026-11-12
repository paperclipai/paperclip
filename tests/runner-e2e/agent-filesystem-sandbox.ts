import childProcess, { execFileSync, type SpawnOptions } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  /**
   * The product instance root. Each runnerd launch then also hides every run's
   * saved sessions, run logs, database files and secrets, except its own session.
   */
  instanceRoot?: string;
}

/** One runnerd launch's sandbox: the attempt's hidden set plus its run scope. */
export interface RunnerdLaunchSandbox {
  hidden: string[];
  /** The launch's own entries beneath hidden directories, created before launch. */
  exposed: string[];
  /** Exposed paths that are files rather than directories. */
  exposedFiles: string[];
  /** Directories created before launch because their parent is hidden. */
  precreated: string[];
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
  instanceRoot?: string;
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
  if (!hidden.length) return null;
  const instanceRoot = input.instanceRoot?.trim();
  // The instance root lives in the attempt root; never in the shared directory.
  if (instanceRoot && path.isAbsolute(instanceRoot) && !within(path.resolve(instanceRoot), sharedTemporary)) {
    return { hidden, required, instanceRoot: path.resolve(instanceRoot) };
  }
  return { hidden, required };
}

function flagValue(args: readonly string[], flag: string) {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Mirrors opencodeRuntimeSessionDirectoryName in the OpenCode driver. */
export function opencodeSessionDirectoryName(normalizedSessionId: string) {
  const safe = normalizedSessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return safe && safe !== "." && safe !== ".." ? safe : null;
}

/** The attempt instance's directories that hold every run's state. */
export function instanceRunStatePaths(instanceRoot: string) {
  const runner = path.join(instanceRoot, "runtime", "paperclip-runner");
  return {
    durableSessions: path.join(runner, "durable-sessions"),
    runnerStates: path.join(runner, "runner"),
    controlPlane: path.join(runner, "control-plane"),
    opencode: path.join(runner, "opencode"),
    acpx: path.join(runner, "acpx"),
    runLogs: path.join(instanceRoot, "data", "run-logs"),
    providerTraces: path.join(instanceRoot, "data", "provider-traces"),
    backups: path.join(instanceRoot, "data", "backups"),
    database: path.join(instanceRoot, "db"),
    secrets: path.join(instanceRoot, "secrets"),
  };
}

/** Instance directories an agent may use, created on first use beside hidden ones. */
const INSTANCE_SHARED_DIRECTORIES = ["companies", "projects", "workspaces", "runtime-context-assets", "skills", "runtime/provider-packs"] as const;

/**
 * Selects one runnerd launch's sandbox. Runnerd is launched per session with
 * `--state-dir` inside that session's directory, so the launch keeps exactly
 * its own durable session, OpenCode session and provider trace and loses every
 * other run's.
 */
export function runnerdLaunchSandbox(config: AgentFilesystemSandboxConfig, args: readonly string[], env: NodeJS.ProcessEnv): RunnerdLaunchSandbox {
  const launch: RunnerdLaunchSandbox = { hidden: [...config.hidden], exposed: [], exposedFiles: [], precreated: [], required: config.required };
  if (!config.instanceRoot) return launch;
  const paths = instanceRunStatePaths(config.instanceRoot);
  const hide = (value: string) => { if (!launch.hidden.includes(value)) launch.hidden.push(value); };
  const expose = (value: string, file = false) => {
    if (!launch.exposed.includes(value)) launch.exposed.push(value);
    if (file && !launch.exposedFiles.includes(value)) launch.exposedFiles.push(value);
  };
  for (const value of [paths.durableSessions, paths.runnerStates, paths.controlPlane, paths.opencode, paths.runLogs, paths.providerTraces, paths.backups, paths.database, paths.secrets]) hide(value);
  // Hiding those leaves their parents (the instance root, its runtime and data
  // directories) without new entries. Create the directories the product makes
  // there on first use, so a long-lived runnerd still sees later additions.
  launch.precreated.push(paths.acpx, ...INSTANCE_SHARED_DIRECTORIES.map((name) => path.join(config.instanceRoot!, ...name.split("/"))));
  const stateDirectory = flagValue(args, "--state-dir");
  if (stateDirectory && path.isAbsolute(stateDirectory)) {
    const state = path.resolve(stateDirectory);
    for (const root of [paths.durableSessions, paths.runnerStates]) {
      if (!within(state, root) || state === root) continue;
      // The session's own directory: `<root>/<scope>`, whatever lies below it.
      expose(path.join(root, path.relative(root, state).split(path.sep)[0]!));
    }
  }
  const sessionId = flagValue(args, "--session-id");
  const configuredOpencode = env.PAPERCLIP_OPENCODE_RUNTIME_DIR?.trim();
  const opencodeRoots = [paths.opencode, ...(configuredOpencode && path.isAbsolute(configuredOpencode) ? [path.resolve(configuredOpencode)] : [])];
  for (const root of opencodeRoots) {
    if (root !== paths.opencode && (within(root, paths.durableSessions) || within(root, paths.runnerStates))) continue;
    hide(root);
    const name = sessionId ? opencodeSessionDirectoryName(sessionId) : null;
    if (name) expose(path.join(root, name));
  }
  const trace = env.PAPERCLIP_PROVIDER_TRACE_PATH?.trim();
  if (trace && path.isAbsolute(trace) && path.dirname(path.resolve(trace)) === paths.providerTraces) expose(path.resolve(trace), true);
  return launch;
}

/** Creates the launch's own entries, which a process inside the sandbox could not create. */
export function prepareRunnerdLaunchSandbox(launch: RunnerdLaunchSandbox) {
  for (const directory of launch.precreated) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const exposed of launch.exposed) {
    if (launch.exposedFiles.includes(exposed)) {
      mkdirSync(path.dirname(exposed), { recursive: true, mode: 0o700 });
      // Append mode never truncates a trace the run already started.
      closeSync(openSync(exposed, "a", 0o600));
    } else {
      mkdirSync(exposed, { recursive: true, mode: 0o700 });
    }
  }
}

export function parseAgentFilesystemSandboxConfig(value: string | undefined): AgentFilesystemSandboxConfig | null {
  if (!value?.trim()) return null;
  const parsed = JSON.parse(value) as Partial<AgentFilesystemSandboxConfig>;
  if (!Array.isArray(parsed.hidden) || parsed.hidden.some((entry) => typeof entry !== "string" || !path.isAbsolute(entry)) || typeof parsed.required !== "boolean"
    || (parsed.instanceRoot !== undefined && (typeof parsed.instanceRoot !== "string" || !path.isAbsolute(parsed.instanceRoot)))) {
    throw new Error(`${AGENT_FILESYSTEM_SANDBOX_ENV} is malformed`);
  }
  return { hidden: parsed.hidden, required: parsed.required, ...(parsed.instanceRoot ? { instanceRoot: parsed.instanceRoot } : {}) };
}

export const agentFilesystemSandboxHelper = path.join(import.meta.dirname, "agent-filesystem-sandbox.py");

/** Rewrites one launch so the helper applies the domain and then execs it unchanged. */
export function sandboxedInvocation(
  config: Pick<AgentFilesystemSandboxConfig, "hidden" | "required"> & { exposed?: readonly string[] },
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
      ...(config.exposed ?? []).flatMap((exposed) => ["--expose", exposed]),
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

/** What a sandboxed run must be able to do with each probe fixture path. */
const RUN_SCOPE_EXPECTATIONS = {
  otherDurableSession: "denied",
  durableSessionListing: "denied",
  ownDurableSession: "allowed",
  otherRunnerState: "denied",
  controlPlaneState: "denied",
  otherOpencodeSession: "denied",
  ownOpencodeSession: "allowed",
  acpxRuntime: "allowed",
  otherRunLog: "denied",
  databaseWal: "denied",
  secrets: "denied",
  otherProviderTrace: "denied",
  ownProviderTrace: "allowed",
  harnessEnviron: "denied",
} as const;

/**
 * Proves the run scope on a fixture instance laid out like the real one: a
 * sandboxed run keeps its own session and trace and loses every other run's
 * state, the instance database and its secrets.
 */
export function probeRunScopedSandbox(
  config: AgentFilesystemSandboxConfig,
  python = pythonExecutable(),
  env: NodeJS.ProcessEnv = process.env,
  harnessPid = process.pid,
) {
  if (!config.instanceRoot) return { result: {} as Record<string, string>, failures: [] as string[] };
  // A sibling of the instances directory: inside the attempt root, never in /tmp.
  const fixture = mkdtempSync(path.join(path.dirname(path.dirname(config.instanceRoot)), ".agent-sandbox-probe-"));
  try {
    const instance = path.join(fixture, "instance");
    const paths = instanceRunStatePaths(instance);
    const write = (file: string) => { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, "other run\n", { mode: 0o600 }); };
    const ownState = path.join(paths.durableSessions, "own-scope", "runner");
    mkdirSync(ownState, { recursive: true, mode: 0o700 });
    const fixtures = {
      otherDurableSession: path.join(paths.durableSessions, "other-scope", "opencode", "data", "opencode.db"),
      otherRunnerState: path.join(paths.runnerStates, "other-run", "state.json"),
      controlPlaneState: path.join(paths.controlPlane, "control-plane-state.json"),
      otherOpencodeSession: path.join(paths.opencode, "other-session", "data", "opencode", "opencode.db"),
      otherRunLog: path.join(paths.runLogs, "company", "agent", "other-run.ndjson"),
      databaseWal: path.join(paths.database, "pg_wal", "000000010000000000000001"),
      secrets: path.join(paths.secrets, "master.key"),
      otherProviderTrace: path.join(paths.providerTraces, "other-run.ndjson"),
    };
    for (const file of Object.values(fixtures)) write(file);
    const ownTrace = path.join(paths.providerTraces, "own-run.ndjson");
    const launch = runnerdLaunchSandbox({ ...config, instanceRoot: instance },
      ["--state-dir", ownState, "--session-id", "own-session"], { PAPERCLIP_PROVIDER_TRACE_PATH: ownTrace });
    prepareRunnerdLaunchSandbox(launch);
    const checks = [
      ["otherDurableSession", "read", fixtures.otherDurableSession],
      ["durableSessionListing", "list", paths.durableSessions],
      ["ownDurableSession", "write", ownState],
      ["otherRunnerState", "read", fixtures.otherRunnerState],
      ["controlPlaneState", "read", fixtures.controlPlaneState],
      ["otherOpencodeSession", "read", fixtures.otherOpencodeSession],
      ["ownOpencodeSession", "write", path.join(paths.opencode, "own-session")],
      ["acpxRuntime", "write", paths.acpx],
      ["otherRunLog", "read", fixtures.otherRunLog],
      ["databaseWal", "list", path.dirname(fixtures.databaseWal)],
      ["secrets", "read", fixtures.secrets],
      ["otherProviderTrace", "read", fixtures.otherProviderTrace],
      ["ownProviderTrace", "append", ownTrace],
      ["harnessEnviron", "read", `/proc/${harnessPid}/environ`],
      // Recorded, not required: Landlock cannot hide another process's argv.
      ["harnessCmdline", "read", `/proc/${harnessPid}/cmdline`],
    ] as const;
    const script = [
      'out=""',
      'for spec in "$@"; do name=${spec%%|*}; rest=${spec#*|}; mode=${rest%%|*}; target=${rest#*|}',
      '  case "$mode" in',
      '    read) cat "$target" >/dev/null 2>&1 ;;',
      '    list) ls "$target" >/dev/null 2>&1 ;;',
      '    write) f="$target/.agent-sandbox-probe" && : > "$f" 2>/dev/null && cat "$f" >/dev/null 2>&1 && rm -f "$f" ;;',
      '    append) printf "" >> "$target" 2>/dev/null && cat "$target" >/dev/null 2>&1 ;;',
      '  esac',
      '  if [ $? -eq 0 ]; then out="$out$name=allowed;"; else out="$out$name=denied;"; fi',
      'done',
      'printf "%s\\n" "$out"',
    ].join("\n");
    const invocation = sandboxedInvocation(launch, python, "/bin/sh", ["-c", script, "sh", ...checks.map(([name, mode, target]) => `${name}|${mode}|${target}`)], env);
    const output = execFileSync(invocation.command, invocation.args, { encoding: "utf8", cwd: "/", env, timeout: 30_000 });
    const result = Object.fromEntries(output.trim().split(";").filter(Boolean).map((entry) => {
      const separator = entry.lastIndexOf("=");
      return [`run:${entry.slice(0, separator)}`, entry.slice(separator + 1)];
    })) as Record<string, string>;
    const failures = Object.entries(RUN_SCOPE_EXPECTATIONS)
      .filter(([name, expected]) => result[`run:${name}`] !== expected)
      .map(([name, expected]) => `run scope: ${name} is ${result[`run:${name}`] ?? "unprobed"}, expected ${expected}`);
    return { result, failures };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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
    const runScope = probeRunScopedSandbox(config, python);
    probe = { result: { ...probe.result, ...runScope.result }, failures: [...probe.failures, ...runScope.failures] };
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
    const env = options?.env ?? process.env;
    const launch = runnerdLaunchSandbox(config, args, env);
    // The server creates the launch's own entries; inside the sandbox their
    // hidden parents accept no new entries. A failure here fails the launch.
    prepareRunnerdLaunchSandbox(launch);
    const invocation = sandboxedInvocation(launch, python, command as string, args, env);
    const result = Reflect.apply(original, this, [invocation.command, invocation.args, ...afterArgs]);
    const pid = (result as { pid?: number } | undefined)?.pid;
    const scope = config.instanceRoot ? ` ${JSON.stringify({ runScopedHidden: launch.hidden.filter((value) => !config.hidden.includes(value)), exposed: launch.exposed })}` : "";
    console.log(`[agent-filesystem-sandbox] runnerd launched inside the sandbox via ${api}${pid ? ` (pid ${pid})` : ""}${scope}`);
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
