import { createLocalServiceKey } from "../server/src/services/local-service-supervisor.ts";
import { createDevServiceProfile, repoRoot } from "./dev-service-profile-core.mjs";

export { repoRoot };

export function createDevServiceIdentity(input: {
  mode: "watch" | "dev";
  forwardedArgs: string[];
  networkProfile: string;
  port: number;
  shadowSourceApi?: string;
}) {
  const profile = createDevServiceProfile(input);
  const serviceKey = createLocalServiceKey({
    profileKind: "paperclip-dev",
    serviceName: profile.serviceName,
    cwd: repoRoot,
    command: "dev-runner.ts",
    envFingerprint: profile.envFingerprint,
    port: input.port,
    scope: profile.scope,
  });

  return {
    serviceKey,
    serviceName: profile.serviceName,
    envFingerprint: profile.envFingerprint,
  };
}
