import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalServiceKey } from "../server/src/services/local-service-supervisor.ts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createDevServiceIdentity(input: {
  mode: "watch" | "dev";
  forwardedArgs: string[];
  tailscaleAuth: boolean;
  port: number;
}) {
  const envFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        mode: input.mode,
        forwardedArgs: input.forwardedArgs,
        tailscaleAuth: input.tailscaleAuth,
        port: input.port,
      }),
    )
    .digest("hex");

  const serviceName = input.mode === "watch" ? "paperclip-dev-watch" : "paperclip-dev-once";
  const serviceKey = createLocalServiceKey({
    profileKind: "paperclip-dev",
    serviceName,
    cwd: repoRoot,
    command: "dev-runner.ts",
    envFingerprint,
    port: input.port,
    scope: {
      repoRoot,
      mode: input.mode,
    },
  });

  return {
    serviceKey,
    serviceName,
    envFingerprint,
  };
}
