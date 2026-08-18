/**
 * Forcing a managed runtime's listeners onto loopback through argv (PAP-17256).
 *
 * The broker only exposes a port whose listener /proc proves to be loopback-only,
 * so an exposed Paperclip dev runtime MUST bind `127.0.0.1`. The server used to
 * request that with env vars alone (`PAPERCLIP_BIND` / `PAPERCLIP_BIND_HOST`),
 * which is not sufficient: the process that has to honour them is the *guest
 * checkout's* `scripts/dev-runner.ts`, and a checkout that predates managed
 * exposure overwrites `PAPERCLIP_BIND` from its own `--bind` argv and deletes
 * `PAPERCLIP_BIND_HOST` outright. A branch pinned at such a commit therefore
 * bound `0.0.0.0` and every expose was correctly denied with
 * `listener_ownership_mismatch`.
 *
 * argv is the one channel every dev-runner version honours, because each of them
 * derives its bind mode from `--bind` / `--bind-host` *before* writing the child
 * env. Rewriting the command is what actually makes the loopback bind binding.
 *
 * Pure string functions only — no I/O, no process state.
 */

/** The only address an exposed managed runtime may bind. */
export const RUNTIME_EXPOSURE_BIND_MODE = "custom";
export const RUNTIME_EXPOSURE_BIND_HOST = "127.0.0.1";

/**
 * `--bind <mode>` / `--bind-host <host>`, in both the space- and `=`-separated
 * spellings. Each takes exactly one value, and a value is never another flag.
 */
const BIND_SELECTING_ARG =
  /(?:^|\s)--bind(?:-host)?(?:=|\s+)(?!--)[^\s]+/g;

/** Legacy aliases for `--bind lan`; they select a non-loopback bind. */
const LEGACY_LAN_ALIASES = /(?:^|\s)--(?:tailscale-auth|authenticated-private)(?=\s|$)/g;

/** True when the command carries an explicit bind selection of any kind. */
export function commandSelectsBindMode(command: string): boolean {
  return new RegExp(BIND_SELECTING_ARG.source).test(command)
    || new RegExp(LEGACY_LAN_ALIASES.source).test(command);
}

/**
 * A Paperclip dev-runner invocation — the only shape that understands
 * `--bind` / `--bind-host`.
 *
 * Deliberately keyed on the *command*, not the service name. `--bind` means
 * something entirely different to an unrelated process (the HTTPS probe canaries
 * pass it to `python3 -m http.server`), and appending flags a command does not
 * parse turns a working service into one that exits on startup.
 */
const PAPERCLIP_DEV_RUNNER_COMMAND =
  /(?:^|[\s;&|])(?:(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+dev(?::once|:watch|:server)?(?=\s|$)|[^\s]*dev-runner(?:\.[cm]?[jt]s)?(?=\s|$))/;

export function isPaperclipDevRunnerCommand(command: string): boolean {
  return PAPERCLIP_DEV_RUNNER_COMMAND.test(command);
}

/**
 * Rewrite a Paperclip dev-runner command so it explicitly requests the loopback
 * bind, replacing whatever bind selection it carried.
 *
 * A command that is not a dev-runner invocation is returned untouched — see
 * {@link isPaperclipDevRunnerCommand} for why that guard is not optional.
 *
 * The legacy `--tailscale-auth` / `--authenticated-private` aliases are
 * deliberately *left in place*: an explicit `--bind` already wins over them in
 * every dev-runner version, they still correctly select the authenticated
 * deployment mode an exposed lane wants, and `isPaperclipDevRuntimeService`
 * matches on `--tailscale-auth` as a substring, so stripping it would silently
 * change readiness handling.
 */
export function forceLoopbackBindInCommand(command: string): string {
  if (!isPaperclipDevRunnerCommand(command)) return command;
  const stripped = command.replace(BIND_SELECTING_ARG, "").trim();
  if (stripped.length === 0) return command;
  return `${stripped} --bind ${RUNTIME_EXPOSURE_BIND_MODE} --bind-host ${RUNTIME_EXPOSURE_BIND_HOST}`;
}

/**
 * Point a probe URL at loopback, keeping its scheme, port, and path.
 *
 * An exposed runtime's listener is loopback-only by construction, so probing it
 * on any other host cannot work. The live config happens to declare a loopback
 * readiness URL, but the fallback target is the service's display URL — a
 * MagicDNS name like `http://paperclip-dev:42003` — which only ever answered
 * because the guest was wrongly bound to the wildcard. Normalising here keeps
 * the loopback fix from turning that latent mismatch into a readiness timeout.
 */
export function rewriteUrlHostToLoopback(url: string | null): string | null {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.hostname = RUNTIME_EXPOSURE_BIND_HOST;
    return parsed.toString();
  } catch {
    // Not a URL we can reason about; leave it for the caller's own handling.
    return url;
  }
}
