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
