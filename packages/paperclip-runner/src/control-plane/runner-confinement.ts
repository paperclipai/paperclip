import { execFileSync } from "node:child_process";
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
    hidden: [], exposed: [], exposedFiles: [], traversable: [], precreated: [],
    deniedLoopbackPorts: [...new Set((policy.deniedLoopbackPorts ?? []).filter((port) => Number.isInteger(port) && port > 0 && port < 65_536))],
  };
  const hide = (value: string) => { if (!scope.hidden.includes(value)) scope.hidden.push(value); };
  const expose = (value: string, file = false) => {
    if (!scope.exposed.includes(value)) scope.exposed.push(value);
    if (file && !scope.exposedFiles.includes(value)) scope.exposedFiles.push(value);
    const parent = dirname(value);
    if (!scope.traversable.includes(parent)) scope.traversable.push(parent);
  };
  for (const value of [paths.durableSessions, paths.runnerStates, paths.controlPlane, paths.sessions, paths.opencode, paths.runLogs,
    paths.providerTraces, paths.backups, paths.storage, paths.workspaceOperationLogs, paths.database, paths.secrets, paths.environmentFile]) hide(value);
  scope.precreated.push(paths.acpx, ...INSTANCE_SHARED_DIRECTORIES.map((name) => join(instanceRoot, ...name.split("/"))));
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
  if (trace && isAbsolute(trace) && dirname(resolve(trace)) === paths.providerTraces) expose(resolve(trace), true);
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
  const traversable = scope.traversable.map((path, index) => `(literal ${parameter("TRAVERSE", index, canonicalPath(path))})`);
  const profile = [
    "(version 1)",
    "(allow default)",
    ...(hidden.length ? [`(deny file-read* file-write* ${hidden.join(" ")})`] : []),
    ...(traversable.length ? [`(allow file-read-metadata ${traversable.join(" ")})`] : []),
    ...(exposed.length ? [`(allow file-read* file-write* ${exposed.join(" ")})`] : []),
    ...scope.deniedLoopbackPorts.map((port) => `(deny network-outbound (remote ip "localhost:${port}"))`),
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
FILE_RIGHTS = 7; ABI1 = (1 << 13) - 1; REFER = 1 << 13; TRUNCATE = 1 << 14; IOCTL_DEV = 1 << 15
class Attr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]
def fail(message, code=125):
    sys.stderr.write("runner_confinement: %s\n" % message); sys.stderr.flush(); os._exit(code)
def within(candidate, root):
    return candidate == root or candidate.startswith(root.rstrip("/") + "/")
argv = sys.argv[1:]; required = False; probe = False; hidden = []; exposed = []; command = None; i = 0
while i < len(argv):
    token = argv[i]
    if token == "--": command = argv[i + 1:]; break
    if token == "--required": required = True
    elif token == "--probe": probe = True
    elif token in ("--hide", "--expose") and i + 1 < len(argv):
        i += 1; value = os.path.realpath(argv[i])
        if not os.path.isabs(argv[i]) or value == "/": fail("invalid path: %s" % argv[i], 2)
        (hidden if token == "--hide" else exposed).append(value)
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
    handled = ABI1 | (REFER if abi >= 2 else 0) | (TRUNCATE if abi >= 3 else 0) | (IOCTL_DEV if abi >= 5 else 0)
    attr = Attr(handled)
    ruleset = syscall(ctypes.c_long(CREATE), ctypes.byref(attr), ctypes.c_long(ctypes.sizeof(attr)), ctypes.c_long(0))
    def allow(path):
        try: descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError: return
        try:
            mode = os.fstat(descriptor).st_mode
            access = handled if stat.S_ISDIR(mode) else handled & (FILE_RIGHTS | TRUNCATE | IOCTL_DEV)
            rule = ctypes.create_string_buffer(struct.pack("=Qi", access, descriptor), 12)
            syscall(ctypes.c_long(ADD), ctypes.c_long(ruleset), ctypes.c_long(1), rule, ctypes.c_long(0))
        finally: os.close(descriptor)
    def grant(directory):
        try: names = sorted(os.listdir(directory))
        except OSError: return
        for name in names:
            child = os.path.join(directory, name)
            if any(within(child, path) for path in hidden): continue
            try: is_link = os.path.islink(child); real = os.path.realpath(child)
            except OSError: continue
            if any(within(real, path) or within(path, real) for path in hidden):
                if not is_link and any(within(path, child) for path in hidden): grant(child)
                continue
            allow(child)
    grant("/")
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
if probe:
    try: syscall(ctypes.c_long(CREATE), ctypes.c_void_p(None), ctypes.c_long(0), ctypes.c_long(1))
    except OSError as error: fail("Landlock is unavailable (%s)" % error)
    os._exit(0)
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
      "--", command, ...args,
    ],
  };
}

const availability = new Map<string, string | null>();

/**
 * Proves once per process that this host can apply confinement. A server that
 * already runs inside a sandbox cannot nest one, so the probe uses the same
 * mechanism as a launch. Returns null when available, or the reason.
 */
export function runnerConfinementUnavailableReason(platform: NodeJS.Platform = process.platform): string | null {
  const cached = availability.get(platform);
  if (cached !== undefined) return cached;
  let reason: string | null = null;
  try {
    if (platform === "darwin") {
      if (!existsSync("/usr/bin/sandbox-exec")) reason = "sandbox-exec is not installed";
      else execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore", timeout: 10_000 });
    } else if (platform === "linux") {
      const python = pythonExecutable();
      if (!python) reason = "python3 is not installed";
      else {
        // Apply a real domain shaped like a launch: a hidden directory with an
        // exposed child. A host that passes runs every launch fail-closed.
        const probeRoot = mkdtempSync(join(tmpdir(), "paperclip-confinement-probe-"));
        try {
          mkdirSync(join(probeRoot, "hidden", "own"), { recursive: true });
          execFileSync(python, ["-I", "-S", "-c", LANDLOCK_HELPER, "--required",
            "--hide", join(probeRoot, "hidden"), "--expose", join(probeRoot, "hidden", "own"),
            "--", "/bin/sh", "-c", 'ls "$1" >/dev/null 2>&1 && exit 3; ls "$2" >/dev/null', "sh", join(probeRoot, "hidden"), join(probeRoot, "hidden", "own")],
          { stdio: "ignore", timeout: 30_000 });
        } finally {
          rmSync(probeRoot, { recursive: true, force: true });
        }
      }
    } else {
      reason = `confinement is not supported on ${platform}`;
    }
  } catch (error) {
    reason = `confinement probe failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
  availability.set(platform, reason);
  return reason;
}

/** Test seam: forget probe results. */
export function resetRunnerConfinementAvailability() {
  availability.clear();
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
}): { command: string; args: string[]; scope: RunnerConfinementScope } | null {
  const { policy } = input;
  if (policy.mode === "off") return null;
  const platform = input.platform ?? process.platform;
  const reason = runnerConfinementUnavailableReason(platform);
  if (reason !== null) {
    if (policy.mode === "required") throw new RunnerConfinementUnavailableError(reason);
    if (!warned.has(reason)) {
      warned.add(reason);
      process.emitWarning(`Local agent sessions run without per-session confinement: ${reason}`, { code: RUNNER_CONFINEMENT_UNAVAILABLE });
    }
    return null;
  }
  const scope = runnerConfinementScope(policy, input.args, input.environment);
  prepareRunnerConfinementScope(scope);
  if (platform === "darwin") return { ...seatbeltInvocation(scope, input.command, input.args), scope };
  const python = pythonExecutable()!;
  // The probe proved this host applies the same domain, so a launch that cannot
  // apply its own fails closed instead of running unconfined unnoticed.
  return { ...landlockInvocation(scope, python, true, input.command, input.args), scope };
}
