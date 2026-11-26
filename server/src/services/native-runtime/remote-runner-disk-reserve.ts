import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { SANDBOX_DISK_FULL_FAILURE_CODE } from "../../vendor/paperclip-runner/index.js";

/**
 * The agent can fill a managed sandbox's disk. runnerd then cannot write its
 * state and exits, and its relaunch cannot upload its launch files. Paperclip
 * holds this much disk in each managed sandbox and releases it to relaunch the
 * runner, so the agent's turn continues and its tools report the full disk.
 */
export const REMOTE_RUNNER_DISK_RESERVE_BYTES = 256 * 1024 * 1024;
// The reserve is taken only while this much more is free, so it never takes
// space from an agent that is already close to the limit.
const MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024;

type Runner = Pick<CommandManagedRuntimeRunner, "execute">;

const HOLD_SCRIPT = [
  'set -u; reserve=$1; bytes=$2; minimum_free_kib=$3; minimum_free_inodes=$4; [ -f "$reserve" ] && exit 0',
  'directory=$(dirname -- "$reserve"); mkdir -p -- "$directory" || exit 1',
  `free_kib=$(df -Pk -- "$directory" | awk 'NR == 2 { print $4 }')`,
  '[ -n "$free_kib" ] && [ "$free_kib" -ge "$minimum_free_kib" ] || exit 0',
  `free_inodes=$(df -Pi -- "$directory" | awk 'NR == 2 { print $(NF - 2) }')`,
  '[ -n "$free_inodes" ] && [ "$free_inodes" -ge "$minimum_free_inodes" ] || exit 0',
  'partial="$reserve.partial"; rm -f -- "$partial"',
  'fallocate -l "$bytes" "$partial" 2>/dev/null || dd if=/dev/zero of="$partial" bs=65536 count=$((bytes / 65536)) 2>/dev/null || { rm -f -- "$partial"; exit 1; }',
  'mv -f -- "$partial" "$reserve"',
].join("\n");

// rm needs no free space. The last line names the outcome.
const RELEASE_SCRIPT =
  'rm -f -- "$1.partial" || exit 1; if [ -f "$1" ]; then rm -f -- "$1" && echo released; else echo not_held; fi';

export async function holdRemoteRunnerDiskReserve(
  runner: Runner,
  reservePath: string,
  options: { bytes?: number; minimumFreeBytes?: number; minimumFreeInodes?: number } = {},
): Promise<void> {
  const bytes = options.bytes ?? REMOTE_RUNNER_DISK_RESERVE_BYTES;
  const minimumFreeBytes = options.minimumFreeBytes ?? MINIMUM_FREE_BYTES;
  await runner.execute({
    command: "sh",
    args: ["-c", HOLD_SCRIPT, "paperclip-runner-disk-reserve-hold", reservePath,
      String(bytes), String(Math.ceil((minimumFreeBytes + bytes) / 1024)), String(options.minimumFreeInodes ?? 1024)],
    bypassSession: true,
    timeoutMs: 30_000,
  });
}

export type DiskReserveRelease = "released" | "not_held" | "failed";

/** Tries twice: one lost sandbox RPC must not read as "nothing left to free". */
export async function releaseRemoteRunnerDiskReserve(runner: Runner, reservePath: string): Promise<DiskReserveRelease> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runner.execute({
      command: "sh",
      args: ["-c", RELEASE_SCRIPT, "paperclip-runner-disk-reserve-release", reservePath],
      bypassSession: true,
      timeoutMs: 10_000,
    }).catch(() => null);
    if (result?.exitCode !== 0 || result.timedOut) continue;
    const outcome = result.stdout.trim().split("\n").at(-1);
    if (outcome === "released" || outcome === "not_held") return outcome;
  }
  return "failed";
}

/**
 * The reserve of one runner launcher. A release waits for an in-flight hold,
 * and no hold starts after a release, so a relaunch never stages while the
 * space it freed is taken back.
 */
export function createRemoteRunnerDiskReserve(runner: Runner, reservePath: string) {
  let pendingHold: Promise<void> | null = null;
  let releaseRequested = false;
  return {
    hold(): void {
      if (releaseRequested || pendingHold) return;
      pendingHold = holdRemoteRunnerDiskReserve(runner, reservePath).catch(() => undefined);
    },
    async release(): Promise<DiskReserveRelease> {
      releaseRequested = true;
      await pendingHold;
      return releaseRemoteRunnerDiskReserve(runner, reservePath);
    },
  };
}

export type RemoteRunnerDiskReserve = ReturnType<typeof createRemoteRunnerDiskReserve>;

export function isSandboxDiskFullError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  return typeof message === "string" && isSandboxDiskFullText(message);
}

export function isSandboxDiskFullText(text: string): boolean {
  return /no space left on device|disk quota exceeded|\bENOSPC\b|\bEDQUOT\b/i.test(text);
}

/** A staging command's failure, keeping a full disk recognizable without its output. */
export function remoteStagingFailure(
  code: string,
  result: { stdout?: string; stderr?: string },
): Error {
  return isSandboxDiskFullText(`${result.stderr ?? ""}\n${result.stdout ?? ""}`)
    ? Object.assign(new Error(`${code}: no space left on device`), { code: "ENOSPC" })
    : new Error(code);
}

export function sandboxDiskFullFailure(cause: unknown): Error {
  return Object.assign(
    new Error(`${SANDBOX_DISK_FULL_FAILURE_CODE}: the sandbox disk is full, so the runner cannot be started`, { cause }),
    { code: SANDBOX_DISK_FULL_FAILURE_CODE },
  );
}

/** Managed sandboxes only; never on a user's own host. `.paperclip-runtime` is outside every saved directory. */
export function remoteRunnerDiskReservePath(target: { transport: string; remoteCwd: string }): string | undefined {
  return target.transport === "sandbox"
    ? `${target.remoteCwd.replace(/\/+$/, "")}/.paperclip-runtime/paperclip-runner/disk-reserve`
    : undefined;
}
