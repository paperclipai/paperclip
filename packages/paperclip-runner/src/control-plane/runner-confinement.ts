import { execFile, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Local native sessions run as the server's operating-system user, so file
 * modes cannot keep one session out of another's state. A confined launch
 * starts runnerd inside an operating-system scope that every descendant
 * inherits (provider, tools, shell): the session keeps its own saved state and
 * loses every other session's, the instance database files, run logs and
 * secrets. macOS uses a Seatbelt profile through `sandbox-exec`; Linux uses a
 * Landlock domain. Both replace themselves with runnerd (same PID and argv).
 */
export const RUNNER_CONFINEMENT_UNAVAILABLE = "runner_confinement_unavailable";

/** `auto` confines where supported, `required` refuses to launch otherwise, `off` never confines. */
export type RunnerConfinementMode = "auto" | "required" | "off";

export interface RunnerConfinementPolicy {
  mode: RunnerConfinementMode;
  /** The instance root that holds every session's state. */
  instanceRoot: string;
  /** Loopback TCP ports a confined session may not connect to, such as the embedded database. */
  deniedLoopbackPorts?: readonly number[];
  /** The session's company: other companies' directories under `companies/` are hidden. */
  companyId?: string;
  /**
   * Roots that hold one directory per session, such as an operator-configured
   * runner state directory outside the instance root. Each is hidden except
   * the launch's own `<root>/<session>` directory.
   */
  sessionStateRoots?: readonly string[];
  /** Instance-private paths outside the default layout, such as configured storage or the secrets key. */
  privatePaths?: readonly string[];
  /**
   * Paths a session may read and execute but not change, such as the server's
   * own installation: code the server user runs later must not be replaced
   * from inside a session.
   */
  readOnlyPaths?: readonly string[];
}

export interface RunnerConfinementScope {
  hidden: string[];
  /** The launch's own entries beneath hidden directories. */
  exposed: string[];
  /** Exposed paths that are files rather than directories. */
  exposedFiles: string[];
  /**
   * Hidden directories that hold an exposed entry. Their own metadata stays
   * readable so a provider can resolve and create paths through them; their
   * listing and every other entry stay hidden.
   */
  traversable: string[];
  /** Shared directories created before launch: Landlock leaves a hidden path's parent without new entries. */
  precreated: string[];
  deniedLoopbackPorts: number[];
  /** Readable and executable, never writable. */
  readOnly: string[];
}

export class RunnerConfinementUnavailableError extends Error {
  readonly code = RUNNER_CONFINEMENT_UNAVAILABLE;
  constructor(detail: string) {
    super(`${RUNNER_CONFINEMENT_UNAVAILABLE}: ${detail}`);
    this.name = "RunnerConfinementUnavailableError";
  }
}

function within(candidate: string, root: string) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Resolves symbolic links in the longest existing prefix, so profiles match the kernel's path. */
export function canonicalPath(value: string): string {
  const absolute = resolve(value);
  const suffix: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync(current), ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

function flagValue(args: readonly string[], flag: string) {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Mirrors opencodeRuntimeSessionDirectoryName in the OpenCode driver. */
function opencodeSessionDirectoryName(normalizedSessionId: string) {
  const safe = normalizedSessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return safe && safe !== "." && safe !== ".." ? safe : null;
}

/** Instance paths that hold every session's state, or the instance's own secrets. */
export function instanceSessionStatePaths(instanceRoot: string) {
  const runner = join(instanceRoot, "runtime", "paperclip-runner");
  return {
    durableSessions: join(runner, "durable-sessions"),
    runnerStates: join(runner, "runner"),
    controlPlane: join(runner, "control-plane"),
    sessions: join(runner, "sessions"),
    opencode: join(runner, "opencode"),
    acpx: join(runner, "acpx"),
    runLogs: join(instanceRoot, "data", "run-logs"),
    providerTraces: join(instanceRoot, "data", "provider-traces"),
    backups: join(instanceRoot, "data", "backups"),
    storage: join(instanceRoot, "data", "storage"),
    workspaceOperationLogs: join(instanceRoot, "data", "workspace-operation-logs"),
    database: join(instanceRoot, "db"),
    secrets: join(instanceRoot, "secrets"),
    environmentFile: join(instanceRoot, ".env"),
  };
}

/** Instance directories a session may use, created before launch beside hidden ones. */
const INSTANCE_SHARED_DIRECTORIES = ["companies", "projects", "workspaces", "runtime-context-assets", "skills", "runtime/provider-packs"] as const;

/**
 * Selects one runnerd launch's scope. Runnerd is launched per session with
 * `--state-dir` inside that session's directory, so the launch keeps exactly
 * its own durable session, OpenCode session and provider trace.
 */
export function runnerConfinementScope(policy: RunnerConfinementPolicy, args: readonly string[], env: NodeJS.ProcessEnv): RunnerConfinementScope {
  const instanceRoot = resolve(policy.instanceRoot);
  const paths = instanceSessionStatePaths(instanceRoot);
  const scope: RunnerConfinementScope = {
    hidden: [], exposed: [], exposedFiles: [], traversable: [], precreated: [], readOnly: [],
    deniedLoopbackPorts: [...new Set((policy.deniedLoopbackPorts ?? []).filter((port) => Number.isInteger(port) && port > 0 && port < 65_536))],
  };
  const hide = (value: string) => { if (!scope.hidden.includes(value)) scope.hidden.push(value); };
  const expose = (value: string, file = false) => {
    if (!scope.exposed.includes(value)) scope.exposed.push(value);
    if (file && !scope.exposedFiles.includes(value)) scope.exposedFiles.push(value);
    const parent = dirname(value);
    if (!scope.traversable.includes(parent)) scope.traversable.push(parent);
  };
  // ACPX provider homes hold other sessions' provider credentials; confined providers do not use them.
  for (const value of [paths.durableSessions, paths.runnerStates, paths.controlPlane, paths.sessions, paths.opencode, paths.acpx, paths.runLogs,
    paths.providerTraces, paths.backups, paths.storage, paths.workspaceOperationLogs, paths.database, paths.secrets, paths.environmentFile]) hide(value);
  scope.precreated.push(...INSTANCE_SHARED_DIRECTORIES.map((name) => join(instanceRoot, ...name.split("/"))));
  const companyId = policy.companyId?.trim();
  if (companyId && /^[A-Za-z0-9._-]+$/.test(companyId) && companyId !== "." && companyId !== "..") {
    const companies = join(instanceRoot, "companies");
    hide(companies);
    expose(join(companies, companyId));
  }
  const stateDirectory = flagValue(args, "--state-dir");
  const state = stateDirectory && isAbsolute(stateDirectory) ? resolve(stateDirectory) : null;
  // Never hide the instance root or a directory above it: an operator may
  // point a configured root at a broad directory.
  const holdsInstance = (value: string) => within(instanceRoot, value);
  const sessionRoots = [paths.durableSessions, paths.runnerStates, paths.sessions];
  for (const configured of policy.sessionStateRoots ?? []) {
    const root = resolve(configured);
    if (!isAbsolute(configured) || sessionRoots.includes(root) || holdsInstance(root) || state === root) continue;
    sessionRoots.push(root);
    hide(root);
  }
  for (const configured of policy.privatePaths ?? []) {
    const path = resolve(configured);
    // A private path that holds the launch's own state would hide the session from itself.
    if (isAbsolute(configured) && !holdsInstance(path) && (state === null || !within(state, path))) hide(path);
  }
  for (const configured of policy.readOnlyPaths ?? []) {
    const path = resolve(configured);
    // Never freeze the instance or the launch's own state.
    if (isAbsolute(configured) && !holdsInstance(path) && !within(path, instanceRoot) && (state === null || !within(state, path))
      && !scope.readOnly.includes(path)) scope.readOnly.push(path);
  }
  if (state) {
    for (const root of sessionRoots) {
      if (!within(state, root) || state === root) continue;
      // The session's own directory: `<root>/<scope>`, whatever lies below it.
      expose(join(root, relative(root, state).split(sep)[0]!));
    }
  }
  const sessionId = flagValue(args, "--session-id");
  const configuredOpencode = env.PAPERCLIP_OPENCODE_RUNTIME_DIR?.trim();
  for (const root of [paths.opencode, ...(configuredOpencode && isAbsolute(configuredOpencode) ? [resolve(configuredOpencode)] : [])]) {
    // A runtime directory inside hidden state is already covered by that state's rule.
    if (root !== paths.opencode && scope.hidden.some((hidden) => within(root, hidden))) continue;
    hide(root);
    const name = sessionId ? opencodeSessionDirectoryName(sessionId) : null;
    if (name) expose(join(root, name));
  }
  const trace = env.PAPERCLIP_PROVIDER_TRACE_PATH?.trim();
  if (trace && isAbsolute(trace)) {
    const file = resolve(trace);
    if (within(file, paths.providerTraces) && file !== paths.providerTraces) {
      expose(file, true);
      // A nested trace keeps the metadata of each hidden directory above it readable.
      for (let parent = dirname(dirname(file)); within(parent, paths.providerTraces); parent = dirname(parent)) {
        if (!scope.traversable.includes(parent)) scope.traversable.push(parent);
        if (parent === paths.providerTraces) break;
      }
    }
  }
  return scope;
}

/** Creates the launch's own entries, which a process inside the scope may not be able to create. */
export function prepareRunnerConfinementScope(scope: RunnerConfinementScope) {
  for (const directory of scope.precreated) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const exposed of scope.exposed) {
    if (scope.exposedFiles.includes(exposed)) {
      mkdirSync(dirname(exposed), { recursive: true, mode: 0o700 });
      // Append mode never truncates a trace the run already started.
      closeSync(openSync(exposed, "a", 0o600));
    } else {
      mkdirSync(exposed, { recursive: true, mode: 0o700 });
    }
  }
}

/**
 * The Seatbelt profile for a scope. Paths travel as `-D` parameters, never
 * inside the profile text, so no path can change the profile. The last
 * matching rule wins: hidden paths are denied, then the launch's own entries
 * beneath them are allowed again. A sandboxed process also cannot execute
 * set-user-ID programs such as `ps`, which would otherwise read other
 * processes' environments.
 */
export function seatbeltInvocation(scope: RunnerConfinementScope, command: string, args: readonly string[]) {
  const parameters: string[] = [];
  const parameter = (prefix: string, index: number, value: string) => {
    const name = `${prefix}${index}`;
    parameters.push("-D", `${name}=${value}`);
    return `(param "${name}")`;
  };
  const hidden = scope.hidden.map((path, index) => {
    const canonical = canonicalPath(path);
    return `(subpath ${parameter("HIDE", index, canonical)})`;
  });
  const exposed = scope.exposed.map((path, index) => {
    const canonical = canonicalPath(path);
    const filter = scope.exposedFiles.includes(path) ? "literal" : "subpath";
    return `(${filter} ${parameter("EXPOSE", index, canonical)})`;
  });
  const readOnly = scope.readOnly.map((path, index) => `(subpath ${parameter("READONLY", index, canonicalPath(path))})`);
  const traversable = scope.traversable.map((path, index) => `(literal ${parameter("TRAVERSE", index, canonicalPath(path))})`);
  const profile = [
    "(version 1)",
    "(allow default)",
    ...(hidden.length ? [`(deny file-read* file-write* ${hidden.join(" ")})`] : []),
    ...(traversable.length ? [`(allow file-read-metadata ${traversable.join(" ")})`] : []),
    ...(exposed.length ? [`(allow file-read* file-write* ${exposed.join(" ")})`] : []),
    ...scope.deniedLoopbackPorts.map((port) => `(deny network-outbound (remote ip "localhost:${port}"))`),
    // Last, so no earlier allow can make these writable.
    ...(readOnly.length ? [`(deny file-write* ${readOnly.join(" ")})`] : []),
  ].join("\n");
  return { command: "/usr/bin/sandbox-exec", args: [...parameters, "-p", profile, command, ...args] };
}

/**
 * Applies a Linux Landlock domain that grants everything except the hidden
 * paths (and re-grants the exposed ones), then replaces itself with the
 * command. Without Landlock it exits 125 under --required and otherwise runs
 * the command unconfined. Run with `python3 -I -S -c`.
 */
export const LANDLOCK_HELPER = String.raw`
import ctypes, os, stat, struct, sys
CREATE, ADD, RESTRICT = 444, 445, 446
FILE_RIGHTS = 7; READ_ONLY_RIGHTS = 1 | 4 | 8; ABI1 = (1 << 13) - 1; REFER = 1 << 13; TRUNCATE = 1 << 14; IOCTL_DEV = 1 << 15
class Attr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]
def fail(message, code=125):
    sys.stderr.write("runner_confinement: %s\n" % message); sys.stderr.flush(); os._exit(code)
def within(candidate, root):
    return candidate == root or candidate.startswith(root.rstrip("/") + "/")
argv = sys.argv[1:]; required = False; hidden = []; exposed = []; readonly = []; command = None; i = 0
while i < len(argv):
    token = argv[i]
    if token == "--": command = argv[i + 1:]; break
    if token == "--required": required = True
    elif token in ("--hide", "--expose", "--read-only") and i + 1 < len(argv):
        i += 1; value = os.path.realpath(argv[i])
        if not os.path.isabs(argv[i]) or value == "/": fail("invalid path: %s" % argv[i], 2)
        {"--hide": hidden, "--expose": exposed, "--read-only": readonly}[token].append(value)
    else: fail("unexpected argument: %s" % token, 2)
    i += 1
libc = ctypes.CDLL(None, use_errno=True); libc.syscall.restype = ctypes.c_long
def syscall(*args):
    result = libc.syscall(*args)
    if result < 0:
        error = ctypes.get_errno(); raise OSError(error, os.strerror(error))
    return result
def restrict():
    abi = syscall(ctypes.c_long(CREATE), ctypes.c_void_p(None), ctypes.c_long(0), ctypes.c_long(1))
    # Below ABI 3 Landlock cannot deny truncate(), so a hidden file could still be erased.
    if abi < 3: raise RuntimeError("Landlock ABI %d cannot deny truncation; ABI 3 or newer is required" % abi)
    handled = ABI1 | (REFER if abi >= 2 else 0) | (TRUNCATE if abi >= 3 else 0) | (IOCTL_DEV if abi >= 5 else 0)
    attr = Attr(handled)
    ruleset = syscall(ctypes.c_long(CREATE), ctypes.byref(attr), ctypes.c_long(ctypes.sizeof(attr)), ctypes.c_long(0))
    def allow(path, read_only=False):
        try: descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError: return
        try:
            mode = os.fstat(descriptor).st_mode
            access = handled if stat.S_ISDIR(mode) else handled & (FILE_RIGHTS | TRUNCATE | IOCTL_DEV)
            # Execute, read file, read directory.
            if read_only: access &= READ_ONLY_RIGHTS
            rule = ctypes.create_string_buffer(struct.pack("=Qi", access, descriptor), 12)
            syscall(ctypes.c_long(ADD), ctypes.c_long(ruleset), ctypes.c_long(1), rule, ctypes.c_long(0))
        finally: os.close(descriptor)
    # Read-only paths are walked around like hidden ones, then granted read access.
    blocked = hidden + readonly
    def grant(directory):
        try: names = sorted(os.listdir(directory))
        except OSError: return
        for name in names:
            child = os.path.join(directory, name)
            if any(within(child, path) for path in blocked): continue
            try: is_link = os.path.islink(child); real = os.path.realpath(child)
            except OSError: continue
            if any(within(real, path) or within(path, real) for path in blocked):
                if not is_link and any(within(path, child) for path in blocked): grant(child)
                continue
            allow(child)
    grant("/")
    # A read-only tree may hold hidden paths (an install's config.json): grant
    # read access around them instead of to the whole tree.
    def grant_read_only(path):
        if any(within(path, hidden_path) for hidden_path in hidden): return
        if not any(within(hidden_path, path) for hidden_path in hidden):
            allow(path, read_only=True); return
        try: names = sorted(os.listdir(path))
        except OSError: return
        for name in names:
            child = os.path.join(path, name)
            if os.path.islink(child) and any(within(os.path.realpath(child), h) or within(h, os.path.realpath(child)) for h in hidden): continue
            grant_read_only(child)
    for path in readonly: grant_read_only(path)
    for path in exposed: allow(path)
    if libc.prctl(ctypes.c_int(38), ctypes.c_ulong(1), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
        raise RuntimeError("prctl(PR_SET_NO_NEW_PRIVS) failed")
    syscall(ctypes.c_long(RESTRICT), ctypes.c_long(ruleset), ctypes.c_long(0)); os.close(ruleset)
    for path in hidden:
        try:
            if os.path.isdir(path): os.listdir(path)
            else: os.close(os.open(path, os.O_RDONLY | os.O_CLOEXEC))
        except OSError: continue
        raise RuntimeError("confinement ineffective: %s is still readable" % path)
if not command: fail("missing command", 2)
if hidden:
    try: restrict()
    except (OSError, RuntimeError) as error:
        if required: fail(str(error))
        sys.stderr.write("runner_confinement: continuing without confinement: %s\n" % error)
try: os.execv(command[0], command) if os.path.isabs(command[0]) else os.execvp(command[0], command)
except OSError as error: fail("cannot execute %s: %s" % (command[0], error), 127)
`;

export function pythonExecutable() {
  for (const candidate of ["/usr/bin/python3", "/usr/local/bin/python3"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function landlockInvocation(scope: RunnerConfinementScope, python: string, required: boolean, command: string, args: readonly string[]) {
  return {
    command: python,
    args: [
      "-I", "-S", "-c", LANDLOCK_HELPER,
      ...(required ? ["--required"] : []),
      ...scope.hidden.flatMap((path) => ["--hide", path]),
      ...scope.exposed.flatMap((path) => ["--expose", path]),
      ...scope.readOnly.flatMap((path) => ["--read-only", path]),
      "--", command, ...args,
    ],
  };
}

/** A transient probe failure (timeout, no memory, full disk) is retried after this delay. */
export const RUNNER_CONFINEMENT_PROBE_RETRY_MS = 60_000;
const availability = new Map<string, { reason: string | null; retryAt: number | null }>();

type ProbePlan =
  | { reason: string }
  | { command: string; args: string[]; timeout: number; cleanup?: () => void };

/**
 * The probe uses the same mechanism as a launch, so a server that already runs
 * inside a sandbox (which cannot nest one) is detected.
 */
function probePlan(platform: NodeJS.Platform): ProbePlan {
  if (platform === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec")) return { reason: "sandbox-exec is not installed" };
    return { command: "/usr/bin/sandbox-exec", args: ["-p", "(version 1)(allow default)", "/usr/bin/true"], timeout: 10_000 };
  }
  if (platform !== "linux") return { reason: `confinement is not supported on ${platform}` };
  const python = pythonExecutable();
  if (!python) return { reason: "python3 is not installed" };
  // Apply a real domain shaped like a launch: a hidden directory with an
  // exposed child. A host that passes runs every launch fail-closed.
  const probeRoot = mkdtempSync(join(tmpdir(), "paperclip-confinement-probe-"));
  mkdirSync(join(probeRoot, "hidden", "own"), { recursive: true });
  return {
    command: python,
    args: ["-I", "-S", "-c", LANDLOCK_HELPER, "--required",
      "--hide", join(probeRoot, "hidden"), "--expose", join(probeRoot, "hidden", "own"),
      "--", "/bin/sh", "-c", 'ls "$1" >/dev/null 2>&1 && exit 3; ls "$2" >/dev/null', "sh", join(probeRoot, "hidden"), join(probeRoot, "hidden", "own")],
    timeout: 30_000,
    cleanup: () => rmSync(probeRoot, { recursive: true, force: true }),
  };
}

function recordProbe(platform: NodeJS.Platform, error: unknown, reason: string | null = null) {
  let transient = false;
  if (error !== undefined) {
    reason = `confinement probe failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    // A probe that ran and exited non-zero is a definitive answer about this host.
    // Anything else (a timeout, a spawn or disk error) may pass on a later launch.
    const failure = error as { status?: unknown; code?: unknown; signal?: unknown; killed?: unknown };
    const exited = typeof failure.status === "number" || typeof failure.code === "number";
    transient = !exited || failure.signal != null || failure.killed === true;
  }
  availability.set(platform, { reason, retryAt: transient ? Date.now() + RUNNER_CONFINEMENT_PROBE_RETRY_MS : null });
  return reason;
}

function cachedReason(platform: NodeJS.Platform): { reason: string | null } | null {
  const cached = availability.get(platform);
  return cached !== undefined && (cached.retryAt === null || Date.now() < cached.retryAt) ? { reason: cached.reason } : null;
}

const pendingProbes = new Map<string, Promise<string | null>>();

/**
 * Proves, without blocking the event loop, that this host can apply
 * confinement. Concurrent launches share one probe. Launch paths await this
 * before `spawnRunner`, so the launch itself reads the cached result.
 */
export function ensureRunnerConfinementProbe(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const cached = cachedReason(platform);
  if (cached) return Promise.resolve(cached.reason);
  const pending = pendingProbes.get(platform);
  if (pending) return pending;
  const probe = (async () => {
    let plan: ProbePlan;
    try {
      plan = probePlan(platform);
    } catch (error) {
      return recordProbe(platform, error);
    }
    if ("reason" in plan) return recordProbe(platform, undefined, plan.reason);
    try {
      await new Promise<void>((resolveProbe, rejectProbe) => {
        execFile(plan.command, plan.args, { timeout: plan.timeout }, (error) => (error ? rejectProbe(error) : resolveProbe()));
      });
      return recordProbe(platform, undefined, null);
    } catch (error) {
      return recordProbe(platform, error);
    } finally {
      plan.cleanup?.();
    }
  })().finally(() => pendingProbes.delete(platform));
  pendingProbes.set(platform, probe);
  return probe;
}

/**
 * The cached probe result, or a synchronous probe for a caller that did not
 * await `ensureRunnerConfinementProbe`. Returns null when available, or the reason.
 */
export function runnerConfinementUnavailableReason(platform: NodeJS.Platform = process.platform): string | null {
  const cached = cachedReason(platform);
  if (cached) return cached.reason;
  let plan: ProbePlan;
  try {
    plan = probePlan(platform);
  } catch (error) {
    return recordProbe(platform, error);
  }
  if ("reason" in plan) return recordProbe(platform, undefined, plan.reason);
  try {
    execFileSync(plan.command, plan.args, { stdio: "ignore", timeout: plan.timeout });
    return recordProbe(platform, undefined, null);
  } catch (error) {
    return recordProbe(platform, error);
  } finally {
    plan.cleanup?.();
  }
}

/** Test seam: forget probe results. */
export function resetRunnerConfinementAvailability() {
  availability.clear();
}

/** Test seam: record a probe result without running the probe. */
export function setRunnerConfinementAvailabilityForTest(platform: NodeJS.Platform, reason: string | null, retryAt: number | null = null) {
  availability.set(platform, { reason, retryAt });
}

/**
 * Landlock hides a path by leaving its ancestors ungranted, and an ungranted
 * directory accepts no new entries. Instance state inside a shared temporary
 * directory would stop every confined process creating files there (mktemp,
 * runnerd's activity pipe), so such a host does not confine on Linux.
 */
export function landlockTemporaryConflict(platform: NodeJS.Platform, scope: RunnerConfinementScope, sharedTemporaryDirectories?: readonly string[]) {
  if (platform !== "linux") return null;
  const shared = [...new Set((sharedTemporaryDirectories ?? [tmpdir(), "/tmp", "/var/tmp"]).map(canonicalPath))];
  // Read-only paths leave their ancestors without new entries too.
  const conflict = [...scope.hidden, ...scope.readOnly].map(canonicalPath).find((hidden) => shared.some((temporary) => hidden !== temporary && within(hidden, temporary)));
  return conflict ? "instance state lies in a shared temporary directory" : null;
}

const warned = new Set<string>();

/**
 * Rewrites one local runnerd launch into its confined form, or returns null to
 * launch it unconfined (mode `off`, or `auto` on a host that cannot confine).
 * Mode `required` throws a named, permanent error instead of running unconfined.
 */
export function confineRunnerLaunch(input: {
  policy: RunnerConfinementPolicy;
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test seam: the shared temporary directories (default: the OS temporary directory, /tmp and /var/tmp). */
  sharedTemporaryDirectories?: readonly string[];
}): { command: string; args: string[]; scope: RunnerConfinementScope } | null {
  const { policy } = input;
  if (policy.mode === "off") return null;
  const platform = input.platform ?? process.platform;
  const scope = runnerConfinementScope(policy, input.args, input.environment);
  const reason = landlockTemporaryConflict(platform, scope, input.sharedTemporaryDirectories)
    ?? runnerConfinementUnavailableReason(platform);
  if (reason !== null) {
    if (policy.mode === "required") throw new RunnerConfinementUnavailableError(reason);
    if (!warned.has(reason)) {
      warned.add(reason);
      process.emitWarning(`Local agent sessions run without per-session confinement: ${reason}`, { code: RUNNER_CONFINEMENT_UNAVAILABLE });
    }
    return null;
  }
  prepareRunnerConfinementScope(scope);
  if (platform === "darwin") return { ...seatbeltInvocation(scope, input.command, input.args), scope };
  const python = pythonExecutable()!;
  // The probe proved this host applies the same domain, so a launch that cannot
  // apply its own fails closed instead of running unconfined unnoticed.
  return { ...landlockInvocation(scope, python, true, input.command, input.args), scope };
}
