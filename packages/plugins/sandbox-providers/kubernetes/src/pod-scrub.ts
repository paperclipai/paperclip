/**
 * Between-turn scrub for a reused sandbox pod.
 *
 * A reused pod keeps the same principal (one agent, one conversation), so this
 * is about stale state and lingering processes, not cross-tenant isolation. It
 * returns the pod to "fresh container plus the workspace":
 *  - kill every process except the pod's keeper (tini as PID 1 and its
 *    `sleep infinity` child: killing the child would stop the container) and
 *    the scrub shell itself: the previous turn's bridge, Hermes, any
 *    background tool;
 *  - delete the previous turn's adapter runtime root (HERMES_HOME, query.txt,
 *    the bridge entrypoint and its queue) under
 *    `<remoteCwd>/.paperclip-runtime/<adapter key>`. Only that adapter's
 *    directory: other adapters' state under `.paperclip-runtime` is not touched;
 *  - delete temp and cache files.
 * Nothing from the previous run's env survives: env only ever arrives on exec
 * stdin and lives in the killed processes. The workspace itself is left alone;
 * the next turn's sync-in overwrites it and the server copy is authoritative.
 */

import type { KubeConfig } from "@kubernetes/client-node";
import { execInPod, shQuote } from "./pod-exec.js";

export const SCRUB_TIMEOUT_MS = 20_000;

/** The adapter's runtime directory name under `.paperclip-runtime` (`hermes_local` -> `hermes`). */
export function runtimeKeyForAdapter(adapterType: string): string {
  const key = adapterType.replace(/_local$/, "");
  // The key becomes part of an `rm -rf` path: only a plain name is acceptable.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
    throw new Error(`Invalid adapter type for scrub: ${JSON.stringify(adapterType)}`);
  }
  return key;
}

export function buildScrubScript(remoteCwd: string, adapterType: string): string {
  const runtimeRoot = `${remoteCwd.replace(/\/+$/, "")}/.paperclip-runtime/${runtimeKeyForAdapter(adapterType)}`;
  return [
    // Kill everything except the pod's keeper and this shell. The container
    // command is `tini -- /bin/sh -c "sleep infinity"`: PID 1 plus the
    // `sleep infinity` chain; killing that chain would stop the container.
    // /proc is always present in the runtime image; a failure to kill one
    // process is not fatal.
    'self=$$',
    'for d in /proc/[0-9]*; do',
    '  pid=${d#/proc/}',
    '  [ "$pid" = "1" ] && continue',
    '  [ "$pid" = "$self" ] && continue',
    '  cmd=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null)',
    '  case "$cmd" in "sleep infinity "|"/bin/sh -c sleep infinity ") continue ;; esac',
    '  kill -9 "$pid" 2>/dev/null',
    'done',
    `rm -rf -- ${shQuote(runtimeRoot)}`,
    'rm -rf -- /tmp/* /tmp/.[!.]* /tmp/..?* 2>/dev/null',
    'rm -rf -- "${HOME:-/nonexistent}/.cache" 2>/dev/null',
    // Confirm the runtime root is gone; this is the contract the next turn needs.
    `[ ! -e ${shQuote(runtimeRoot)} ]`,
  ].join('\n');
}

export async function scrubPod(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  remoteCwd: string,
  adapterType: string,
  timeoutMs: number = SCRUB_TIMEOUT_MS,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await execInPod(
      kc,
      namespace,
      podName,
      "agent",
      ["/bin/sh", "-c", buildScrubScript(remoteCwd, adapterType)],
      undefined,
      timeoutMs,
    );
    return result.exitCode === 0
      ? { ok: true, detail: "" }
      : { ok: false, detail: `scrub exited ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
