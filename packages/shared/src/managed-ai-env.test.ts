import { describe, expect, it } from "vitest";
import {
  MANAGED_AI_NEUTRALIZED_ENV_KEYS,
  resolveNeutralizedManagedAiEnv,
} from "./managed-ai-env.js";

describe("managed AI environment neutralization", () => {
  it("resolves an empty neutralized key to an absent one", () => {
    const resolved = resolveNeutralizedManagedAiEnv({
      ANTHROPIC_BASE_URL: "",
      OPENAI_BASE_URL: "",
      XAI_BASE_URL: "",
      GOOGLE_GEMINI_BASE_URL: "",
      ANTHROPIC_BEDROCK_BASE_URL: "",
      PATH: "/usr/bin",
    });
    expect("ANTHROPIC_BASE_URL" in resolved).toBe(false);
    expect("OPENAI_BASE_URL" in resolved).toBe(false);
    expect("XAI_BASE_URL" in resolved).toBe(false);
    expect("GOOGLE_GEMINI_BASE_URL" in resolved).toBe(false);
    expect("ANTHROPIC_BEDROCK_BASE_URL" in resolved).toBe(false);
    expect(resolved.PATH).toBe("/usr/bin");
  });

  it("keeps a neutralized key the managed runtime gave a real value", () => {
    const resolved = resolveNeutralizedManagedAiEnv({
      CLAUDE_CONFIG_DIR: "/tmp/managed/provider",
      ANTHROPIC_AUTH_TOKEN: "token-value",
      ANTHROPIC_API_KEY: "",
    });
    expect(resolved.CLAUDE_CONFIG_DIR).toBe("/tmp/managed/provider");
    expect(resolved.ANTHROPIC_AUTH_TOKEN).toBe("token-value");
    expect("ANTHROPIC_API_KEY" in resolved).toBe(false);
  });

  it("leaves an empty value under any other key alone", () => {
    const resolved = resolveNeutralizedManagedAiEnv({
      SOME_PROJECT_FLAG: "",
      NO_PROXY: "",
    });
    expect(resolved.SOME_PROJECT_FLAG).toBe("");
    expect(resolved.NO_PROXY).toBe("");
  });

  it("covers every provider routing URL the neutralization writes", () => {
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
      "XAI_BASE_URL",
      "GOOGLE_GEMINI_BASE_URL",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "PAPERCLIP_AI_PROVIDER_URL",
    ]) {
      expect(MANAGED_AI_NEUTRALIZED_ENV_KEYS).toContain(key);
    }
  });
});
