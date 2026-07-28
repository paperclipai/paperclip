import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createDevServiceProfile(input) {
  const variant = input.shadowSourceApi
    ? "shadow"
    : input.mode === "watch"
      ? "watch"
      : "once";
  const envFingerprint = createHash("sha256")
    .update(JSON.stringify({
      mode: input.mode,
      variant,
      forwardedArgs: input.forwardedArgs,
      networkProfile: input.networkProfile,
      port: input.port,
      shadowSourceApi: input.shadowSourceApi ?? null,
    }))
    .digest("hex");
  const serviceName = input.shadowSourceApi
    ? "paperclip-dev-shadow"
    : input.mode === "watch"
      ? "paperclip-dev-watch"
      : "paperclip-dev-once";

  return {
    serviceName,
    envFingerprint,
    scope: {
      repoRoot,
      mode: input.mode,
      variant,
      shadowSourceApi: input.shadowSourceApi ?? null,
    },
  };
}
