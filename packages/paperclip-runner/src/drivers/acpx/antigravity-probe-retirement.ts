import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { acquireAcpxProviderLifetimeLease, type AcpxProviderLifetimeLease } from "./codex-credentials.js";
import { resolveAcpxHarnessStateRoot, resolveAcpxRuntimeRoot } from "./recovery-identity.js";

/** After all original startup work and the sidecar have retired, acquiring the
 * same kernel quorum proves the guarded native lifetime no longer owns this
 * credential home. No token bytes are read, changed, or used for authentication.
 */
export async function confirmAntigravityProbeNativeRetirement(runtimeDirectory: string, normalizedSessionId: string, harnessStateDirectory?: string): Promise<void> {
  let directory: string;
  try {
    const root = harnessStateDirectory === undefined
      ? await resolveAcpxRuntimeRoot(runtimeDirectory, normalizedSessionId)
      : await resolveAcpxHarnessStateRoot(harnessStateDirectory, normalizedSessionId);
    directory = join(root, "antigravity-home", "antigravity-acp");
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let lease: AcpxProviderLifetimeLease | undefined;
  // This owner retries only a concrete outstanding native lifetime or release.
  // It leaves no recurring work once the original native fence is free.
  while (true) {
    try {
      lease ??= await acquireAcpxProviderLifetimeLease({ agentHomeDirectory: directory });
      await lease.close();
      return;
    } catch (error) {
      if (!lease && (!(error instanceof Error) || error.message !== "Managed Codex credential home already has an active lease")) throw error;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
}
