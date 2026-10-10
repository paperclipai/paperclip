import { describe, it, expect } from "vitest";
import {
  aiProviderRoutingSchema,
  aiRoutingBaseUrl,
  createAiConnectionSchema,
  isAiConnectionCompatible,
} from "@paperclipai/shared";
import { managedProviderRouting } from "../services/ai-provider-routing.js";

describe("provider routing", () => {
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
    // OpenRouter is a built-in provider that can resolve its own default small
    // model, so it is not pinned like the projected `paperclip` provider.
    expect(opencode.env.PAPERCLIP_OPENCODE_SMALL_MODEL).toBeUndefined();
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
  it("rejects DeepSeek routing with a caller URL, region, or non-bearer auth", () => {
    expect(aiProviderRoutingSchema.safeParse({ kind: "deepseek", protocol: "chat", baseUrl: "https://evil.example" }).success).toBe(false);
    expect(aiProviderRoutingSchema.safeParse({ kind: "deepseek", protocol: "chat", auth: "none" }).success).toBe(false);
    expect(aiProviderRoutingSchema.safeParse({ kind: "deepseek", protocol: "bedrock", auth: "bearer" }).success).toBe(false);
    expect(aiProviderRoutingSchema.safeParse({ kind: "deepseek", protocol: "messages", auth: "bearer", models: [] }).success).toBe(true);
  });
  it("resolves the DeepSeek endpoint per protocol", () => {
    const messages = aiProviderRoutingSchema.parse({ kind: "deepseek", protocol: "messages", auth: "bearer", models: [] });
    const chat = aiProviderRoutingSchema.parse({ kind: "deepseek", protocol: "chat", auth: "bearer", models: [] });
    expect(aiRoutingBaseUrl(chat, "opencode_local")).toBe("https://api.deepseek.com");
    expect(aiRoutingBaseUrl(messages, "claude_local")).toBe("https://api.deepseek.com/anthropic");
  });
  it("projects DeepSeek to each harness without leaking a caller URL", () => {
    const chat = aiProviderRoutingSchema.parse({ kind: "deepseek", protocol: "chat", auth: "bearer", models: [] });
    const messages = aiProviderRoutingSchema.parse({ kind: "deepseek", protocol: "messages", auth: "bearer", models: [] });
    const opencode = managedProviderRouting(chat, "opencode_local", "ds-key", "deepseek-flash");
    expect(opencode.env.PAPERCLIP_AI_PROVIDER_KEY).toBe("ds-key");
    expect(opencode.env.PAPERCLIP_AI_PROVIDER_URL).toBe("https://api.deepseek.com");
    expect(opencode.config.model).toBe("paperclip/deepseek-flash");
    // The projected provider owns the only enabled provider, so the auxiliary
    // title model must be pinned to it or OpenCode aborts the run.
    expect(opencode.env.PAPERCLIP_OPENCODE_SMALL_MODEL).toBe("paperclip/deepseek-flash");
    expect(JSON.parse(String(opencode.env.OPENCODE_CONFIG_CONTENT))).toMatchObject({
      enabled_providers: ["paperclip"],
      small_model: "paperclip/deepseek-flash",
    });
    const hermes = managedProviderRouting(chat, "hermes_local", "ds-key", "deepseek-flash");
    expect(hermes.env.OPENAI_API_KEY).toBe("ds-key");
    expect(hermes.env.OPENAI_BASE_URL).toBe("https://api.deepseek.com");
    expect(hermes.hermesConfig).toContain('provider: "custom"');
    expect(hermes.hermesConfig).toContain('"https://api.deepseek.com"');
    expect(hermes.hermesConfig).not.toContain("ds-key");
    const codex = managedProviderRouting(chat, "codex_local", "ds-key", "deepseek-flash");
    expect(codex.codexConfig).toContain('model_provider = "paperclip"');
    expect(codex.codexConfig).toContain('wire_api = "responses"');
    expect(codex.codexConfig).toContain('base_url = "https://api.deepseek.com"');
    expect(codex.codexConfig).not.toContain("ds-key");
    // Codex's own default model is an OpenAI model, which DeepSeek rejects, so
    // the projected config must pin a DeepSeek model for the default path too.
    expect(codex.config.model).toBe("deepseek-flash");
    expect(managedProviderRouting(chat, "codex_local", "ds-key", "").config.model).toBe("deepseek-flash");
    expect(managedProviderRouting(chat, "codex_local", "ds-key", "gpt-5.6-sol").config.model).toBe("deepseek-flash");
    const claude = managedProviderRouting(messages, "claude_local", "ds-key", "deepseek-flash");
    expect(claude.env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe("ds-key");
    expect(claude.env.ANTHROPIC_MODEL).toBe("deepseek-flash[1m]");
    expect(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-flash");
    expect(claude.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-flash");
    // The Claude adapter passes config.model through --model and prefers it over
    // ANTHROPIC_MODEL, so the resolved DeepSeek model must be published there.
    expect(claude.config.model).toBe("deepseek-flash[1m]");
    expect(managedProviderRouting(messages, "claude_local", "ds-key", "deepseek-v4-pro").config.model).toBe("deepseek-v4-pro");
    expect(managedProviderRouting(messages, "claude_local", "ds-key", "").config.model).toBe("deepseek-flash[1m]");
  });
  it("maps DeepSeek reasoning effort into each harness's accepted domain", () => {
    const messages = aiProviderRoutingSchema.parse({ kind: "deepseek", protocol: "messages", auth: "bearer", models: [] });
    const chat = aiProviderRoutingSchema.parse({ kind: "deepseek", protocol: "chat", auth: "bearer", models: [] });
    expect(managedProviderRouting(messages, "claude_local", "k", "deepseek-flash", "ultra").env.CLAUDE_CODE_EFFORT_LEVEL).toBe("max");
    expect(managedProviderRouting(messages, "claude_local", "k", "deepseek-flash", "minimal").env.CLAUDE_CODE_EFFORT_LEVEL).toBe("low");
    expect(managedProviderRouting(messages, "claude_local", "k", "deepseek-flash", "medium").env.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
    const codex = managedProviderRouting(chat, "codex_local", "k", "deepseek-flash", "xhigh");
    expect(codex.codexConfig.startsWith('model_reasoning_effort = "high"\nmodel_provider = "paperclip"')).toBe(true);
    expect(managedProviderRouting(chat, "codex_local", "k", "deepseek-flash").codexConfig).not.toContain("model_reasoning_effort");
  });
  it("skips OpenCode's model-availability pre-flight for the projected provider", () => {
    const chat = aiProviderRoutingSchema.parse({ kind: "deepseek", protocol: "chat", auth: "bearer", models: [] });
    const openrouter = aiProviderRoutingSchema.parse({ kind: "openrouter", protocol: "chat", auth: "bearer", models: [] });
    expect(managedProviderRouting(chat, "opencode_local", "k", "deepseek-flash").env.OPENCODE_ALLOW_ALL_MODELS).toBe("1");
    expect(managedProviderRouting(openrouter, "opencode_local", "k", "openrouter/x/y").env.OPENCODE_ALLOW_ALL_MODELS).toBeUndefined();
  });
});
