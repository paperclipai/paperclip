/**
 * Whether a workspace can survive the transfer that ships it, decided before
 * the transfer runs.
 *
 * On 2026-10-05 a workspace tree carrying one entry `tar` could not read
 * aborted every heartbeat to every Linux box. Three properties of the transfer
 * turned that into a fleet outage, and this module exists to deny each one:
 *
 *  - Nothing proved the payload was packable before the pipe opened, so the
 *    fault surfaced as a transport failure mid-transfer.
 *  - The failure was retried. The fault was in the payload, so every attempt
 *    was guaranteed to fail identically, and three boxes were blamed for it.
 *  - The message led with ssh's `Permanently added ... known hosts` banner, so
 *    three healthy boxes read as three sick boxes, and nothing recorded which
 *    step of the transfer had failed.
 *
 * The rehearsal here is not a model of the pack. {@link buildWorkspacePackArgs}
 * is the single builder the real upload also calls, so the rehearsal runs the
 * same program over the same tree with the same excludes and the same flags,
 * and differs from the shipment in one argument: where the archive goes. A
 * rehearsal that cannot disagree with the shipment is the only kind worth
 * gating on.
 *
 * What it deliberately does not do is look for broken symlinks. A dangling
 * symlink does not abort a pack — measured on bsdtar 3.5.3, with and without
 * `-h`, it archives clean. What aborts a pack is an entry the packer may not
 * read, which needs no symlink at all. A symlink scan guards the shapes that
 * do not fail and is silent on the shapes that do.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * Which step of a transfer an error came from.
 *
 * Two steps used to fail identically with no label, which is why the outage's
 * own logs cannot say which one failed. Every transfer now carries one of
 * these, and it appears in the message.
 */
export const WORKSPACE_TRANSFER_STAGES = [
  "workspace_pack_rehearsal",
  "workspace_destination_rehearsal",
  "workspace_upload",
  "workspace_git_import",
  "asset_upload",
  "referenced_source_upload",
  "workspace_download",
  "workspace_git_export",
  "directory_upload",
] as const;

export type WorkspaceTransferStage = (typeof WORKSPACE_TRANSFER_STAGES)[number];

/**
 * Build the `tar` create arguments for a transfer.
 *
 * The one builder for both the real upload and its rehearsal. `output` is the
 * only difference between them: `-` for the pipe that ships, the platform's
 * null device for the rehearsal that only wants the exit status. Keeping it a
 * parameter rather than two call sites is the point — a rehearsal that drifts
 * from the shipment answers a question nobody asked.
 */
export function buildWorkspacePackArgs(input: {
  localDir: string;
  exclude?: readonly string[];
  followSymlinks?: boolean;
  output: string;
}): string[] {
  return [
    ...(input.followSymlinks ? ["-h"] : []),
    "-C",
    input.localDir,
    // `._*` keeps macOS AppleDouble metadata out of every archive; it is part
    // of the exclude set the shipment uses, so the rehearsal needs it too.
    ...["._*", ...(input.exclude ?? [])].flatMap((entry) => ["--exclude", entry]),
    "-cf",
    input.output,
    ".",
  ];
}

/** The env the real pack runs under, so the rehearsal runs under it too. */
export function workspacePackEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Prevent macOS bsdtar from emitting AppleDouble metadata files like ._README.md.
    COPYFILE_DISABLE: "1",
  };
}

// ssh writes these to stderr on a perfectly healthy connection. Left in place
// they lead the failure message, which is how three working boxes came to be
// named as the cause of a workspace fault. They carry no diagnostic value once
// the host is already known from the spec.
const SSH_NOISE_PATTERNS: RegExp[] = [
  /^warning: permanently added .* to the list of known hosts\.?$/i,
  /^warning: identity file .* not accessible.*$/i,
  /^pseudo-terminal will not be allocated because stdin is not a terminal\.?$/i,
  /^shared connection to .* closed\.?$/i,
];

/**
 * Drop the lines ssh emits on a healthy connection.
 *
 * Returns the remaining text, so a genuine transport error keeps every word it
 * had. When the banner was the entire output the result is an empty string:
 * the caller then has positive evidence that ssh said nothing wrong, rather
 * than a message that looks like a complaint about a host.
 */
export function stripSshNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      return !SSH_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
    })
    .join("\n")
    .trim();
}

// `tar: <path>: <reason>` — GNU tar on the boxes, and bsdtar's directory
// diagnostics on the Mac. The reason is kept out of the path by anchoring on
// the last colon-space that precedes a known reason, not the first colon, so a
// path containing a colon survives.
const TAR_PATH_FIRST_RE = /^(?:[a-z]*tar|bsdtar|gtar):\s+(.+?):\s+(?:Cannot|Can't|Couldn't|Could not|Error|Warning|Permission|No such)/i;
// bsdtar quotes the path in backticks instead: tar: Can't open `f': ...
const TAR_PATH_QUOTED_RE = /^(?:[a-z]*tar|bsdtar|gtar):\s+(?:Can't|Cannot|Couldn't|Could not)\s+\w+\s+[`'"](.+?)['"`]/i;

/**
 * The paths `tar` named in its own diagnostics.
 *
 * tar already names every offending path, so a message that reports them costs
 * nothing to produce. Both spellings are handled because the two ends of the
 * transfer do not agree on wording: GNU tar on the boxes says `Cannot open`,
 * bsdtar on the Mac says ``Can't open `f'``. The outage's message used the GNU
 * spelling, which is the evidence that what failed was the far end.
 */
export function parseTarFaultPaths(stderr: string): string[] {
  const paths: string[] = [];
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // The quoted shape is tried first because it is the more specific one. The
    // general `tar: <path>: <reason>` pattern also matches bsdtar's
    // ``tar: Can't open `f': Permission denied``, and captures
    // ``Can't open `f'`` as the path -- a wrong path in the message is worse
    // than none, because it sends the reader to a file that is not at fault.
    const match = TAR_PATH_QUOTED_RE.exec(trimmed) ?? TAR_PATH_FIRST_RE.exec(trimmed);
    const found = match?.[1]?.trim();
    // tar's trailing summary lines ("Error exit delayed from previous errors",
    // "Exiting with failure status due to previous errors") match no path and
    // must not be reported as one.
    if (!found || found.length === 0) continue;
    if (!paths.includes(found)) paths.push(found);
  }
  return paths;
}

// A diagnostic from tar itself, as opposed to from ssh or the network. Used to
// tell a payload fault (never retry: the next attempt sends the identical
// bytes) from a transport fault (a retry can legitimately help).
const TAR_DIAGNOSTIC_RE = /(?:^|\n)\s*(?:[a-z]*tar|bsdtar|gtar):\s/i;

/** Whether this stderr is `tar` complaining, rather than ssh or the network. */
export function isTarDiagnostic(stderr: string): boolean {
  return TAR_DIAGNOSTIC_RE.test(stderr);
}

/**
 * A transfer failed because of what was being transferred, or where it was
 * going — not because of the link in between.
 *
 * `retryable` is false and that is the whole purpose of the class. The outage's
 * bounded retry re-sent identical bytes twice and then reported `Retry
 * exhausted - manual intervention required`, which is three failed transfers
 * and a message pointing at the wrong thing.
 */
export class WorkspaceUnshippableError extends Error {
  readonly name = "WorkspaceUnshippableError";
  /** Never retry: another attempt transfers the identical bytes to the identical place. */
  readonly retryable = false;
  readonly stage: WorkspaceTransferStage;
  readonly faultPaths: string[];
  readonly toolStderr: string;
  readonly exitCode: number | null;

  constructor(input: {
    stage: WorkspaceTransferStage;
    summary: string;
    faultPaths: string[];
    toolStderr: string;
    exitCode?: number | null;
  }) {
    super(formatUnshippableMessage(input));
    this.stage = input.stage;
    this.faultPaths = input.faultPaths;
    this.toolStderr = input.toolStderr;
    this.exitCode = input.exitCode ?? null;
  }
}

/**
 * The run error code a payload or destination fault is recorded under.
 *
 * The server reads this to decide not to retry. A code of its own, rather than
 * the catch-all `adapter_failed`, is what makes the decision possible:
 * `adapter_failed` is classified as transient infrastructure and re-dispatched,
 * which is how three identical transfers came to be sent on 2026-10-05.
 */
export const WORKSPACE_UNSHIPPABLE_FAILURE_CODE = "workspace_unshippable";

/**
 * Whether this error says the payload or the destination is at fault.
 *
 * Structural rather than `instanceof` alone. The thrower is in this package and
 * the reader is in `server`, and under a bundler or a duplicated install the two
 * can hold different copies of the class, which makes `instanceof` answer false
 * for an error that is exactly this one. A gate that fails open is the defect
 * this whole module exists to remove, so the check does not depend on class
 * identity surviving the package boundary.
 */
export function isWorkspaceUnshippableError(error: unknown): error is WorkspaceUnshippableError {
  if (error instanceof WorkspaceUnshippableError) return true;
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<WorkspaceUnshippableError>;
  return (
    error.name === "WorkspaceUnshippableError" &&
    candidate.retryable === false &&
    Array.isArray(candidate.faultPaths)
  );
}

// How many offending paths a message carries. tar names every one, and a
// workspace with a whole unreadable subtree can name thousands; a message that
// scrolls a terminal is a message nobody reads. The count of the rest is kept.
const MAX_REPORTED_FAULT_PATHS = 10;

function formatUnshippableMessage(input: {
  stage: WorkspaceTransferStage;
  summary: string;
  faultPaths: string[];
  toolStderr: string;
}): string {
  const lines = [`${input.summary} (${input.stage}); this will not be retried.`];
  if (input.faultPaths.length > 0) {
    const shown = input.faultPaths.slice(0, MAX_REPORTED_FAULT_PATHS);
    lines.push(`Offending paths: ${shown.join(", ")}`);
    if (input.faultPaths.length > shown.length) {
      lines.push(`...and ${input.faultPaths.length - shown.length} more.`);
    }
  }
  const detail = input.toolStderr.trim();
  if (detail.length > 0) lines.push(detail);
  return lines.join("\n");
}

export interface WorkspacePackRehearsal {
  ok: boolean;
  exitCode: number | null;
  stderr: string;
  faultPaths: string[];
}

/**
 * Pack the payload to the null device and report whether it worked.
 *
 * Same program, same tree, same excludes, same flags as the shipment. Costs
 * about a second for a normal workspace, measured across 15 trees on the
 * fleet; the one tree that cost 117 seconds was 2.3 GB of files the transfer
 * excludes. So the caller must compute its excludes first and rehearse the
 * payload, never the directory as it sits: rehearsing the un-excluded tree
 * costs more than the transfer it protects, which is how a gate ends up
 * switched off.
 */
export async function rehearseWorkspacePack(input: {
  localDir: string;
  exclude?: readonly string[];
  followSymlinks?: boolean;
}): Promise<WorkspacePackRehearsal> {
  const args = buildWorkspacePackArgs({
    localDir: input.localDir,
    exclude: input.exclude,
    followSymlinks: input.followSymlinks,
    output: os.devNull,
  });

  return new Promise<WorkspacePackRehearsal>((resolve) => {
    const tar = spawn("tar", args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: workspacePackEnv(),
    });
    let stderr = "";
    let settled = false;
    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      const trimmed = stderr.trim();
      resolve({
        ok: (exitCode ?? 0) === 0,
        exitCode,
        stderr: trimmed,
        faultPaths: parseTarFaultPaths(trimmed),
      });
    };
    tar.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    // A rehearsal that cannot run is not a rehearsal that passed. `tar`
    // missing from PATH resolves to a failure with the spawn error as its
    // detail, so the caller refuses rather than shipping unproven bytes.
    tar.on("error", (error) => {
      stderr += `tar: ${String(error)}`;
      settle(null);
    });
    tar.on("close", (code) => settle(code));
  });
}

/**
 * Prove the payload is packable, or throw a non-retryable error naming the
 * paths that are not.
 */
export async function requirePackableWorkspace(input: {
  localDir: string;
  exclude?: readonly string[];
  followSymlinks?: boolean;
  stage?: WorkspaceTransferStage;
}): Promise<void> {
  const result = await rehearseWorkspacePack(input);
  if (result.ok) return;
  throw new WorkspaceUnshippableError({
    stage: input.stage ?? "workspace_pack_rehearsal",
    summary: `The workspace at ${input.localDir} cannot be packed, so it cannot be transferred`,
    faultPaths: result.faultPaths,
    toolStderr: result.stderr,
    exitCode: result.exitCode,
  });
}

/** Marker the remote precheck prints before each offending path. */
export const REMOTE_DESTINATION_FAULT_MARKER = "PAPERCLIP_DEST_FAULT";
/** Marker the remote precheck prints when it ran to the end, fault or not. */
export const REMOTE_DESTINATION_OK_MARKER = "PAPERCLIP_DEST_OK";

/**
 * Shell to prove a remote directory can be extracted into.
 *
 * A rehearsal on the sending side alone would have passed on the day of the
 * outage: the packer whose words appear in that failure is GNU tar, which is
 * not the packer on the Mac, so what failed was at the far end. The far end's
 * fault is not in the payload but in what is already sitting at the
 * destination, and it survives the clearing step: `rm -rf` cannot empty a
 * directory it may not enter (measured: `rm: dest/locked: Permission denied`,
 * `rm: dest: Directory not empty`, exit 1). So the stale entry stays, and the
 * extraction that follows dies on it.
 *
 * What extraction needs of every pre-existing entry:
 *  - a directory must be enterable and writable, or nothing can be placed in it;
 *  - a file must be writable, or it cannot be overwritten in place.
 *
 * `find`'s own permission warnings go to stderr and are discarded: a directory
 * it cannot descend into is still reported, because it is read from the parent.
 * The command is a plain `find` and a `test`, so it costs one round trip and no
 * bytes on the wire.
 */
export function buildRemoteDestinationPrecheckScript(input: {
  remoteDir: string;
  quote: (value: string) => string;
}): string {
  const dir = input.quote(input.remoteDir);
  return [
    `dir=${dir}`,
    // Nothing to check when the directory is not there yet: the transfer's own
    // `mkdir -p` makes it, and a parent that forbids that is reported here.
    'if [ ! -e "$dir" ]; then',
    '  parent=$(dirname -- "$dir")',
    '  if mkdir -p -- "$dir" 2>/dev/null; then',
    `    printf '%s\\n' ${input.quote(REMOTE_DESTINATION_OK_MARKER)}`,
    "    exit 0",
    "  fi",
    `  printf '%s %s\\n' ${input.quote(REMOTE_DESTINATION_FAULT_MARKER)} "$parent"`,
    // The OK marker means "this check ran to the end", not "this destination is
    // clean" -- the fault lines carry that. Every branch that completes prints
    // it, fault or no fault, because the parser reads its absence as unproven:
    // a branch that found a fault and left the marker off would be reported as
    // a check that never ran instead of as the fault it found.
    `  printf '%s\\n' ${input.quote(REMOTE_DESTINATION_OK_MARKER)}`,
    "  exit 0",
    "fi",
    'if [ ! -d "$dir" ]; then',
    `  printf '%s %s\\n' ${input.quote(REMOTE_DESTINATION_FAULT_MARKER)} "$dir"`,
    `  printf '%s\\n' ${input.quote(REMOTE_DESTINATION_OK_MARKER)}`,
    "  exit 0",
    "fi",
    // Every pre-existing entry the extraction would have to write through. One
    // line on purpose: a `find` expression broken across lines without a
    // continuation is a syntax error, and a script that dies before `find`
    // prints no OK marker, which the parser treats as unproven.
    `find "$dir" \\( \\( -type d \\( ! -perm -u+w -o ! -perm -u+x -o ! -perm -u+r \\) \\) -o \\( -type f ! -perm -u+w \\) \\) -print 2>/dev/null | while IFS= read -r p; do printf '%s %s\\n' ${input.quote(REMOTE_DESTINATION_FAULT_MARKER)} "$p"; done`,
    `printf '%s\\n' ${input.quote(REMOTE_DESTINATION_OK_MARKER)}`,
    "exit 0",
  ].join("\n");
}

/**
 * Shell to repair the paths the precheck named.
 *
 * The issue this answers asks the transfer to refuse *or repair and proceed*.
 * Repairing the destination is safe in a way repairing the payload is not:
 * these are directories the run itself created on a box to receive a copy, and
 * the only change is to give their owner back the access extraction needs.
 * `u+rwX` adds nothing executable to a plain file. Nothing is deleted, and a
 * path that cannot be repaired is left for the re-check to refuse.
 */
export function buildRemoteDestinationRepairScript(input: {
  faultPaths: string[];
  quote: (value: string) => string;
}): string {
  return input.faultPaths
    .map((faultPath) => `chmod u+rwX -- ${input.quote(faultPath)} 2>/dev/null || true`)
    .concat("exit 0")
    .join("\n");
}

/**
 * The offending paths the remote precheck reported.
 *
 * The OK marker is required, not assumed: a precheck whose output is missing
 * (a truncated read, a shell that died before `find`) must not be read as a
 * clean destination. That is the failure mode of the gate this whole change
 * replaces — a check that answered yes to every question — so absence of the
 * marker resolves to `null`, which the caller treats as unproven.
 */
export function parseRemoteDestinationPrecheckOutput(stdout: string): string[] | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.includes(REMOTE_DESTINATION_OK_MARKER)) return null;
  const faults: string[] = [];
  for (const line of lines) {
    if (!line.startsWith(`${REMOTE_DESTINATION_FAULT_MARKER} `)) continue;
    const faultPath = line.slice(REMOTE_DESTINATION_FAULT_MARKER.length + 1).trim();
    if (faultPath.length > 0 && !faults.includes(faultPath)) faults.push(faultPath);
  }
  return faults;
}

/**
 * Turn a failed transfer into an error that says which step failed, and
 * whether retrying it could ever help.
 *
 * `tarStderr` is the local packer's complaint, `sshStderr` the far end's,
 * carried back down the connection. Both are read, because either end can be
 * the one at fault and the outage was caused by reading only the second
 * without stripping ssh's banner from it.
 */
export function classifyTransferFailure(input: {
  stage: WorkspaceTransferStage;
  remoteDir?: string;
  localDir?: string;
  tarStderr: string;
  sshStderr: string;
  tarExitCode: number | null;
  sshExitCode: number | null;
}): Error {
  const tarStderr = input.tarStderr.trim();
  const sshStderr = stripSshNoise(input.sshStderr);

  if ((input.tarExitCode ?? 0) !== 0 && isTarDiagnostic(tarStderr)) {
    return new WorkspaceUnshippableError({
      stage: input.stage,
      summary: `The workspace${input.localDir ? ` at ${input.localDir}` : ""} cannot be packed, so it cannot be transferred`,
      faultPaths: parseTarFaultPaths(tarStderr),
      toolStderr: tarStderr,
      exitCode: input.tarExitCode,
    });
  }

  // The far end's own packer failed. Its words came back over the connection,
  // which is why this used to read as a sick box: the fault is in the payload
  // or in the destination tree, and no retry changes either.
  if ((input.sshExitCode ?? 0) !== 0 && isTarDiagnostic(sshStderr)) {
    return new WorkspaceUnshippableError({
      stage: input.stage,
      summary: `The destination${input.remoteDir ? ` at ${input.remoteDir}` : ""} could not receive the workspace`,
      faultPaths: parseTarFaultPaths(sshStderr),
      toolStderr: sshStderr,
      exitCode: input.sshExitCode,
    });
  }

  if ((input.tarExitCode ?? 0) !== 0) {
    return new Error(
      `${input.stage}: tar exited with code ${input.tarExitCode ?? -1}${tarStderr ? `\n${tarStderr}` : ""}`,
    );
  }

  // A genuine transport failure, and the only branch a retry can help. The
  // stage is named so the two steps that used to fail identically no longer do.
  return new Error(
    `${input.stage}: ssh exited with code ${input.sshExitCode ?? -1}${sshStderr ? `\n${sshStderr}` : ""}`,
  );
}

/** Guard a remote directory before it is used as an `rm -rf` or extract target. */
export function assertPlainAbsoluteRemoteDir(remoteDir: string): string {
  const trimmed = remoteDir.trim();
  if (!path.posix.isAbsolute(trimmed) || trimmed === "/" || trimmed.includes("..")) {
    throw new Error(`Refusing to use a remote path that is not a plain absolute directory: ${remoteDir}`);
  }
  return trimmed;
}
