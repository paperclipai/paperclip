/**
 * Between-turn scrub for a reused sandbox pod.
 *
 * A reused pod keeps the same principal (one agent, one conversation), so this
 * is about stale state and lingering processes, not cross-tenant isolation. It
 * returns the pod to "fresh container plus the workspace".
 *
 * Completeness argument (why this is adapter-independent): the container runs
 * with `readOnlyRootFilesystem: true`, so the only writable places are the four
 * volumes in sandbox-cr-builder.ts: `/workspace`, `/home/paperclip`,
 * `/home/paperclip/.cache` and `/tmp` (plus the in-memory `/dev/shm`). The scrub
 * empties all of them except the workspace files themselves, and from the
 * workspace removes `.paperclip-runtime`. Every adapter's runtime root (Hermes
 * `hermes`, Claude `claude`, Pi `pi`, and the rest) is created under
 * `<remoteCwd>/.paperclip-runtime/<adapter key>` (`prepareSandboxManagedRuntime`
 * rejects any runtime root outside that tree), and managed homes (Pi's HOME,
 * Claude's config) live inside it or under `/home/paperclip`. A fresh pod starts
 * with all of that empty, so adapters already work from an empty runtime tree.
 *
 *  - kill every process except the pod's keeper (tini as PID 1 and its
 *    `sleep infinity` chain: killing that would stop the container) and the
 *    scrub shell: the previous turn's bridge, agent process, background tools;
 *  - delete `<remoteCwd>/.paperclip-runtime`;
 *  - empty `/home/paperclip` (including `.cache`), `/tmp` and `/dev/shm`;
 *  - verify all of the above are empty and fail loudly otherwise.
 *
 * The workspace files are kept: the next turn's sync-in overwrites them and the
 * server copy is authoritative. Not covered, by design: files the agent left in
 * the workspace itself (same principal, same conversation).
 */

import type { KubeConfig } from "@kubernetes/client-node";
import { execInPod, shQuote } from "./pod-exec.js";

export const SCRUB_TIMEOUT_MS = 20_000;

export function buildScrubScript(remoteCwd: string): string {
  const runtimeRoot = `${remoteCwd.replace(/\/+$/, "")}/.paperclip-runtime`;
  const empty = (dir: string, extra = "") =>
    `find ${dir} -mindepth 1 -maxdepth 1 ${extra}-exec rm -rf -- {} + 2>/dev/null`;
  return [
    // Kill everything except the pod's keeper and this shell. The container
    // command is `tini -- /bin/sh -c "sleep infinity"`: PID 1 plus the
    // `sleep infinity` chain. /proc is always present in the runtime image; a
    // failure to kill one process is not fatal.
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
    // find, not a glob: no ARG_MAX limit and dotfiles included. The .cache mount
    // point cannot be removed, so it is emptied separately.
    empty("/home/paperclip", "! -name .cache "),
    empty("/home/paperclip/.cache"),
    empty("/tmp"),
    empty("/dev/shm"),
    // Verify: nothing may survive in any writable scratch area. One chained
    // command, so a surviving runtime root OR a surviving file fails the scrub.
    `[ ! -e ${shQuote(runtimeRoot)} ] &&`,
    '[ -z "$(find /home/paperclip /home/paperclip/.cache /tmp /dev/shm -mindepth 1 -maxdepth 1 ! -path /home/paperclip/.cache 2>/dev/null | head -n 1)" ]',
  ].join('\n');
}

export async function scrubPod(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  remoteCwd: string,
  timeoutMs: number = SCRUB_TIMEOUT_MS,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await execInPod(
      kc,
      namespace,
      podName,
      "agent",
      ["/bin/sh", "-c", buildScrubScript(remoteCwd)],
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
