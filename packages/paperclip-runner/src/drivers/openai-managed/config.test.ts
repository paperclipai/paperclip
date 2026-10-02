import { describe, expect, it } from "vitest";
import { parseOpenAiManagedProfile, parseOpenAiManagedEnvironment } from "./config.js";
import { createSanitizedOpenAiManagedEnvironment } from "./environment.js";
const profile = { profileId: "test", apiRevision: "agents=v1", reasoningEffort: "medium", environment: { type: "none" }, maxEstimatedSessionCostUsd: 1, timeoutSeconds: 60 };
describe("OpenAI managed boundary", () => {
  it("requires a closed profile with explicit limits", () => {
    expect(parseOpenAiManagedProfile(profile)).toEqual(profile);
    for (const change of [{ apiKey: "secret" }, { timeoutSeconds: 0 }, { maxEstimatedSessionCostUsd: NaN }, { apiRevision: "latest" }]) {
      expect(() => parseOpenAiManagedProfile({ ...profile, ...change })).toThrow();
    }
  });
  it("requires explicit sandbox networking and rejects wildcard domains", () => {
    const hosted = { type: "openai_hosted", container_size: "medium" };
    expect(() => parseOpenAiManagedEnvironment(hosted)).toThrow();
    expect(() => parseOpenAiManagedEnvironment({ ...hosted, network: { access: "restricted", allowed_domains: ["*.example.com"] } })).toThrow();
    expect(parseOpenAiManagedEnvironment({ ...hosted, network: { access: "disabled" } })).toEqual({ ...hosted, network: { access: "disabled" } });
  });
  it("rejects sandbox env credentials, duplicate files, and escaping paths", () => {
    const hosted = { type: "openai_hosted", container_size: "medium", network: { access: "disabled" } };
    expect(() => parseOpenAiManagedEnvironment({ ...hosted, env: { OPENAI_API_KEY: "secret" } })).toThrow();
    for (const path of ["/etc/passwd", "/workspace/../secret", "/workspace/./file"]) {
      expect(() => parseOpenAiManagedEnvironment({ ...hosted, files: [{ type: "inline", path, data: "YQ==" }] })).toThrow();
    }
    const file = { type: "inline", path: "/workspace/input.txt", data: "YQ==" };
    expect(() => parseOpenAiManagedEnvironment({ ...hosted, files: [file, file] })).toThrow();
  });
  it("keeps only the controller credential and ordinary transport environment", () => {
    expect(createSanitizedOpenAiManagedEnvironment({ OPENAI_API_KEY: "key", ANTHROPIC_API_KEY: "other", PAPERCLIP_API_KEY: "authority", AWS_SECRET_ACCESS_KEY: "aws", PATH: "/bin" })).toEqual({ OPENAI_API_KEY: "key", PATH: "/bin" });
  });
});
