import { describe, expect, it } from "vitest";
import { configuredSecretGuidance } from "../services/native-runtime/configured-secret-guidance.js";
import { configuredEnvironmentProjection, configuredSecretEnvironment } from "../vendor/paperclip-runner/index.js";

describe("configured secret guidance", () => {
  it("tells the agent how to check a secret without printing it, by name only", () => {
    const guidance = configuredSecretGuidance(["PUBLISHING_API_KEY", "DEPLOY_TOKEN", "PUBLISHING_API_KEY"])!;
    expect(guidance).toContain("`DEPLOY_TOKEN`, `PUBLISHING_API_KEY`");
    expect(guidance).toContain('[ -n "$DEPLOY_TOKEN" ]');
    expect(guidance).toMatch(/Never print, echo, log, or write a secret value/);
  });

  it("adds nothing when the run has no configured secrets", () => {
    expect(configuredSecretGuidance([])).toBeNull();
  });

  it("names only configured entries the controller resolved from secrets", () => {
    const projection = configuredEnvironmentProjection(
      { PUBLISHING_API_KEY: "delivered-secret-value", REGION: "us-east-1" },
      new Set(["PUBLISHING_API_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY"]),
    );
    expect(configuredSecretEnvironment(projection).map(secret => secret.name)).toEqual(["PUBLISHING_API_KEY"]);
    expect(JSON.stringify(projection.PAPERCLIP_SECRET_ENV_KEYS)).not.toContain("delivered-secret-value");
  });
});
