import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalServiceKey } from "../server/src/services/local-service-supervisor.ts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createDevServiceIdentity(input: {
  forwardedArgs: string[];
  networkProfile: string;
  port: number;
}) {
  const envFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        forwardedArgs: input.forwardedArgs,
        networkProfile: input.networkProfile,
        port: input.port,
      }),
    )
    .digest("hex");

  const serviceName = "paperclip-dev-once";
  const serviceKey = createLocalServiceKey({
    profileKind: "paperclip-dev",
    serviceName,
    cwd: repoRoot,
    command: "dev-runner.ts",
    envFingerprint,
    port: input.port,
    scope: {
      repoRoot,
    },
  });

  return {
    serviceKey,
    serviceName,
    envFingerprint,
  };
}
