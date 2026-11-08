import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 4_000;

export interface OracleCommandResult { exitCode: number | null; stdout: string; stderr: string }

/** Quote a path for an SBPL string literal. */
function sbplString(value: string) { return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`; }

/**
 * macOS Seatbelt profile for a T-oracle command. The command runs code the
 * agent could edit, so it may not read the operator's home directory (for
 * example ~/.secrets or ~/.ssh), write anywhere except a scratch directory, or
 * use the network. The workspace stays readable.
 */
export function oracleSandboxProfile(input: { workspace: string; scratch: string; protectedRoots: readonly string[] }): string {
  const lines = ["(version 1)", "(allow default)", "(deny network*)", "(deny file-write*)",
    `(allow file-write* (subpath ${sbplString(input.scratch)}) (literal "/dev/null") (literal "/dev/tty"))`];
  for (const root of input.protectedRoots) lines.push(`(deny file-read* (subpath ${sbplString(root)}))`);
  // Later rules win: re-allow the workspace and scratch even if they sit under a protected root.
  lines.push(`(allow file-read* (subpath ${sbplString(input.workspace)}) (subpath ${sbplString(input.scratch)}))`);
  return lines.join("\n");
}

/**
 * Run one oracle command against an agent workspace with a minimal environment,
 * a scratch HOME, and (on macOS) a Seatbelt sandbox that hides the operator's
 * home directory. Elsewhere it refuses unless explicitly allowed, because a
 * temporary HOME alone does not stop absolute-path reads.
 */
export async function runOracleCommand(argv: readonly string[], workspace: string, options: {
  protectedRoots?: readonly string[]; timeoutMs?: number; platform?: NodeJS.Platform; allowUnsandboxed?: boolean;
} = {}): Promise<OracleCommandResult> {
  const platform = options.platform ?? process.platform;
  const sandboxed = platform === "darwin";
  if (!sandboxed && !options.allowUnsandboxed && process.env.RESTART_CHAOS_ALLOW_UNSANDBOXED_ORACLE !== "1") {
    return { exitCode: null, stdout: "", stderr: "oracle command refused: no sandbox on this platform (set RESTART_CHAOS_ALLOW_UNSANDBOXED_ORACLE=1 inside a disposable VM)" };
  }
  // Seatbelt matches resolved paths (/var is /private/var on macOS).
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "restart-chaos-oracle-")));
  const resolve = (value: string) => realpath(value).catch(() => value);
  try {
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin", HOME: scratch, TMPDIR: scratch,
      PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", LANG: "C.UTF-8" };
    const [command, args] = sandboxed
      ? ["/usr/bin/sandbox-exec", ["-p", oracleSandboxProfile({ workspace: await resolve(workspace), scratch,
        protectedRoots: await Promise.all((options.protectedRoots ?? [os.homedir()]).map(resolve)) }), ...argv]]
      : [argv[0]!, argv.slice(1)];
    try {
      const { stdout, stderr } = await execFileAsync(command, args, { cwd: workspace, env, timeout: options.timeoutMs ?? 60_000, maxBuffer: 1024 * 1024 });
      return { exitCode: 0, stdout: stdout.slice(-OUTPUT_LIMIT), stderr: stderr.slice(-OUTPUT_LIMIT) };
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string };
      return { exitCode: typeof failure.code === "number" ? failure.code : null, stdout: (failure.stdout ?? "").slice(-OUTPUT_LIMIT),
        stderr: (failure.stderr ?? String(error)).slice(-OUTPUT_LIMIT) };
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
