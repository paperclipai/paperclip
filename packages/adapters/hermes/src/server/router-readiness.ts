/**
 * Ramp Router readiness and credential safety for Hermes Local runs (TECH-7895).
 *
 * Hermes ships a native `router` provider authenticated with RAMP_ROUTER_API_KEY against a fixed
 * endpoint. Paperclip guarantees, for every run:
 *  - endpoint-override / alias variables never reach the child, whatever layer supplied them
 *    (agent adapter env, inherited host profile env, or the parent process);
 *  - a Router run carries the canonical RAMP_ROUTER_API_KEY itself — another provider's key never
 *    satisfies a Router run, and the provider is never silently swapped;
 *  - the installed Hermes the run will actually execute registers the native Router provider with
 *    the expected contract, checked by a bounded, sandboxed registry probe run through that
 *    installation's own interpreter (no inference, no credentials, no network) before launch.
 *    `hermes chat --help` cannot be used: it deliberately lists no provider choices;
 *  - a remote/sandbox execution target is rejected: this adapter only executes locally, so probing
 *    the server host would not say anything about a remote installation.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAgentChildBaseEnv } from "@paperclipai/adapter-utils/agent-child-env";

import { ROUTER_PROVIDER } from "../shared/constants.js";

export const RAMP_ROUTER_API_KEY_ENV = "RAMP_ROUTER_API_KEY";

/** Exact legacy/alias names that could redirect or replace the canonical Router credential. */
const ROUTER_ALIAS_ENV_NAMES: ReadonlySet<string> = new Set([
  "ROUTER_API_KEY",
  "ROUTER_BASE_URL",
  "ROUTER_API_BASE",
]);

/**
 * Generic OpenAI-SDK endpoint variables. A Responses-API client may fall back to them when it is not
 * given an explicit base URL, so they are removed from Router runs only (non-Router runs keep them).
 */
const ROUTER_RUN_SDK_ENDPOINT_ENV_NAMES: readonly string[] = ["OPENAI_BASE_URL", "OPENAI_API_BASE"];

/**
 * Python module-resolution variables that can point an import at a different `hermes_cli`/`providers`
 * than the installed one. A Router run strips them from its final child env (see `execute.ts`) so the
 * registry that actually loads is the installed installation's; the readiness probe strips the same
 * names, so probe and run always agree. PYTHONUSERBASE must not reintroduce a configured user site
 * outside the fresh HOME used by each process. User-site behavior stays in play on both sides:
 * PYTHONNOUSERSITE is passed through exactly as the launch pins it, never forced either way.
 */
export const ROUTER_RUN_STRIPPED_PYTHON_ENV_NAMES: readonly string[] = ["PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE"];

/**
 * True for any variable that could point the Router credential somewhere other than Hermes's
 * built-in Router endpoint: every RAMP_ROUTER_* name except the canonical key, plus legacy aliases.
 */
export function isRouterEndpointOverrideEnvName(name: string): boolean {
  if (name === RAMP_ROUTER_API_KEY_ENV) return false;
  return name.startsWith("RAMP_ROUTER_") || ROUTER_ALIAS_ENV_NAMES.has(name);
}

/**
 * Names to remove from (and unset in) the final child env. Always includes the fixed alias set so
 * `unsetEnvKeys` removes them even if a later layer would re-add them.
 */
export function routerEnvNamesToStrip(
  env: Record<string, string | undefined>,
  isRouterRun: boolean,
): string[] {
  const names = new Set<string>(["RAMP_ROUTER_BASE_URL", ...ROUTER_ALIAS_ENV_NAMES]);
  for (const name of Object.keys(env)) {
    if (isRouterEndpointOverrideEnvName(name)) names.add(name);
  }
  if (isRouterRun) for (const name of ROUTER_RUN_SDK_ENDPOINT_ENV_NAMES) names.add(name);
  return [...names].sort();
}

/** The canonical, non-blank Router key from a resolved env, or undefined. */
export function readRouterApiKey(env: Record<string, unknown> | null | undefined): string | undefined {
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
  const value = (env as Record<string, unknown>)[RAMP_ROUTER_API_KEY_ENV];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isRouterProvider(provider: string | null | undefined): boolean {
  return typeof provider === "string" && provider.trim().toLowerCase() === ROUTER_PROVIDER;
}

export const ROUTER_KEY_MISSING_MESSAGE =
  "Refusing to start: this agent uses the Ramp Router provider but no RAMP_ROUTER_API_KEY is configured. " +
  "Bind a Ramp Router API key through the agent's adapter env (company secret reference). " +
  "Other providers' keys are not used for Router, and the provider is never switched automatically.";

export const ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE =
  "Refusing to start: the Ramp Router provider is only supported for Hermes Local runs on the Paperclip host. " +
  "This run targets a remote/sandbox environment, which the Hermes Local adapter does not execute in. " +
  "Select the local environment for this agent.";

export const ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE =
  "Refusing to start: extra Hermes CLI arguments (extraArgs) are not supported with the Ramp Router provider, " +
  "because Hermes parses them before Paperclip's own flags and they could select another profile, provider or endpoint. " +
  "Remove extraArgs from this agent's configuration.";

/** Shown by the environment test: host-side overrides never apply to a Router run. */
export const ROUTER_FRESH_PROFILE_NOTE =
  "Ramp Router runs use a fresh per-run Hermes profile: host endpoint overrides (RAMP_ROUTER_BASE_URL, model.base_url), " +
  "auth/credential pools and provider plugins from the host Hermes dir are not used.";

/** True when the run targets a remote (SSH/sandbox) environment rather than the local host. */
export function isRemoteExecutionTarget(ctx: {
  executionTarget?: { kind?: string } | null;
  executionTransport?: { remoteExecution?: Record<string, unknown> | null } | null;
}): boolean {
  if (ctx.executionTarget && ctx.executionTarget.kind && ctx.executionTarget.kind !== "local") return true;
  return Boolean(ctx.executionTransport?.remoteExecution);
}

// ---------------------------------------------------------------------------
// Launcher resolution
// ---------------------------------------------------------------------------

export const ROUTER_CANONICAL_BASE_URL = "https://api.router.com/v1";

/** Largest launcher file inspected. Python console-script entrypoints are a few hundred bytes. */
const MAX_LAUNCHER_BYTES = 8 * 1024;

const PYTHON_BASENAME = /^python(?:\d+(?:\.\d+)?)?$/;

export const ROUTER_LAUNCHER_GUIDANCE =
  "Point the agent's Hermes command at the Hermes console entrypoint installed with Hermes " +
  "(a Python script starting with `#!<python>` that runs `hermes_cli.main:main`, e.g. <venv>/bin/hermes), " +
  "not a shell wrapper or compiled binary, so Paperclip can verify Ramp Router support.";

/**
 * Resolve a command to the executable that will actually run, using the env's PATH for bare names.
 *
 * A relative command that contains a separator (`./.venv/bin/hermes`) is resolved against `cwd` —
 * the directory the run itself launches in — never the server process cwd. With no `cwd` supplied
 * such a command is rejected, because guessing the server's cwd would verify a different file from
 * the one the run executes.
 */
export function resolveExecutablePath(
  command: string,
  pathEnv: string | undefined,
  cwd?: string,
): string | null {
  const isExecutable = (candidate: string) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes("/") || command.includes(path.sep)) {
    if (!path.isAbsolute(command) && !cwd) return null;
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd as string, command);
    return isExecutable(absolute) ? absolute : null;
  }
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export type HermesLauncherResolution =
  | {
      ok: true;
      /** Real path of the console-script launcher (symlinks followed). */
      launcherPath: string;
      /** Directory Python puts first on sys.path when it runs the launcher. */
      launcherDir: string;
      /** Interpreter from the shebang, deliberately NOT realpath'd so venv detection is preserved. */
      interpreter: string;
    }
  | { ok: false; reason: "error" | "unknown"; message: string };

function readBoundedFile(file: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_LAUNCHER_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buf, read, st.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Lines a pip/uv-generated console script for `hermes_cli.main:main` may contain (after the
 * shebang, ignoring blank lines and comments). Anything else is not a recognized entrypoint.
 */
const CONSOLE_SCRIPT_LINES: readonly RegExp[] = [
  /^import (?:re|sys)$/,
  /^from hermes_cli\.main import main$/,
  /^if __name__ == (['"])__main__\1:$/,
  /^sys\.argv\[0\] = re\.sub\(.*\)$/,
  /^sys\.exit\(main\(\)\)$/,
];

/**
 * Identify the Python interpreter and import context a Hermes console entrypoint runs with. Only a
 * plain Python console script for `hermes_cli.main:main` is accepted; its shebang is parsed, never
 * executed by a shell. Shell wrappers, binaries and unrecognized env indirections are "unknown".
 */
export function resolveHermesPythonLauncher(
  command: string,
  pathEnv: string | undefined,
  cwd?: string,
): HermesLauncherResolution {
  const executable = resolveExecutablePath(command, pathEnv, cwd);
  if (!executable) {
    return {
      ok: false,
      reason: "error",
      message: `Cannot verify Ramp Router support: Hermes command "${command}" was not found or is not executable.`,
    };
  }
  const unknown = (detail: string): HermesLauncherResolution => ({
    ok: false,
    reason: "unknown",
    message: `Cannot verify Ramp Router support: "${command}" ${detail}. ${ROUTER_LAUNCHER_GUIDANCE}`,
  });

  let launcherPath: string;
  try {
    launcherPath = realpathSync(executable);
  } catch {
    return unknown("could not be inspected");
  }
  const content = readBoundedFile(launcherPath);
  if (!content || content.includes(0)) return unknown("is not a recognized Python console entrypoint");
  const lines = content.toString("utf8").split(/\r?\n/);
  const shebang = lines[0] ?? "";
  if (!shebang.startsWith("#!")) return unknown("is not a recognized Python console entrypoint");

  const tokens = shebang.slice(2).trim().split(/\s+/).filter(Boolean);
  let interpreter: string | null = null;
  if (tokens.length === 1 && path.isAbsolute(tokens[0]) && PYTHON_BASENAME.test(path.basename(tokens[0]))) {
    interpreter = tokens[0];
  } else if (
    tokens.length === 2 &&
    tokens[0] === "/usr/bin/env" &&
    !tokens[1].startsWith("-") &&
    PYTHON_BASENAME.test(tokens[1])
  ) {
    // Resolved through the run's own PATH, exactly as the kernel's `env` would.
    interpreter = resolveExecutablePath(tokens[1], pathEnv);
    if (!interpreter) return unknown(`uses "${tokens[1]}" which is not on the run's PATH`);
  } else {
    return unknown("is not launched by a recognized Python interpreter");
  }

  const body = lines.slice(1).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const isConsoleScript =
    body.length > 0 &&
    body.includes("from hermes_cli.main import main") &&
    body.includes("sys.exit(main())") &&
    body.every((line) => CONSOLE_SCRIPT_LINES.some((pattern) => pattern.test(line)));
  if (!isConsoleScript) return unknown("is not the `hermes_cli.main:main` console entrypoint");

  try {
    accessSync(interpreter, fsConstants.X_OK);
  } catch {
    return {
      ok: false,
      reason: "error",
      message: `Cannot verify Ramp Router support: the interpreter for "${command}" is missing or not executable.`,
    };
  }
  return { ok: true, launcherPath, launcherDir: path.dirname(launcherPath), interpreter };
}

// ---------------------------------------------------------------------------
// Router launch plan (bind once, probe and execute the same file)
// ---------------------------------------------------------------------------

/**
 * Normalize a run's PATH against its absolute execution `cwd`, POSIX-style: a relative component is
 * resolved against `cwd` and an empty component (leading, interior or trailing `:`) means `cwd`
 * itself, preserving order. An absent or wholly empty PATH yields `""`: there is nothing to search,
 * and no host/default PATH is ever substituted.
 */
export function normalizeRouterLaunchPath(pathEnv: string | undefined, cwd: string): string {
  if (!pathEnv) return "";
  return pathEnv
    .split(path.delimiter)
    .map((dir) => (dir ? path.resolve(cwd, dir) : cwd))
    .join(path.delimiter);
}

/**
 * The single launch binding a Router run (and the environment test) uses: the launcher is resolved
 * and inspected ONCE, then the registry probe inspects exactly this descriptor and the run executes
 * exactly `executable`, with the same normalized `path` and `cwd`. Nothing re-resolves the command.
 */
export interface RouterLaunchPlan {
  /** Absolute execution working directory. */
  cwd: string;
  /** The run's PATH normalized against `cwd` (see normalizeRouterLaunchPath). */
  path: string;
  /** Absolute real path of the console-script launcher; the run executes this file. */
  executable: string;
  /** Directory Python puts first on sys.path when it runs the launcher. */
  launcherDir: string;
  /** Interpreter from the shebang, deliberately NOT realpath'd so venv detection is preserved. */
  interpreter: string;
}

export type RouterLaunchPlanResult =
  | { ok: true; plan: RouterLaunchPlan }
  | { ok: false; reason: "error" | "unknown"; message: string };

export const ROUTER_EMPTY_PATH_MESSAGE =
  "Refusing to start: this Ramp Router run's PATH is empty or unset. The Hermes launch would otherwise " +
  "receive a default PATH that Paperclip did not verify. Set a non-empty PATH in the agent's env (or leave " +
  "it unset there so the server's PATH is used).";

/**
 * Bind a Router launch. `command`/`pathEnv` must be the FINAL launcher and PATH (after command-scan
 * policy), and `cwd` the directory the run launches in (resolved to an absolute path here). Bare
 * names and `/usr/bin/env python` shebangs are looked up through the normalized PATH only.
 *
 * A wholly empty or absent PATH fails closed, even for an absolute launcher with an absolute
 * shebang: the shared child launcher substitutes a platform default PATH for an empty one, so the
 * launched process would not get the PATH that was bound and verified. (Empty COMPONENTS of a
 * non-empty PATH are fine: they mean the cwd.)
 */
export function resolveRouterLaunchPlan(options: {
  command: string;
  pathEnv: string | undefined;
  cwd: string;
}): RouterLaunchPlanResult {
  if (!options.pathEnv) return { ok: false, reason: "error", message: ROUTER_EMPTY_PATH_MESSAGE };
  const cwd = path.resolve(options.cwd);
  const normalizedPath = normalizeRouterLaunchPath(options.pathEnv, cwd);
  const launcher = resolveHermesPythonLauncher(options.command, normalizedPath, cwd);
  if (!launcher.ok) return launcher;
  return {
    ok: true,
    plan: {
      cwd,
      path: normalizedPath,
      executable: launcher.launcherPath,
      launcherDir: launcher.launcherDir,
      interpreter: launcher.interpreter,
    },
  };
}

// ---------------------------------------------------------------------------
// Registry probe
// ---------------------------------------------------------------------------

export const ROUTER_PROBE_PROTOCOL_VERSION = 1;

/**
 * Runs inside the installation's own interpreter. It installs an audit hook denying network, DNS and
 * process launches BEFORE any Hermes import, reproduces the console-script import context (launcher
 * directory first, never the cwd), confirms `providers` and `hermes_cli` come from one installation
 * root, imports only `providers.get_provider_profile` and `hermes_cli.auth.PROVIDER_REGISTRY`, and
 * prints one fixed JSON code. Hermes output is discarded; no object, env, URL or exception text is
 * ever reported.
 */
export const ROUTER_PROBE_SCRIPT = [
  "import os, sys, json",
  "_OUT = os.dup(1)",
  "_NULL = os.open(os.devnull, os.O_WRONLY)",
  "os.dup2(_NULL, 1)",
  "os.dup2(_NULL, 2)",
  "sys.stdout = sys.stderr = open(os.devnull, 'w')",
  "_BLOCKED = []",
  "_DENY = ('socket.connect', 'socket.getaddrinfo', 'socket.gethostbyname', 'socket.gethostbyaddr',",
  "  'socket.getnameinfo', 'socket.bind', 'socket.sendto', 'socket.sendmsg', 'subprocess.Popen',",
  "  'os.system', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.fork', 'os.forkpty', 'pty.spawn')",
  "def _hook(event, args):",
  "    if event in _DENY:",
  "        _BLOCKED.append(event)",
  "        raise RuntimeError('blocked by paperclip router probe')",
  "sys.addaudithook(_hook)",
  "def _emit(code, field=None, rc=0):",
  "    if _BLOCKED:",
  "        code, field, rc = 'sandbox_violation', None, 3",
  "    payload = {'v': 1, 'code': code}",
  "    if field:",
  "        payload['field'] = field",
  "    os.write(_OUT, (json.dumps(payload, separators=(',', ':')) + '\\n').encode())",
  "    os._exit(rc)",
  "try:",
  "    if sys.path and sys.path[0] in ('', os.getcwd()):",
  "        sys.path.pop(0)",
  "    sys.path.insert(0, sys.argv[1])",
  "    import importlib.util",
  "    _sp = importlib.util.find_spec('providers')",
  "    _sh = importlib.util.find_spec('hermes_cli')",
  "except BaseException:",
  "    _emit('import_error', rc=2)",
  "if _sh is None:",
  "    _emit('hermes_missing', rc=2)",
  "if _sp is None:",
  "    _emit('providers_missing')",
  "def _root(spec):",
  "    locs = list(spec.submodule_search_locations or [])",
  "    pkg = locs[0] if locs else os.path.dirname(spec.origin or '')",
  "    return os.path.realpath(os.path.dirname(pkg))",
  "if _root(_sp) != _root(_sh):",
  "    _emit('root_mismatch', rc=2)",
  "try:",
  "    from providers import get_provider_profile",
  "    from hermes_cli.auth import PROVIDER_REGISTRY",
  "except BaseException:",
  "    _emit('import_error', rc=2)",
  "_CANON = 'https://api.router.com/v1'",
  "_KEY = 'RAMP_ROUTER_API_KEY'",
  "def _g(o, k):",
  "    return o.get(k) if isinstance(o, dict) else getattr(o, k, None)",
  "def _url(u):",
  "    return isinstance(u, str) and u in (_CANON, _CANON + '/')",
  "def _has(v):",
  "    return isinstance(v, (list, tuple, set, frozenset)) and _KEY in v",
  "try:",
  "    _p = get_provider_profile('router')",
  "except BaseException:",
  "    _emit('profile_error', rc=2)",
  "if _p is None:",
  "    _emit('profile_missing')",
  "for _f, _ok in (('profile_name', _g(_p, 'name') == 'router'),",
  "                ('profile_auth_type', _g(_p, 'auth_type') == 'api_key'),",
  "                ('profile_api_mode', _g(_p, 'api_mode') == 'codex_responses'),",
  "                ('profile_env_vars', _has(_g(_p, 'env_vars'))),",
  "                ('profile_base_url', _url(_g(_p, 'base_url')))):",
  "    if not _ok:",
  "        _emit('incompatible', _f)",
  "try:",
  "    _c = PROVIDER_REGISTRY.get('router')",
  "except BaseException:",
  "    _emit('auth_error', rc=2)",
  "if _c is None:",
  "    _emit('auth_missing')",
  "for _f, _ok in (('auth_id', _g(_c, 'id') == 'router'),",
  "                ('auth_auth_type', _g(_c, 'auth_type') == 'api_key'),",
  "                ('auth_api_key_env_vars', _has(_g(_c, 'api_key_env_vars'))),",
  "                ('auth_base_url_env_var', _g(_c, 'base_url_env_var') == 'RAMP_ROUTER_BASE_URL'),",
  "                ('auth_inference_base_url', _url(_g(_c, 'inference_base_url')))):",
  "    if not _ok:",
  "        _emit('incompatible', _f)",
  "_emit('ok')",
].join("\n");

const UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  "providers_missing",
  "profile_missing",
  "auth_missing",
  "incompatible",
]);
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "profile_name",
  "profile_auth_type",
  "profile_api_mode",
  "profile_env_vars",
  "profile_base_url",
  "auth_id",
  "auth_auth_type",
  "auth_api_key_env_vars",
  "auth_base_url_env_var",
  "auth_inference_base_url",
]);
const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set([
  "import_error",
  "hermes_missing",
  "root_mismatch",
  "profile_error",
  "auth_error",
  "sandbox_violation",
]);

/** Probe output limit: one short JSON line. Anything larger is treated as malformed. */
export const PROBE_MAX_OUTPUT_BYTES = 1024;

interface ProbeProcessOutcome {
  stdout: string;
  timedOut: boolean;
  overflow: boolean;
  failed: boolean;
}

/**
 * Run the probe with a HARD deadline. The child is spawned detached so it leads its own process
 * group, and on timeout the whole group is killed (`process.kill(-pid)`): a probe whose interpreter
 * or a descendant keeps the pipes open cannot outlive the bound. The promise settles on the deadline
 * itself rather than waiting for stdio to close, so a surviving pipe holder never delays the result.
 */
function runProbeProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<ProbeProcessOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let overflow = false;
    let child: ChildProcess | null = null;
    // Declared before finish() uses it: a synchronous spawn throw settles before the timer is set.
    let deadline: NodeJS.Timeout | null = null;
    const finish = (outcome: ProbeProcessOutcome) => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve(outcome);
    };
    const killGroup = () => {
      if (!child?.pid) return;
      try {
        // Negative pid targets the child's process group, so descendants go with it.
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    deadline = setTimeout(() => {
      killGroup();
      finish({ stdout, timedOut: true, overflow: false, failed: true });
    }, options.timeoutMs);

    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish({ stdout: "", timedOut: false, overflow: false, failed: true });
      return;
    }

    // Output is capped manually so exceeding the cap is detected instead of relying on kill timing.
    const collect = (chunk: Buffer) => {
      if (overflow) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > PROBE_MAX_OUTPUT_BYTES) {
        overflow = true;
        killGroup();
        finish({ stdout: "", timedOut: false, overflow: true, failed: true });
      }
    };
    child.stdout?.on("data", collect);
    // stderr is discarded: the probe's only report is its one JSON line on fd 1.
    child.stderr?.resume();
    child.on("error", () => finish({ stdout, timedOut: false, overflow, failed: true }));
    child.on("close", (code, signal) =>
      finish({ stdout, timedOut: false, overflow, failed: code !== 0 || signal !== null }),
    );
  });
}

export type RouterCapabilityResult =
  | { supported: true }
  | { supported: false; reason: "unsupported" | "unknown" | "timeout" | "error"; message: string };

export const DEFAULT_ROUTER_PROBE_TIMEOUT_MS = 15_000;

type ProbeResponse = { code: string; field?: string };

function parseProbeResponse(stdout: string): ProbeResponse | null {
  const text = stdout.trim();
  if (!text || text.includes("\n") || text.length > 200) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "code,v" && keys !== "code,field,v") return null;
  if (record.v !== ROUTER_PROBE_PROTOCOL_VERSION || typeof record.code !== "string") return null;
  if (record.field !== undefined && (typeof record.field !== "string" || !KNOWN_FIELDS.has(record.field))) return null;
  if (record.code !== "ok" && !UNSUPPORTED_CODES.has(record.code) && !KNOWN_FAILURE_CODES.has(record.code)) return null;
  return { code: record.code, ...(record.field ? { field: record.field } : {}) };
}

/**
 * Probe environment: OS essentials from the launch env only (PATH, locale, TLS roots), with a fresh
 * HOME/XDG/TMPDIR/HERMES_HOME outside any Hermes profiles tree. No provider keys or app tokens.
 *
 * Python module resolution must be identical to the Router run's, or the probe would verify a
 * different `hermes_cli`/`providers` import set than the one that actually executes.
 * `ROUTER_RUN_STRIPPED_PYTHON_ENV_NAMES` are removed here and from every Router run's final env, and
 * PYTHONNOUSERSITE is carried through exactly as the launch pins it, so both sides agree.
 */
function buildProbeEnv(launchEnv: Record<string, string | undefined>, root: string): Record<string, string> {
  const base = buildAgentChildBaseEnv(launchEnv as NodeJS.ProcessEnv) as Record<string, string>;
  for (const name of ROUTER_RUN_STRIPPED_PYTHON_ENV_NAMES) delete base[name];
  const home = path.join(root, "home");
  return {
    ...base,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    TMPDIR: path.join(root, "tmp"),
    HERMES_HOME: path.join(root, "hermes"),
    HERMES_DISABLE_LAZY_INSTALLS: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    ...(launchEnv.PYTHONNOUSERSITE ? { PYTHONNOUSERSITE: launchEnv.PYTHONNOUSERSITE } : {}),
  };
}

/**
 * Map one probe process outcome to a capability result. Shared by the host probe and the in-target
 * probe (TECH-8174), so both report exactly the same codes and messages.
 */
export function interpretRouterProbeOutcome(
  command: string,
  outcome: { stdout: string; timedOut: boolean; overflow: boolean; failed: boolean },
  timeoutMs: number,
): RouterCapabilityResult {
  const couldNotVerify = (detail: string): RouterCapabilityResult => ({
    supported: false,
    reason: "unknown",
    message: `Cannot verify Ramp Router support for "${command}": ${detail}.`,
  });
  if (outcome.timedOut) {
    return {
      supported: false,
      reason: "timeout",
      message: `Cannot verify Ramp Router support for "${command}": the registry check did not finish within ${timeoutMs}ms.`,
    };
  }
  if (outcome.overflow) return couldNotVerify("the registry check produced unexpected output");
  const response = parseProbeResponse(outcome.stdout);
  if (!response) {
    return couldNotVerify(outcome.failed ? "the registry check failed" : "the registry check produced unexpected output");
  }
  if (outcome.failed) {
    return couldNotVerify(
      response.code === "sandbox_violation"
        ? "Hermes attempted network or process access while loading its provider registry"
        : "Hermes provider modules could not be loaded from this installation",
    );
  }
  if (response.code === "ok") return { supported: true };
  if (UNSUPPORTED_CODES.has(response.code)) {
    const detail = response.field ? ` (${response.field})` : "";
    return {
      supported: false,
      reason: "unsupported",
      message:
        `The installed Hermes at "${command}" does not provide the native Ramp Router provider${detail}. ` +
        "Upgrade this Hermes installation to a release with native Router support, or choose a different provider for this agent.",
    };
  }
  return couldNotVerify("the registry check failed");
}

/**
 * Verify, through the exact installation the run launches, that Hermes registers the native Ramp
 * Router provider with the contract Paperclip relies on (api_key auth, codex_responses, the canonical
 * endpoint and RAMP_ROUTER_API_KEY). Bounded by `timeoutMs`; never cached, so a changed install is
 * always re-verified. `command`/`env` must be the FINAL launcher and launch env (after command-scan
 * policy); `env` is only used for PATH/locale resolution and never forwarded with credentials.
 * `cwd` must be the directory the run launches in, so a relative command resolves to the same
 * executable the run would execute.
 *
 * Pass `launch` (from resolveRouterLaunchPlan) to probe an already-bound launcher: it is inspected
 * as-is, never re-resolved, and the probe's PATH is the plan's normalized PATH. Without `launch`, a
 * plan is bound here from `command`/`env.PATH`/`cwd`; with no `cwd` either, only absolute PATH
 * components are searched and a relative command is rejected.
 */
export async function probeHermesRouterSupport(options: {
  command: string;
  env: Record<string, string | undefined>;
  cwd?: string;
  launch?: RouterLaunchPlan;
  timeoutMs?: number;
}): Promise<RouterCapabilityResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROUTER_PROBE_TIMEOUT_MS;
  let launcher: { launcherDir: string; interpreter: string };
  let probePath = options.env.PATH;
  if (options.launch) {
    launcher = options.launch;
    if (probePath !== undefined) probePath = options.launch.path;
  } else if (options.cwd) {
    const bound = resolveRouterLaunchPlan({ command: options.command, pathEnv: options.env.PATH, cwd: options.cwd });
    if (!bound.ok) return { supported: false, reason: bound.reason, message: bound.message };
    launcher = bound.plan;
    if (probePath !== undefined) probePath = bound.plan.path;
  } else {
    const resolved = resolveHermesPythonLauncher(options.command, options.env.PATH);
    if (!resolved.ok) return { supported: false, reason: resolved.reason, message: resolved.message };
    launcher = resolved;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-router-probe-"));
  try {
    const env = buildProbeEnv({ ...options.env, PATH: probePath }, root);
    const work = path.join(root, "work");
    for (const dir of [env.HOME, env.TMPDIR, env.HERMES_HOME, work]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    }
    const outcome = await runProbeProcess(
      launcher.interpreter,
      ["-B", "-c", ROUTER_PROBE_SCRIPT, launcher.launcherDir],
      { cwd: work, env, timeoutMs },
    );
    return interpretRouterProbeOutcome(options.command, outcome, timeoutMs);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
