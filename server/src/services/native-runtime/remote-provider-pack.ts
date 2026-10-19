import type { NativeRunTrace } from "./native-run-trace.js";

type VerificationCommandResult = {
  exitCode: number | null;
  timedOut: boolean;
  signal?: string | null;
  stdout: string;
  stderr: string;
};

/** Retry only these read-only probes, never provider work or artifact mutations.
 * Each transport call enforces its own 30s timeout; two attempts is the hard cap.
 * A completed, failing verifier is incompatible. An interrupted probe proves no
 * incompatibility. Exhaustion holds the original run: reattachment does not
 * spend a new provider attempt, so scheduling another attach could loop.
 */
export async function runRemoteProviderVerification(
  execute: () => Promise<VerificationCommandResult>,
  label: string,
): Promise<VerificationCommandResult> {
  let diagnostic = "command unavailable";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let result: VerificationCommandResult;
    try {
      result = await execute();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      diagnostic = error instanceof Error ? error.message : String(error);
      continue;
    }
    diagnostic = `exitCode=${result.exitCode}; timedOut=${result.timedOut}; signal=${result.signal ?? "none"}; ${result.stderr.trim().slice(-1_024)}`;
    if (result.timedOut || result.exitCode === null || result.signal) continue;
    if (result.exitCode !== 0) {
      throw new Error(`runner_remote_provider_artifact_incompatible: ${label} failed (${diagnostic})`);
    }
    return result;
  }
  throw new Error(`runner_remote_provider_verification_unavailable: ${label} unavailable after 2 verification attempts (${diagnostic.slice(-1_536)})`);
}

/** Reuse only a pack that passes the same full verification as a new upload. */
export async function prepareVerifiedRemoteProviderPack(input: {
  trace?: NativeRunTrace;
  verifyStaged: () => Promise<void>;
  usePreinstalled: () => Promise<boolean>;
  stageAndVerify: () => Promise<void>;
}): Promise<"staged" | "preinstalled" | "uploaded"> {
  const scope = input.trace?.start("provider_pack.select");
  let failed = false;
  const select = async () => {
    try {
      await input.verifyStaged();
      return "staged" as const;
    } catch {}
    if (await input.usePreinstalled()) return "preinstalled" as const;
    await input.stageAndVerify();
    return "uploaded" as const;
  };
  try {
    const source = scope ? await input.trace!.run(scope, select) : await select();
    if (scope) input.trace!.annotate(scope, { stateSource: source,
      reason: source === "uploaded" ? "cached_packs_unverified" : "verified_pack_reused" });
    return source;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (scope) await input.trace!.end(scope, { outcome: failed ? "failed" : "ok" });
  }
}

export async function useVerifiedPreinstalledRemoteProviderPack(input: {
  candidates: readonly string[];
  verifyAndLink: (root: string) => Promise<void>;
}): Promise<boolean> {
  for (const candidate of input.candidates) {
    try {
      await input.verifyAndLink(candidate);
      return true;
    } catch {
    }
  }
  return false;
}
