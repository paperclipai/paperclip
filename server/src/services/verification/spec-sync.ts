import { runSshCommand, type SshRunInput, type SshRunResult } from "./ssh-runner.js";

export interface SpecSyncInput {
  /** Absolute path on the server container where acceptance skills live. */
  sourceDir: string;
  /** Absolute path on the browser-test VPS where specs should be extracted. */
  destDir: string;
  /** Override for tests */
  ssh?: (input: SshRunInput) => Promise<SshRunResult>;
  /** Override for shell exec (for tests) */
  exec?: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Skill directory names to sync (e.g. ["acceptance-viracue", "acceptance-api-specs"]) */
  skills: string[];
}

export interface SpecSyncResult {
  synced: string[];
  byteSize: number;
  skipped: string[];
}

/**
 * Syncs acceptance skill directories from the Paperclip server container to the browser-test VPS.
 *
 * Architecture note: the browser-test VPS runs Playwright against spec files that live in the
 * Paperclip repo. The Paperclip repo is private, so the VPS cannot clone it directly. Instead,
 * we tar the needed skill directories from inside the Paperclip server container (which has
 * them baked into the Docker image at /app/skills/), pipe over SSH, and extract on the remote.
 *
 * This is called at deploy time by the verification worker bootstrap (not yet wired in Phase 2 —
 * Phase 2 adds the helper; Phase 3 can wire it into the scheduler tick for auto-refresh).
 */
export async function syncSkillsToVps(input: SpecSyncInput): Promise<SpecSyncResult> {
  const ssh = input.ssh ?? runSshCommand;
  const host = process.env.BROWSER_TEST_HOST;
  const user = process.env.BROWSER_TEST_USER ?? "root";
  const keyPath = process.env.BROWSER_TEST_SSH_KEY;
  if (!host || !keyPath) {
    throw new Error("BROWSER_TEST_HOST or BROWSER_TEST_SSH_KEY not configured");
  }

  // Validate each skill name — defense against shell-injection via skill names.
  for (const skill of input.skills) {
    if (!/^[a-zA-Z0-9._-]+$/.test(skill)) {
      throw new Error(`invalid skill name for sync: ${skill}`);
    }
  }

  // Create remote destination + a temp transfer path, then atomically swap.
  const stagingDir = `${input.destDir}.staging.${Date.now()}`;
  const prepCmd = `mkdir -p ${stagingDir}/skills ${input.destDir}/skills`;
  await ssh({ host, user, keyPath, command: prepCmd, timeoutMs: 10_000 });

  // For each skill, tar it on the server, stream via ssh, extract on the VPS.
  // We use a child_process approach because tar | ssh piping can't run inside a single ssh command —
  // the server container is the tar source, and we need to run the pipe from the server's shell.
  const synced: string[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  // The server calls this helper from inside its own container, so sourceDir is readable locally
  // via fs. We use `tar -czf -` to stream compressed bytes to stdout, then base64-encode so we can
  // embed the bytes in an ssh command argument. This matches the trace uploader strategy.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);

  for (const skill of input.skills) {
    const sourcePath = `${input.sourceDir}/${skill}`;
    try {
      // Verify source exists on the server container
      await execFileP("test", ["-d", sourcePath]);
    } catch {
      skipped.push(skill);
      continue;
    }

    // Pack the skill to a local buffer via tar + base64
    const packCmd = `cd ${input.sourceDir} && tar -czf - ${skill} | base64 -w 0`;
    const { stdout: packedB64 } = await execFileP("sh", ["-c", packCmd], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const bytes = Buffer.from(packedB64.trim(), "base64");
    totalBytes += bytes.length;

    // Ship via a single ssh command that receives the base64 on stdin — but we can't pass stdin
    // via runSshCommand's current API. Instead, embed the base64 in the command string, which
    // works for skills up to ~2 MB safely. If skills grow larger we'll need to switch to SCP.
    if (bytes.length > 2 * 1024 * 1024) {
      throw new Error(
        `skill ${skill} is ${bytes.length} bytes — exceeds 2 MB inline limit; switch to SCP-based sync`,
      );
    }

    const unpackCmd = `cd ${stagingDir}/skills && echo '${packedB64.trim()}' | base64 -d | tar -xzf -`;
    await ssh({ host, user, keyPath, command: unpackCmd, timeoutMs: 30_000 });
    synced.push(skill);
  }

  // Atomic swap: move staging into place, keep previous for rollback if needed.
  const swapCmd = [
    `if [ -d ${input.destDir}/skills.previous ]; then rm -rf ${input.destDir}/skills.previous; fi`,
    `if [ -d ${input.destDir}/skills ]; then mv ${input.destDir}/skills ${input.destDir}/skills.previous; fi`,
    `mv ${stagingDir}/skills ${input.destDir}/skills`,
    `rm -rf ${stagingDir}`,
  ].join(" && ");
  await ssh({ host, user, keyPath, command: swapCmd, timeoutMs: 10_000 });

  return { synced, byteSize: totalBytes, skipped };
}
