/**
 * TECH-8174: Ramp Router readiness verified INSIDE a sandbox target, against the Hermes the run
 * actually launches there (the image's /opt/hermes venv). The host's installation proves nothing
 * about the sandbox's, so nothing here inspects or runs anything on the host.
 *
 * One exec runs a fixed shell wrapper that:
 *  1. checks the launcher is the venv's own entrypoint (no symlink redirect; shebang is the venv
 *     interpreter), the in-sandbox analogue of resolveRouterLaunchPlan's checks;
 *  2. runs the same sealed registry probe script as the host probe, in a fresh per-probe
 *     HOME/TMPDIR/HERMES_HOME under the run's runtime dir, with a scrubbed environment (`env -i`:
 *     no provider keys, no app tokens);
 *  3. removes the probe directory.
 * The probe output is mapped by the same interpreter as the host probe.
 */

import {
  runAdapterExecutionTargetProcess,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";

import {
  PROBE_MAX_OUTPUT_BYTES,
  ROUTER_PROBE_SCRIPT,
  interpretRouterProbeOutcome,
  type RouterCapabilityResult,
} from "./router-readiness.js";

export const SANDBOX_HERMES_BIN_DIR = "/opt/hermes/bin";
export const SANDBOX_HERMES_LAUNCHER = `${SANDBOX_HERMES_BIN_DIR}/hermes`;

/** Python start-up in a small pod plus the exec round trip: more headroom than the host probe. */
export const DEFAULT_REMOTE_ROUTER_PROBE_TIMEOUT_MS = 30_000;

const LAUNCHER_UNTRUSTED_MARKER = "paperclip_launcher_untrusted";

/** Positional args: $1 probe dir, $2 probe script, $3 Hermes bin dir. Values never in the script text. */
export const REMOTE_ROUTER_PROBE_WRAPPER = [
  'd="$1"',
  // The probe dir is created and later removed recursively: only an absolute path below / is accepted.
  'case "$d" in /?*) ;; *) exit 64 ;; esac',
  'case "$d" in */..|*/../*|*/.|*/./*) exit 64 ;; esac',
  "umask 077",
  'mkdir -p "$d/home" "$d/tmp" "$d/hermes" "$d/work" || exit 70',
  "ok=1",
  '[ "$(readlink -f "$3/hermes")" = "$3/hermes" ] || ok=0',
  'first=""',
  'IFS= read -r first < "$3/hermes" || ok=0',
  'case "$first" in "#!$3/python"|"#!$3/python3") ;; *) ok=0 ;; esac',
  // Run the interpreter the launcher names (the one Hermes itself starts with).
  'interp="${first#\\#!}"',
  'if [ "$ok" = 1 ]; then',
  '  cd "$d/work" && env -i PATH="$PATH" HOME="$d/home" XDG_CONFIG_HOME="$d/home/.config" ' +
    'XDG_DATA_HOME="$d/home/.local/share" XDG_CACHE_HOME="$d/home/.cache" XDG_STATE_HOME="$d/home/.local/state" ' +
    'TMPDIR="$d/tmp" HERMES_HOME="$d/hermes" HERMES_DISABLE_LAZY_INSTALLS=1 PYTHONDONTWRITEBYTECODE=1 ' +
    '"$interp" -B -c "$2" "$3"',
  "  rc=$?",
  "else",
  `  printf '%s\\n' '${LAUNCHER_UNTRUSTED_MARKER}'`,
  "  rc=0",
  "fi",
  'cd / && rm -rf "$d"',
  "exit $rc",
].join("\n");

export async function probeHermesRouterSupportInTarget(input: {
  runId: string;
  target: AdapterExecutionTarget;
  cwd: string;
  /** Absolute per-probe directory inside the target (created and removed by the probe). */
  probeDir: string;
  timeoutMs?: number;
  /** Test seam: the Hermes bin dir inside the target. Production always uses the image's. */
  hermesBinDir?: string;
}): Promise<RouterCapabilityResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_REMOTE_ROUTER_PROBE_TIMEOUT_MS;
  let result: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>;
  try {
    result = await runAdapterExecutionTargetProcess(
      input.runId,
      input.target,
      "sh",
      ["-c", REMOTE_ROUTER_PROBE_WRAPPER, "sh", input.probeDir, ROUTER_PROBE_SCRIPT, input.hermesBinDir ?? SANDBOX_HERMES_BIN_DIR],
      {
        cwd: input.cwd,
        // No credentials: the wrapper also scrubs the probe's env with `env -i`.
        env: {},
        timeoutSec: Math.ceil(timeoutMs / 1000),
        graceSec: 5,
        onLog: async () => {},
      },
    );
  } catch {
    return {
      supported: false,
      reason: "error",
      message: `Cannot verify Ramp Router support for "${SANDBOX_HERMES_LAUNCHER}": the registry check could not be started in the environment.`,
    };
  }
  if (!result.timedOut && result.stdout.trim() === LAUNCHER_UNTRUSTED_MARKER) {
    return {
      supported: false,
      reason: "unknown",
      message: `Cannot verify Ramp Router support for "${SANDBOX_HERMES_LAUNCHER}": in the environment it is not the Hermes virtualenv's own entrypoint.`,
    };
  }
  const overflow = Buffer.byteLength(result.stdout, "utf8") > PROBE_MAX_OUTPUT_BYTES;
  return interpretRouterProbeOutcome(
    SANDBOX_HERMES_LAUNCHER,
    {
      stdout: overflow ? "" : result.stdout,
      timedOut: result.timedOut,
      overflow,
      failed: result.timedOut || result.exitCode !== 0 || result.signal !== null,
    },
    timeoutMs,
  );
}
