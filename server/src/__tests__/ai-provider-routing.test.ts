import { describe, it, expect } from "vitest";
import {
  aiProviderRoutingSchema,
  aiRoutingHarness,
  aiRoutingModel,
  createAiConnectionSchema,
  isAiConnectionCompatible,
} from "@paperclipai/shared";
import { managedProviderRouting } from "../services/ai-provider-routing.js";

describe("provider routing", () => {
  it("routes managed OpenRouter accounts to direct and native Pi without OpenCode configuration", () => {
    const routing = aiProviderRoutingSchema.parse({ kind: "openrouter", protocol: "chat" });
    expect(aiRoutingHarness("paperclip_runner", "acpx", "pi")).toBe("pi_local");
    for (const adapterType of ["pi_local", "paperclip_runner"]) {
      expect(isAiConnectionCompatible({ provider: "openrouter", method: "api_key", routing }, adapterType, "openrouter/anthropic/model", "acpx", "pi")).toBe(true);
    }
    expect(aiRoutingModel(routing, "pi_local", "anthropic/model")).toBe("openrouter/anthropic/model");
    expect(aiRoutingModel(routing, "pi_local", "openrouter/anthropic/model")).toBe("openrouter/anthropic/model");
    const projected = managedProviderRouting(routing, "pi_local", "selected-pi-key", "anthropic/model");
    expect(projected).toMatchObject({ config: { model: "openrouter/anthropic/model" }, env: { OPENROUTER_API_KEY: "selected-pi-key" } });
    expect(projected.env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
    expect(isAiConnectionCompatible({ provider: "openai", method: "api_key", routing: aiProviderRoutingSchema.parse({ kind: "gateway", protocol: "chat", baseUrl: "https://gateway.example/v1" }) }, "pi_local", "custom/model")).toBe(false);
  });
  it.each(["openai", "anthropic", "google", "openrouter"] as const)("accepts Pi %s API keys only for matching models", provider => {
    expect(isAiConnectionCompatible({ provider, method: "api_key" }, "paperclip_runner", `${provider}/model`, "acpx", "pi")).toBe(true);
    expect(isAiConnectionCompatible({ provider, method: "subscription" }, "pi_local", `${provider}/model`)).toBe(false);
    expect(isAiConnectionCompatible({ provider, method: "subscription", mode: "responsible_user" }, "pi_local", `${provider}/model`)).toBe(true);
    expect(isAiConnectionCompatible({ provider, method: "api_key" }, "pi_local", "different/model")).toBe(false);
  });
  it("rejects paperclip_runner muse provider from Meta muse AI connection compatibility", () => {
    expect(aiRoutingHarness("paperclip_runner", "muse")).toBe("unsupported");
    expect(aiRoutingHarness("muse_local")).toBe("muse_local");
    expect(isAiConnectionCompatible({ provider: "muse", method: "api_key" }, "paperclip_runner", "muse-model", "muse")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "muse", method: "subscription" }, "paperclip_runner", "muse-model", "muse")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "muse", method: "api_key", mode: "responsible_user" }, "paperclip_runner", "muse-model", "muse")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "muse", method: "api_key" }, "muse_local")).toBe(true);
    expect(isAiConnectionCompatible({ provider: "muse", method: "subscription" }, "muse_local")).toBe(true);
  });
  it.each([
    "https://user:secret@gateway.example/v1",
    "https://gateway.example/v1?key=secret",
    "http://169.254.169.254/",
    "file:///tmp/secret",
    "https://gateway.example/#secret",
  ])("rejects unsafe or credential-bearing endpoint %s", (baseUrl) => {
    expect(
      aiProviderRoutingSchema.safeParse({
        kind: "gateway",
        protocol: "responses",
        baseUrl,
      }).success,
    ).toBe(false);
  });
  it("requires exactly the selected credential and disallows routed subscriptions", () => {
    const input = {
      provider: "openai",
      method: "api_key",
      name: "Local",
      ownership: "personal",
      routing: {
        kind: "local",
        protocol: "responses",
        auth: "none",
        baseUrl: "http://localhost:11434/v1",
      },
    };
    expect(createAiConnectionSchema.safeParse(input).success).toBe(true);
    expect(
      createAiConnectionSchema.safeParse({ ...input, apiKey: "unwanted" })
        .success,
    ).toBe(false);
    expect(
      createAiConnectionSchema.safeParse({
        ...input,
        method: "subscription",
        loginSessionId: "session",
      }).success,
    ).toBe(false);
  });
  it("rejects unsupported protocols and excluded remote adapters", () => {
    const routing = aiProviderRoutingSchema.parse({
      kind: "gateway",
      protocol: "chat",
      baseUrl: "https://gateway.example/v1",
    });
    for (const adapter of [
      "codex_local",
      "claude_local",
      "http",
      "process",
      "openclaw_gateway",
      "hermes_gateway",
      "acpx_local",
    ])
      expect(
        isAiConnectionCompatible(
          { provider: "openai", method: "api_key", routing },
          adapter,
        ),
      ).toBe(false);
    expect(
      isAiConnectionCompatible(
        { provider: "openai", method: "api_key", routing },
        "opencode_local",
      ),
    ).toBe(true);
    expect(
      isAiConnectionCompatible(
        { provider: "openai", method: "api_key", routing },
        "paperclip_runner",
        "model",
        "aws_agentcore",
      ),
    ).toBe(false);
  });
  it.each(["gateway", "openrouter"] as const)("uses a terminal-filtered secret variable for Hermes %s authentication", kind => {
    const route = aiProviderRoutingSchema.parse({ kind, protocol: "chat", auth: "bearer", ...(kind === "gateway" ? { baseUrl: "https://gateway.example/v1" } : {}) });
    const projected = managedProviderRouting(route, "hermes_local", "selected-key", "fixture-model");
    expect(projected.env.OPENAI_API_KEY).toBe("selected-key");
    expect(projected.env.PAPERCLIP_AI_PROVIDER_KEY).toBeUndefined();
    expect(projected.hermesConfig).toContain('api_key: "${OPENAI_API_KEY}"');
    expect(projected.hermesConfig).not.toContain("selected-key");
    expect(Object.entries(projected.env).filter(([, value]) => value === "selected-key").map(([name]) => name)).toEqual(kind === "openrouter" ? ["OPENAI_API_KEY", "OPENROUTER_API_KEY"] : ["OPENAI_API_KEY"]);
  });
  it("routes OpenRouter through each harness's protocol without putting secrets in Codex config", () => {
    const routing = aiProviderRoutingSchema.parse({
      kind: "openrouter",
      protocol: "responses",
    });
    const codex = managedProviderRouting(
      routing,
      "codex_local",
      "fixture-secret",
      "openai/gpt-5.4",
    );
    expect(codex.codexConfig).toContain('wire_api = "responses"');
    expect(codex.codexConfig).not.toContain("fixture-secret");
    const claude = managedProviderRouting(
      routing,
      "claude_local",
      "fixture-secret",
      "anthropic/claude-sonnet-4.6",
    );
    expect(claude.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-secret");
    expect(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
      "anthropic/claude-sonnet-4.6",
    );
    const opencode = managedProviderRouting(
      routing,
      "opencode_local",
      "fixture-secret",
      "anthropic/claude-sonnet-4.6",
    );
    expect(opencode.config.model).toBe(
      "openrouter/anthropic/claude-sonnet-4.6",
    );
  });
  it("projects only a Bedrock API key and rejects general AWS access keys", () => {
    const routing = aiProviderRoutingSchema.parse({
      kind: "bedrock",
      protocol: "bedrock",
      auth: "bearer",
      region: "us-east-1",
    });
    const projected = managedProviderRouting(
      routing,
      "claude_local",
      "fixture-bedrock-key",
      "bedrock-model",
    );
    expect(projected.env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: "fixture-bedrock-key",
      AWS_EC2_METADATA_DISABLED: "true",
    });
    expect(aiProviderRoutingSchema.safeParse({ ...routing, auth: "aws_credentials" }).success).toBe(false);
    for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) expect(projected.env).not.toHaveProperty(key);
  });
});
