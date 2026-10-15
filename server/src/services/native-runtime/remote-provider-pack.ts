import type { NativeRunTrace } from "./native-run-trace.js";

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
