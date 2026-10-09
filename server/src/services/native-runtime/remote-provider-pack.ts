import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

/** Qualified ACPX releases carry their Linux image manifest and daemon. */
export function shouldUseBundledAcpxImageAssets(input: {
  requiresRemoteProviderPack: boolean;
  configuredProviderPackRoot: string | null;
  provider: NativeExecutionInput["provider"];
}): boolean {
  return input.requiresRemoteProviderPack && !input.configuredProviderPackRoot &&
    input.provider.kind === "acpx" &&
    ["cursor", "copilot"].includes(input.provider.agent);
}

/** Reuse only a pack that passes the same full verification as a new upload. */
export async function prepareVerifiedRemoteProviderPack(input: {
  verifyStaged: () => Promise<void>;
  usePreinstalled: () => Promise<boolean>;
  stageAndVerify: () => Promise<void>;
}): Promise<"staged" | "preinstalled" | "uploaded"> {
  try {
    await input.verifyStaged();
    return "staged";
  } catch {
    // Missing, stale, or modified packs are never executable cache hits.
  }
  if (await input.usePreinstalled()) return "preinstalled";
  await input.stageAndVerify();
  return "uploaded";
}
