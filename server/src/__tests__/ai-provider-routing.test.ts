import { describe, it, expect } from "vitest";
import {
  aiProviderRoutingSchema,
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
  it("projects a Foundry resource and pinned deployment into Claude Code's native Foundry mode", () => {
    const routing = aiProviderRoutingSchema.parse({
      kind: "foundry",
      protocol: "messages",
      resource: "contoso-ai",
      models: [{ id: "claude-opus-4-8" }],
    });
    const projected = managedProviderRouting(
      routing,
      "claude_local",
      "fixture-foundry-key",
      "claude-opus-4-8",
    );
    expect(projected.env).toEqual({
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "contoso-ai",
      ANTHROPIC_FOUNDRY_API_KEY: "fixture-foundry-key",
      ANTHROPIC_MODEL: "claude-opus-4-8",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-opus-4-8",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-opus-4-8",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8",
    });
    expect(managedProviderRouting(routing, "claude_local", "fixture-foundry-key", "").env).not.toHaveProperty("ANTHROPIC_MODEL");
    const metadata = { provider: "anthropic", method: "api_key", routing } as const;
    expect(isAiConnectionCompatible(metadata, "claude_local")).toBe(true);
    // The qualified ACPX Claude credential boundary does not admit Foundry yet.
    expect(isAiConnectionCompatible(metadata, "paperclip_runner", "claude-opus-4-8", "acpx", "claude")).toBe(false);
    for (const adapter of ["codex_local", "opencode_local", "hermes_local"]) expect(isAiConnectionCompatible(metadata, adapter)).toBe(false);
  });
  it("routes other Foundry models through the resource's OpenAI-compatible v1 endpoint", () => {
    const responses = aiProviderRoutingSchema.parse({ kind: "foundry", protocol: "responses", resource: "contoso-ai" });
    const codex = managedProviderRouting(responses, "codex_local", "fixture-foundry-key", "gpt-5");
    expect(codex.env).toEqual({ PAPERCLIP_AI_PROVIDER_KEY: "fixture-foundry-key" });
    expect(codex.codexConfig).toContain('base_url = "https://contoso-ai.services.ai.azure.com/openai/v1"');
    expect(codex.codexConfig).toContain('wire_api = "responses"');
    expect(codex.codexConfig).toContain('env_key = "PAPERCLIP_AI_PROVIDER_KEY"');
    expect(isAiConnectionCompatible({ provider: "openai", method: "api_key", routing: responses }, "codex_local")).toBe(true);
    expect(isAiConnectionCompatible({ provider: "openai", method: "api_key", routing: responses }, "claude_local")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "openai", method: "api_key", routing: responses }, "paperclip_runner", "gpt-5", "codex")).toBe(true);

    const chat = aiProviderRoutingSchema.parse({ kind: "foundry", protocol: "chat", resource: "contoso-ai" });
    const opencode = managedProviderRouting(chat, "opencode_local", "fixture-foundry-key", "DeepSeek-R1");
    expect(opencode.env.PAPERCLIP_AI_PROVIDER_URL).toBe("https://contoso-ai.services.ai.azure.com/openai/v1");
    expect(opencode.config.model).toBe("paperclip/DeepSeek-R1");
    expect(opencode.env).not.toHaveProperty("CLAUDE_CODE_USE_FOUNDRY");
    const hermes = managedProviderRouting(chat, "hermes_local", "fixture-foundry-key", "DeepSeek-R1");
    expect(hermes.hermesConfig).toContain('base_url: "https://contoso-ai.services.ai.azure.com/openai/v1"');
  });
  it.each([
    [{ kind: "foundry", protocol: "messages" }, "requires a resource"],
    [{ kind: "foundry", protocol: "messages", auth: "api_key", resource: "contoso-ai" }, "requires the Foundry API key"],
    [{ kind: "foundry", protocol: "chat", auth: "none", resource: "contoso-ai" }, "requires authentication"],
    [{ kind: "foundry", protocol: "bedrock", resource: "contoso-ai" }, "rejects Bedrock"],
    [{ kind: "foundry", protocol: "messages", resource: "contoso-ai", baseUrl: "https://evil.example" }, "rejects a base URL"],
    [{ kind: "foundry", protocol: "messages", resource: "contoso-ai.services.ai.azure.com" }, "rejects a host name"],
    [{ kind: "foundry", protocol: "messages", resource: "https://contoso-ai" }, "rejects a URL"],
    [{ kind: "gateway", protocol: "messages", baseUrl: "https://gateway.example", resource: "contoso-ai" }, "keeps Azure settings on Foundry"],
  ])("rejects invalid Foundry routing %#: %s", (routing) => {
    expect(aiProviderRoutingSchema.safeParse(routing).success).toBe(false);
  });
  it("matches the Foundry connection provider to the selected API format", () => {
    const input = {
      provider: "openai",
      method: "api_key",
      name: "Foundry",
      ownership: "personal",
      apiKey: "fixture-foundry-key",
      routing: { kind: "foundry", protocol: "messages", resource: "contoso-ai" },
    };
    expect(createAiConnectionSchema.safeParse(input).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...input, provider: "anthropic" }).success).toBe(true);
    expect(createAiConnectionSchema.safeParse({ ...input, routing: { ...input.routing, protocol: "responses" } }).success).toBe(true);
  });

});
