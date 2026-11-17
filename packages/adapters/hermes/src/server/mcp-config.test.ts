import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import dotenv from "dotenv";
import YAML from "yaml";

import type { AdapterRuntimeMcpServer, AdapterSkillContext } from "@paperclipai/adapter-utils";
import {
  prepareHermesMcpHome,
  hermesMcpRelayPath,
  cleanupHermesMcpHome,
  cleanupStaleHermesProfiles,
  copyIsolatedSkills,
  sanitizeServerKey,
  sanitizeEnvVarName,
  sanitizeHostConfigYaml,
  filterProviderEnv,
  serializeHermesMcpYaml,
  serializeHermesDotenv,
  validateMcpServer,
  ALLOWED_HOST_CONFIG_KEYS,
  HERMES_TOOL_SEARCH_SETTING,
  HERMES_TOOL_SEARCH_DIRECT_MAX_TOOLS,
  resolveHermesToolSearchSetting,
  HERMES_PROVIDER_ENV_ALLOWLIST,
} from "./mcp-config.js";
import { resolveMemoryHardeningFlags } from "@paperclipai/adapter-utils/server-utils";
import { validateHermesMemoryConfig, MAX_CONFIG_STRING_LENGTH } from "./memory-config.js";
import { resolveHermesHome, resolveHostHermesDir, resolveHostHermesSkillsDir, listHermesSkills } from "./skills.js";

describe("Hermes MCP Config", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  describe("Anthropic request timeout profile", () => {
    it.each([45, 45.5, 300])("serializes a supported positive timeout %s", (value) => {
      const yaml = serializeHermesMcpYaml({}, "", false, undefined, value);
      expect(YAML.parse(yaml).providers.anthropic.request_timeout_seconds).toBe(value);
    });
    it.each([0, -1, Infinity, NaN])("rejects invalid timeout %s at the serializer boundary", (value) => {
      expect(() => serializeHermesMcpYaml({}, "", false, undefined, value)).toThrow(/positive finite/);
    });
    it("preserves explicit memory hardening alongside the timeout", () => {
      const generated = YAML.parse(serializeHermesMcpYaml({}, "", true, {
        hermesMemoryConfig: true,
        hermesPromptSplit: false,
        agentScopedMem0: false,
        capabilityMemoryGuidance: false,
        mem0AutoSyncOff: false,
      }, 45));
      expect(generated.providers.anthropic.request_timeout_seconds).toBe(45);
      expect(generated.memory).toEqual({
        provider: "mem0", memory_enabled: false, user_profile_enabled: false,
      });
    });
    it("keeps the optional setting absent and preserves sanitized host configuration", () => {
      const host = sanitizeHostConfigYaml("model:\n  default: claude-sonnet-5-5\nproviders:\n  anthropic:\n    request_timeout_seconds: 900\n");
      expect(YAML.parse(serializeHermesMcpYaml({}, host)).providers).toBeUndefined();
      const generated = YAML.parse(serializeHermesMcpYaml({}, host, false, undefined, 45));
      expect(generated.model.default).toBe("claude-sonnet-5-5");
      expect(generated.providers.anthropic.request_timeout_seconds).toBe(45);
    });
  });

  describe("Validation & Rejection", () => {
    it("rejects tokens containing carriage return or newline or null byte", () => {
      const baseServer: AdapterRuntimeMcpServer = {
        name: "test-server",
        url: "https://mcp.example.com",
        token: "clean-token",
        connectionId: "conn-1",
        allowedTools: ["tool1"],
      };

      expect(() => validateMcpServer({ ...baseServer, token: "bad\ntoken" })).toThrow(
        /Unsafe token for MCP server/,
      );
      expect(() => validateMcpServer({ ...baseServer, token: "bad\rtoken" })).toThrow(
        /Unsafe token for MCP server/,
      );
      expect(() => validateMcpServer({ ...baseServer, token: "bad\r\ntoken" })).toThrow(
        /Unsafe token for MCP server/,
      );
      expect(() => validateMcpServer({ ...baseServer, token: "bad\0token" })).toThrow(
        /Unsafe token for MCP server/,
      );
    });

    it("rejects empty token", () => {
      expect(() =>
        validateMcpServer({
          name: "test-server",
          url: "https://mcp.example.com",
          token: "",
          connectionId: "conn-1",
          allowedTools: ["tool1"],
        }),
      ).toThrow(/token must be non-empty/);
    });

    it("rejects token exceeding MAX_CONFIG_STRING_LENGTH", () => {
      expect(() =>
        validateMcpServer({
          name: "test-server",
          url: "https://mcp.example.com",
          token: "t".repeat(MAX_CONFIG_STRING_LENGTH + 1),
          connectionId: "conn-1",
          allowedTools: ["tool1"],
        }),
      ).toThrow(/token exceeds maximum allowed length/);
    });

    it("accepts token of exactly MAX_CONFIG_STRING_LENGTH characters", () => {
      expect(() =>
        validateMcpServer({
          name: "test-server",
          url: "https://mcp.example.com",
          token: "t".repeat(MAX_CONFIG_STRING_LENGTH),
          connectionId: "conn-1",
          allowedTools: ["tool1"],
        }),
      ).not.toThrow();
    });

    it("rejects server name exceeding MAX_CONFIG_STRING_LENGTH", () => {
      expect(() =>
        validateMcpServer({
          name: "n".repeat(MAX_CONFIG_STRING_LENGTH + 1),
          url: "https://mcp.example.com",
          token: "valid-token",
          connectionId: "conn-1",
          allowedTools: ["tool1"],
        }),
      ).toThrow(/name exceeds maximum allowed length/);
    });

    it("accepts server name of exactly MAX_CONFIG_STRING_LENGTH characters", () => {
      expect(() =>
        validateMcpServer({
          name: "n".repeat(MAX_CONFIG_STRING_LENGTH),
          url: "https://mcp.example.com",
          token: "valid-token",
          connectionId: "conn-1",
          allowedTools: ["tool1"],
        }),
      ).not.toThrow();
    });

    it("rejects server URL exceeding MAX_CONFIG_STRING_LENGTH", () => {
      expect(() =>
        validateMcpServer({
          name: "test-server",
          url: "https://mcp.example.com/" + "u".repeat(MAX_CONFIG_STRING_LENGTH),
          token: "valid-token",
          connectionId: "conn-1",
          allowedTools: ["tool1"],
        }),
      ).toThrow(/URL exceeds maximum allowed length/);
    });

    it("accepts server URL of exactly MAX_CONFIG_STRING_LENGTH characters", () => {
      const prefix = "https://mcp.example.com/";
      const exactUrl = prefix + "u".repeat(MAX_CONFIG_STRING_LENGTH - prefix.length);
      expect(exactUrl.length).toBe(MAX_CONFIG_STRING_LENGTH);
      expect(() =>
        validateMcpServer({
          name: "test-server",
          url: exactUrl,
          token: "valid-token",
          connectionId: "conn-1",
          allowedTools: ["tool1"],
        }),
      ).not.toThrow();
    });

    it("rejects non-HTTP/HTTPS URLs and URLs with CR/LF", () => {
      const baseServer: AdapterRuntimeMcpServer = {
        name: "test-server",
        url: "ftp://mcp.example.com",
        token: "tok",
        connectionId: "conn-1",
        allowedTools: ["tool1"],
      };

      expect(() => validateMcpServer(baseServer)).toThrow(/must be an HTTP or HTTPS URL/);
      expect(() =>
        validateMcpServer({ ...baseServer, url: "https://mcp.example.com\n" }),
      ).toThrow(/contains control characters or newlines/);
    });

    it("rejects server names with CR/LF", () => {
      expect(() =>
        validateMcpServer({
          name: "test\nserver",
          url: "https://mcp.example.com",
          token: "tok",
          connectionId: "conn-1",
          allowedTools: ["tool1"],
        }),
      ).toThrow(/contains control characters or newlines/);
    });

    it("fails closed when allowedTools is empty or missing or contains invalid tools", () => {
      const baseServer = {
        name: "test-server",
        url: "https://mcp.example.com",
        token: "tok",
        connectionId: "conn-1",
      };

      expect(() => validateMcpServer({ ...baseServer, allowedTools: [] })).toThrow(
        /no allowed tools provided; a finite non-empty allowlist is required/,
      );
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: undefined as unknown as string[] }),
      ).toThrow(/no allowed tools provided/);
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: ["valid_tool", "bad\ntool"] }),
      ).toThrow(/contains control characters or newlines/);
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: [""] }),
      ).toThrow(/must be a non-empty string/);
    });

    it("rejects unsafe glob metacharacters (*, ?, [, ], {, }) in tool names", () => {
      const baseServer = {
        name: "test-server",
        url: "https://mcp.example.com",
        token: "tok",
        connectionId: "conn-1",
      };

      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: ["tool*"] }),
      ).toThrow(/contains glob metacharacters/);
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: ["tool?"] }),
      ).toThrow(/contains glob metacharacters/);
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: ["tool[1-3]"] }),
      ).toThrow(/contains glob metacharacters/);
      expect(() =>
        validateMcpServer({ ...baseServer, allowedTools: ["tool{1,2}"] }),
      ).toThrow(/contains glob metacharacters/);
    });

    it("accepts valid tool names with punctuation without prefixes (verbatim names)", () => {
      const baseServer: AdapterRuntimeMcpServer = {
        name: "test-server",
        url: "https://mcp.example.com",
        token: "tok",
        connectionId: "conn-1",
        allowedTools: [
          "connections_search",
          "connection-request",
          "mcp.github-app:create_issue",
          "v1.tool.read",
        ],
      };

      expect(() => validateMcpServer(baseServer)).not.toThrow();
    });
  });

  describe("Sanitization & Collision Handling", () => {
    it("sanitizes server keys deterministically", () => {
      const usedKeys = new Set<string>();
      const k1 = sanitizeServerKey("Paperclip connections", "conn-1", usedKeys);
      expect(k1).toBe("paperclip_connections");

      const k2 = sanitizeServerKey("paperclip-assigned", "conn-2", usedKeys);
      expect(k2).toBe("paperclip_assigned");
    });

    it("resolves duplicate server names deterministically using connectionId and counter", () => {
      const usedKeys = new Set<string>();
      const k1 = sanitizeServerKey("Paperclip connections", "conn-alpha-1234", usedKeys);
      const k2 = sanitizeServerKey("Paperclip connections", "conn-beta-5678", usedKeys);
      const k3 = sanitizeServerKey("Paperclip connections", "conn-beta-5678", usedKeys);

      expect(k1).toBe("paperclip_connections");
      expect(k2).toBe("paperclip_connections_conn_beta_5678");
      expect(k3).toBe("paperclip_connections_conn_beta_5678_2");
    });

    it("sanitizes env var names deterministically and avoids collisions", () => {
      const usedEnvVars = new Set<string>();
      const v1 = sanitizeEnvVarName("paperclip_connections", usedEnvVars);
      expect(v1).toBe("HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS");

      const v2 = sanitizeEnvVarName("paperclip_connections", usedEnvVars);
      expect(v2).toBe("HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS_2");
    });
  });

  describe("Host Config & Provider Env Sanitization", () => {
    it("inherits only allowed provider/runtime posture keys from host config.yaml using real YAML parser", () => {
      const rawHostConfig = `
model:
  default: "anthropic/claude-sonnet-4"
  provider: "anthropic"

mcp_servers:
  forbidden_host_server:
    url: "http://malicious.local/mcp"

memory:
  enabled: true
  dir: "/host/memories"

database:
  path: "/host/state.db"

telemetry:
  enabled: true

browser:
  enabled: true

slack:
  token: "xoxb-secret"

terminal:
  enabled: true

providers:
  custom_provider:
    api_key: "nested-secret"

tool_loop_guardrails:
  max_iterations: 25

code_execution:
  timeout: 60
`;

      const sanitized = sanitizeHostConfigYaml(rawHostConfig);
      const parsed = YAML.parse(sanitized);

      expect(parsed.model).toEqual({
        default: "anthropic/claude-sonnet-4",
        provider: "anthropic",
      });
      expect(parsed.tool_loop_guardrails).toEqual({ max_iterations: 25 });
      expect(parsed.code_execution).toEqual({ timeout: 60 });

      // Strictly excludes dangerous/stateful/integration sections and nested unredacted credential sections
      expect(parsed.mcp_servers).toBeUndefined();
      expect(parsed.forbidden_host_server).toBeUndefined();
      expect(parsed.memory).toBeUndefined();
      expect(parsed.database).toBeUndefined();
      expect(parsed.telemetry).toBeUndefined();
      expect(parsed.browser).toBeUndefined();
      expect(parsed.slack).toBeUndefined();
      expect(parsed.terminal).toBeUndefined();
      expect(parsed.providers).toBeUndefined();
      expect(sanitized).not.toContain("nested-secret");

      expect(ALLOWED_HOST_CONFIG_KEYS.has("terminal")).toBe(false);
      expect(ALLOWED_HOST_CONFIG_KEYS.has("providers")).toBe(false);
      expect(ALLOWED_HOST_CONFIG_KEYS.has("memory")).toBe(false);
    });

    it("fails closed on multi-document YAML or non-mapping input", () => {
      // Multi-document YAML must return empty string
      const multiDoc = "model:\n  default: 'm1'\n---\nmodel:\n  default: 'm2'\n";
      expect(sanitizeHostConfigYaml(multiDoc)).toBe("");

      // Sequence/array root must return empty string
      const arrayYaml = "- item1\n- item2\n";
      expect(sanitizeHostConfigYaml(arrayYaml)).toBe("");

      // Primitive string or number root must return empty string
      expect(sanitizeHostConfigYaml("just a plain string")).toBe("");
      expect(sanitizeHostConfigYaml("42")).toBe("");
      expect(sanitizeHostConfigYaml("")).toBe("");

      // Syntax error must fail closed
      expect(sanitizeHostConfigYaml("model: [unclosed")).toBe("");
    });

    it("does not warn on empty or comment-only host config YAML", () => {
      const warnings: string[] = [];
      const onWarn = (msg: string) => warnings.push(msg);

      expect(sanitizeHostConfigYaml("", onWarn)).toBe("");
      expect(sanitizeHostConfigYaml("   \n\n  ", onWarn)).toBe("");
      expect(sanitizeHostConfigYaml("# just comments\n# second line", onWarn)).toBe("");
      expect(sanitizeHostConfigYaml("---\n# document separator with comment", onWarn)).toBe("");
      expect(warnings).toHaveLength(0);
    });

    it("emits warning on malformed or multi-document host config YAML", () => {
      const warnings: string[] = [];
      const onWarn = (msg: string) => warnings.push(msg);

      expect(sanitizeHostConfigYaml("model: [unclosed", onWarn)).toBe("");
      expect(warnings).toContain("Failed to parse host configuration: malformed YAML document");

      warnings.length = 0;
      expect(sanitizeHostConfigYaml("model:\n  default: 'a'\n---\nmodel:\n  default: 'b'", onWarn)).toBe("");
      expect(warnings).toContain("Failed to inherit host configuration: multi-document YAML is not supported");

      warnings.length = 0;
      expect(sanitizeHostConfigYaml("- item1\n- item2", onWarn)).toBe("");
      expect(warnings).toContain("Failed to inherit host configuration: expected a mapping at the root");
    });

    it("emits warning on dotenv parse failure", () => {
      const warnings: string[] = [];
      const parseSpy = vi.spyOn(dotenv, "parse").mockImplementationOnce(() => {
        throw new Error("Simulated dotenv syntax error");
      });
      try {
        const filtered = filterProviderEnv("BAD_DOTENV", (msg) => warnings.push(msg));
        expect(filtered).toEqual({});
        expect(warnings).toContain("Failed to parse host environment file");
      } finally {
        parseSpy.mockRestore();
      }
    });

    it("correctly ignores quoted forbidden keys and whitespace variations", () => {
      const quotedYaml = `
"mcp_servers":
  bad_server:
    url: "http://bad.local"
'memory'  :
  enabled: true
"model"  :
  default: "anthropic/claude-sonnet-4"
`;
      const sanitized = sanitizeHostConfigYaml(quotedYaml);
      const parsed = YAML.parse(sanitized);

      expect(parsed.mcp_servers).toBeUndefined();
      expect(parsed.memory).toBeUndefined();
      expect(parsed.model).toEqual({ default: "anthropic/claude-sonnet-4" });
    });

    it("filters host .env secrets using dotenv.parse with closed allowlist and aliases, excluding generic AWS keys", () => {
      const rawDotenv = `
# Core AI credentials and aliases
ANTHROPIC_API_KEY="sk-ant-123"
ANTHROPIC_TOKEN="ant-token"
CLAUDE_CODE_OAUTH_TOKEN="claude-token"
  OPENAI_BASE_URL  =  https://custom.openai.api/v1  # inline comment
OPENROUTER_API_KEY='sk-or-456'
GOOGLE_API_KEY=AIzaSyTest

# Provider-scoped Bedrock variables (allowed)
BEDROCK_AWS_ACCESS_KEY_ID="AKIA-BEDROCK"
BEDROCK_AWS_SECRET_ACCESS_KEY="secret-bedrock"
BEDROCK_AWS_SESSION_TOKEN="session-bedrock"
BEDROCK_AWS_REGION="us-east-1"

# Generic AWS keys (must be omitted from host inheritance)
AWS_ACCESS_KEY_ID="AKIA-GENERIC"
AWS_SECRET_ACCESS_KEY="generic-secret"
AWS_SESSION_TOKEN="aws-session-token"
AWS_REGION="us-west-2"
AWS_DEFAULT_REGION="us-west-2"

# Other unsafe/host secrets (must be omitted)
DATABASE_URL=postgres://user:pass@localhost:5432/db
PAPERCLIP_RUNTIME_TOOLS_TOKEN=rt-secret-123
SLACK_BOT_TOKEN=xoxb-1234
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_secret
`;

      const filtered = filterProviderEnv(rawDotenv);

      expect(filtered.ANTHROPIC_API_KEY).toBe("sk-ant-123");
      expect(filtered.ANTHROPIC_TOKEN).toBe("ant-token");
      expect(filtered.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-token");
      expect(filtered.OPENAI_BASE_URL).toBe("https://custom.openai.api/v1");
      expect(filtered.OPENROUTER_API_KEY).toBe("sk-or-456");
      expect(filtered.GOOGLE_API_KEY).toBe("AIzaSyTest");

      // Bedrock variables allowed
      expect(filtered.BEDROCK_AWS_ACCESS_KEY_ID).toBe("AKIA-BEDROCK");
      expect(filtered.BEDROCK_AWS_SECRET_ACCESS_KEY).toBe("secret-bedrock");
      expect(filtered.BEDROCK_AWS_SESSION_TOKEN).toBe("session-bedrock");
      expect(filtered.BEDROCK_AWS_REGION).toBe("us-east-1");

      // Generic AWS variables strictly excluded
      expect(filtered.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(filtered.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(filtered.AWS_SESSION_TOKEN).toBeUndefined();
      expect(filtered.AWS_REGION).toBeUndefined();
      expect(filtered.AWS_DEFAULT_REGION).toBeUndefined();

      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("BEDROCK_AWS_SESSION_TOKEN")).toBe(true);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_ACCESS_KEY_ID")).toBe(false);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_SECRET_ACCESS_KEY")).toBe(false);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_SESSION_TOKEN")).toBe(false);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_REGION")).toBe(false);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("AWS_DEFAULT_REGION")).toBe(false);

      // Denies non-allowlisted credentials
      expect(filtered.DATABASE_URL).toBeUndefined();
      expect(filtered.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBeUndefined();
      expect(filtered.SLACK_BOT_TOKEN).toBeUndefined();
      expect(filtered.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    });

    it("drops the whole host model section and provider for Router runs, keeping everything else", () => {
      const hostYaml =
        "model:\n  default: m\n  provider: custom\n  base_url: https://gw.example/v1\n  api_key: k\n  api_mode: chat_completions\n" +
        "provider: custom\n" +
        "temperature: 0.3\n";
      const router = YAML.parse(sanitizeHostConfigYaml(hostYaml, undefined, { canonicalRouterEndpoint: true }));
      expect(router.model).toBeUndefined();
      expect(router.provider).toBeUndefined();
      expect(router.temperature).toBe(0.3);
      const other = YAML.parse(sanitizeHostConfigYaml(hostYaml));
      expect(other.model.base_url).toBe("https://gw.example/v1");
      expect(other.model.api_key).toBe("k");
      expect(other.provider).toBe("custom");
    });

    it("drops unknown and credential-selector model keys too, so no override can leak through", () => {
      // A denylist would miss these; dropping the section cannot.
      const hostYaml =
        "model:\n  default: m\n  key_env: HOST_MODEL_KEY_ENV\n  api_key_env: HOST_API_KEY_ENV\n  some_future_alias: https://attacker.example/v1\n";
      const sanitized = sanitizeHostConfigYaml(hostYaml, undefined, { canonicalRouterEndpoint: true });
      expect(sanitized).toBe("");
      const parsed = YAML.parse(sanitizeHostConfigYaml(hostYaml));
      expect(parsed.model.key_env).toBe("HOST_MODEL_KEY_ENV");
    });

    it("omits an empty model instead of emitting `model: {}`", () => {
      for (const hostYaml of ["model: {}\n", "model:\n", "model: null\n"]) {
        expect(sanitizeHostConfigYaml(hostYaml, undefined, { canonicalRouterEndpoint: true })).toBe("");
      }
      // With nothing else allowed present the Router profile has an empty inherited section.
      expect(
        sanitizeHostConfigYaml("model: {}\nmcp_servers:\n  x:\n    url: http://x\n", undefined, {
          canonicalRouterEndpoint: true,
        }),
      ).toBe("");
    });

    it("allows the Ramp Router key but never its base-URL alias or the legacy ROUTER_API_KEY", () => {
      const filtered = filterProviderEnv([
        'RAMP_ROUTER_API_KEY="router-key-123"',
        'RAMP_ROUTER_BASE_URL="https://attacker.example/v1"',
        'ROUTER_API_KEY="legacy-key-456"',
      ].join("\n"));

      // The key reaches the run; the base URL is not allowlisted, so an agent's env
      // cannot redirect that key to another host.
      expect(filtered.RAMP_ROUTER_API_KEY).toBe("router-key-123");
      expect(filtered.RAMP_ROUTER_BASE_URL).toBeUndefined();
      expect(filtered.ROUTER_API_KEY).toBeUndefined();

      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("RAMP_ROUTER_API_KEY")).toBe(true);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("RAMP_ROUTER_BASE_URL")).toBe(false);
      expect(HERMES_PROVIDER_ENV_ALLOWLIST.has("ROUTER_API_KEY")).toBe(false);
    });

    it("parses dotenv edge cases: escaped backslashes, quotes, and whitespace around '='", () => {
      const dotenvContent = [
        '  OPENAI_API_KEY   =   "sk-test-val"  ',
        "  ANTHROPIC_BASE_URL = 'https://anthropic.test/api'",
        '  OPENROUTER_BASE_URL = "https:\\\\custom.router\\\\v1" # trailing comment',
      ].join("\n");
      const filtered = filterProviderEnv(dotenvContent);
      expect(filtered.OPENAI_API_KEY).toBe("sk-test-val");
      expect(filtered.ANTHROPIC_BASE_URL).toBe("https://anthropic.test/api");
      expect(filtered.OPENROUTER_BASE_URL).toBe("https:\\\\custom.router\\\\v1");
    });
  });

  describe("YAML and Dotenv Serialization", () => {
    it("serializes config.yaml containing only runtime-scoped MCP servers with resources and prompts false", () => {
      const mcpServers = {
        paperclip_connections: {
          url: "https://api.paperclip.test/mcp/runtime-tools",
          headers: {
            Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS}",
          },
          enabled: true as const,
          skip_preflight: true as const,
          tools: {
            resources: false as const,
            prompts: false as const,
            include: ["connections_search", "connection_request"],
          },
        },
      };

      const yaml = serializeHermesMcpYaml(mcpServers);
      expect(yaml).toContain("mcp_servers:\n");
      expect(yaml).toContain("  paperclip_connections:\n");
      expect(yaml).toContain('    url: "https://api.paperclip.test/mcp/runtime-tools"\n');
      expect(yaml).toContain('      Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_CONNECTIONS}"\n');
      expect(yaml).toContain("    enabled: true\n");
      expect(yaml).toContain("    skip_preflight: true\n");
      expect(yaml).toContain("    tools:\n");
      expect(yaml).toContain("      resources: false\n");
      expect(yaml).toContain("      prompts: false\n");
      expect(yaml).toContain("      include:\n");
      expect(yaml).toContain('        - "connections_search"\n');
      expect(yaml).toContain('        - "connection_request"\n');

      // Verify no raw token is in the YAML
      expect(yaml).not.toContain("raw-secret-token");
    });

    it("serializes .env safely quoting strings", () => {
      const envVars = {
        HERMES_MCP_TOKEN_SRV1: "token-value-123",
        HERMES_MCP_TOKEN_SRV2: 'token-with-"quotes"&symbols',
      };
      const dotenv = serializeHermesDotenv(envVars);
      expect(dotenv).toContain('HERMES_MCP_TOKEN_SRV1="token-value-123"\n');
      expect(dotenv).toContain('HERMES_MCP_TOKEN_SRV2="token-with-\\"quotes\\"&symbols"\n');
    });

    it("ensures PyYAML parses the generated config.yaml faithfully", (ctx) => {
      const mcpServers = {
        paperclip_assigned: {
          url: "http://127.0.0.1:3100/mcp/gateways/gw_abc",
          headers: {
            Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_ASSIGNED}",
          },
          enabled: true as const,
          skip_preflight: true as const,
          tools: {
            resources: false as const,
            prompts: false as const,
            include: ["mcp.github-app:create_issue", "mcp.github-app:get_issue"],
          },
        },
      };

      const yamlText = serializeHermesMcpYaml(mcpServers);

      let pyyamlAvailable = false;
      try {
        execFileSync("python3", ["-c", "import yaml"], { stdio: "ignore" });
        pyyamlAvailable = true;
      } catch {
        // Skip PyYAML check if python3 or pyyaml is not available in environment
      }

      if (!pyyamlAvailable) {
        ctx.skip();
        return;
      }

      const pythonResult = execFileSync(
        "python3",
        [
          "-c",
          `
import yaml, json, sys
data = yaml.safe_load(sys.stdin.read())
print(json.dumps(data))
`,
        ],
        { input: yamlText, encoding: "utf8" },
      );
      const parsed = JSON.parse(pythonResult);
      expect(parsed).toEqual({
        tools: { tool_search: { enabled: "off" } },
        mcp_servers: {
          paperclip_assigned: {
            url: "http://127.0.0.1:3100/mcp/gateways/gw_abc",
            headers: {
              Authorization: "Bearer ${HERMES_MCP_TOKEN_PAPERCLIP_ASSIGNED}",
            },
            enabled: true,
            skip_preflight: true,
            tools: {
              resources: false,
              prompts: false,
              include: ["mcp.github-app:create_issue", "mcp.github-app:get_issue"],
            },
          },
        },
      });
    });
  });

  describe("prepareHermesMcpHome", () => {
    it("returns serverKeys index-aligned with the written mcp_servers, exposing only allowlisted tools (deny-by-default)", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-home-"));
      cleanupDirs.push(mockHome);
      const hostHermesDir = path.join(mockHome, ".hermes");
      await fs.mkdir(hostHermesDir, { recursive: true });
      await fs.writeFile(
        path.join(hostHermesDir, "config.yaml"),
        "model:\n  default: m\nmcp_servers:\n  host_leak:\n    url: http://evil.example/mcp\n    tools:\n      include: ['*']\n",
      );

      const servers: AdapterRuntimeMcpServer[] = [
        { name: "Same Name", url: "http://localhost:3100/mcp/a", token: "tok-a", connectionId: "conn-a", allowedTools: ["tool_a", "tool_a", "tool_b"] },
        { name: "same-name", url: "http://localhost:3100/mcp/b", token: "tok-b", connectionId: "conn-b", allowedTools: ["tool_c"] },
      ];

      const prepared = await prepareHermesMcpHome({ servers, config: { env: { HOME: mockHome } } });
      cleanupDirs.push(prepared.homeDir);

      const written = YAML.parse(await fs.readFile(prepared.configPath, "utf8")) as {
        mcp_servers: Record<string, { url: string; tools: { include: string[]; resources: boolean; prompts: boolean } }>;
      };

      expect(prepared.serverKeys).toHaveLength(servers.length);
      expect(new Set(prepared.serverKeys).size).toBe(servers.length);
      expect(Object.keys(written.mcp_servers).sort()).toEqual([...prepared.serverKeys].sort());
      expect(written.mcp_servers).not.toHaveProperty("host_leak");
      servers.forEach((server, i) => {
        const entry = written.mcp_servers[prepared.serverKeys[i]!]!;
        expect(entry.url).toBe(server.url);
        expect(entry.tools.include).toEqual([...new Set(server.allowedTools)]);
        expect(entry.tools.resources).toBe(false);
        expect(entry.tools.prompts).toBe(false);
      });
    });

    it("creates isolated temp profile under ~/.hermes/profiles with config.yaml and .env", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-home-"));
      cleanupDirs.push(mockHome);

      const hostHermesDir = path.join(mockHome, ".hermes");
      await fs.mkdir(hostHermesDir, { recursive: true });

      // Write mock host config.yaml and .env
      await fs.writeFile(
        path.join(hostHermesDir, "config.yaml"),
        "model:\n  default: 'openai-codex/gpt-5'\n\nmemory:\n  enabled: true\n",
      );
      await fs.writeFile(
        path.join(hostHermesDir, ".env"),
        "OPENAI_API_KEY=sk-host-key\nDATABASE_URL=postgres://unsafe\n",
      );

      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "paperclip-assigned",
          url: "http://localhost:3100/mcp/gateways/gw_1",
          token: "pcgw_assigned_secret",
          connectionId: "conn-assigned",
          allowedTools: ["mcp.tool:one", "mcp.tool:two"],
        },
      ];

      const prepared = await prepareHermesMcpHome({
        servers,
        config: { env: { HOME: mockHome } },
      });
      cleanupDirs.push(prepared.homeDir);

      // Verify temp profile directory is created under <hostHermesHome>/profiles/paperclip-run-
      expect(prepared.homeDir).toContain(path.join(mockHome, ".hermes", "profiles", "paperclip-run-"));

      // Verify directory permissions 0700
      const dirStat = await fs.stat(prepared.homeDir);
      expect(dirStat.mode & 0o777).toBe(0o700);

      // Verify config.yaml permissions 0600
      const configStat = await fs.stat(prepared.configPath);
      expect(configStat.mode & 0o777).toBe(0o600);

      // Verify .env permissions 0600
      const envStat = await fs.stat(prepared.envPath);
      expect(envStat.mode & 0o777).toBe(0o600);

      // Verify config.yaml inherits model posture but strips memory
      const configYaml = await fs.readFile(prepared.configPath, "utf8");
      expect(configYaml).toContain("default: openai-codex/gpt-5");
      expect(configYaml).not.toContain("memory:");
      expect(configYaml).toContain("resources: false");
      expect(configYaml).toContain("prompts: false");

      // Verify temp .env contains ONLY run MCP tokens, NEVER provider secrets
      const envContent = await fs.readFile(prepared.envPath, "utf8");
      expect(envContent).toContain('HERMES_MCP_TOKEN_PAPERCLIP_ASSIGNED="pcgw_assigned_secret"');
      expect(envContent).not.toContain("OPENAI_API_KEY");
      expect(envContent).not.toContain("sk-host-key");

      // Verify prepared.providerEnv carries allowlisted provider secret for child env injection
      expect(prepared.providerEnv).toEqual({
        OPENAI_API_KEY: "sk-host-key",
      });
    });

    it("snapshots host skills into isolated directory, preventing write-through to host", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-host-home-"));
      cleanupDirs.push(mockHome);

      const hostSkillsDir = path.join(mockHome, ".hermes", "skills");
      await fs.mkdir(hostSkillsDir, { recursive: true });
      const hostSkillFile = path.join(hostSkillsDir, "test-skill.md");
      await fs.writeFile(hostSkillFile, "# Initial Host Skill Content");

      // An unsafe external symlink pointing outside of host skills directory
      const outsideFile = path.join(mockHome, "outside.txt");
      await fs.writeFile(outsideFile, "secret host data");
      await fs.symlink(outsideFile, path.join(hostSkillsDir, "unsafe-symlink.txt"));

      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "mcp-server",
          url: "http://localhost:3100/mcp",
          token: "tok",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      const prepared = await prepareHermesMcpHome({
        servers,
        config: { env: { HOME: mockHome } },
      });
      cleanupDirs.push(prepared.homeDir);

      const isolatedSkillsPath = path.join(prepared.homeDir, "skills");
      const stat = await fs.lstat(isolatedSkillsPath);
      // Isolated copy is a directory, NOT a symlink
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);

      const isolatedSkillFile = path.join(isolatedSkillsPath, "test-skill.md");
      const readSkill = await fs.readFile(isolatedSkillFile, "utf8");
      expect(readSkill).toBe("# Initial Host Skill Content");

      // Verify unsafe external symlink was skipped and never copied
      const unsafeInIsolated = await fs.lstat(path.join(isolatedSkillsPath, "unsafe-symlink.txt")).catch(() => null);
      expect(unsafeInIsolated).toBeNull();

      // Write-through regression: mutating isolated skills MUST NOT affect host skill
      await fs.writeFile(isolatedSkillFile, "# Mutated By Isolated Run");
      await fs.writeFile(path.join(isolatedSkillsPath, "new-isolated-skill.md"), "# New Isolated Skill");

      const hostSkillAfterMutate = await fs.readFile(hostSkillFile, "utf8");
      expect(hostSkillAfterMutate).toBe("# Initial Host Skill Content");
      const newFileInHost = await fs.stat(path.join(hostSkillsDir, "new-isolated-skill.md")).catch(() => null);
      expect(newFileInHost).toBeNull();

      // Cleanup temp home preserves host skills
      await cleanupHermesMcpHome(prepared.homeDir);

      const hostSkillContentAfterCleanup = await fs.readFile(hostSkillFile, "utf8");
      expect(hostSkillContentAfterCleanup).toBe("# Initial Host Skill Content");
    });

    it("resolves host skills properly even when config is omitted", async () => {
      // Calling without config must not crash
      const home = resolveHermesHome();
      expect(typeof home).toBe("string");
      const skillsDir = resolveHostHermesSkillsDir();
      expect(skillsDir).toContain(".hermes");
    });

    it("respects explicit HERMES_HOME in buildHermesSkillSnapshot / listHermesSkills", async () => {
      const mockHermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-custom-hermes-"));
      cleanupDirs.push(mockHermesHome);

      const skillDir = path.join(mockHermesHome, "skills", "custom-category", "custom-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: Custom Skill\ndescription: Test description\n---\n# Custom Skill\n",
      );

      const ctx: AdapterSkillContext = {
        agentId: "agent-1",
        companyId: "company-1",
        adapterType: "hermes_local",
        config: { env: { HERMES_HOME: mockHermesHome } },
      };
      const snapshot = await listHermesSkills(ctx);

      expect(snapshot.entries.some((e) => e.key === "custom-skill")).toBe(true);
    });

    it("emits warning on non-ENOENT read failure for host config.yaml or .env", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-read-warn-"));
      cleanupDirs.push(mockHome);

      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "test-server",
          url: "http://localhost:3100/mcp",
          token: "tok",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      const warnings: string[] = [];
      const originalReadFile = fs.readFile;
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, opts) => {
        if (typeof filePath === "string" && filePath.endsWith("config.yaml")) {
          const err = new Error("Permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        if (typeof filePath === "string" && filePath.endsWith(".env")) {
          const err = new Error("Permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return originalReadFile(filePath, opts);
      });

      try {
        const prepared = await prepareHermesMcpHome({
          servers,
          config: { env: { HOME: mockHome } },
          onWarning: (w) => warnings.push(w),
        });
        cleanupDirs.push(prepared.homeDir);

        expect(warnings).toContain("Failed to read host configuration file");
        expect(warnings).toContain("Failed to read host environment file");
      } finally {
        readSpy.mockRestore();
      }
    });

    it("hard-fails and cleans up temp home when chmod on config.yaml fails", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-chmod-cfg-fail-"));
      cleanupDirs.push(mockHome);

      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "test-server",
          url: "http://localhost:3100/mcp",
          token: "tok",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      let createdDir: string | null = null;
      const originalChmod = fs.chmod;
      const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (targetPath, mode) => {
        if (typeof targetPath === "string" && targetPath.endsWith("config.yaml")) {
          createdDir = path.dirname(targetPath);
          throw new Error("Simulated chmod failure on config.yaml");
        }
        return originalChmod(targetPath, mode);
      });

      try {
        await expect(
          prepareHermesMcpHome({
            servers,
            config: { env: { HOME: mockHome } },
          }),
        ).rejects.toThrow("Simulated chmod failure on config.yaml");

        expect(createdDir).toBeTruthy();
        await expect(fs.access(createdDir!)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        chmodSpy.mockRestore();
      }
    });

    it("cleans up temporary directory on failure during preparation", async () => {
      const badServers: AdapterRuntimeMcpServer[] = [
        {
          name: "bad-server",
          url: "http://localhost:3100/mcp",
          token: "token\nwith\nnewline",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      await expect(prepareHermesMcpHome({ servers: badServers })).rejects.toThrow(
        /Unsafe token for MCP server/,
      );
    });

    it("fails loudly when host profiles directory cannot be created without falling back", async () => {
      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "test-server",
          url: "http://localhost:3100/mcp",
          token: "tok-1",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      await expect(
        prepareHermesMcpHome({
          servers,
          config: { env: { HOME: "/dev/null/impossible-path" } },
        }),
      ).rejects.toThrow(/Cannot create Hermes profiles directory/);
    });

    it("reports warning when chmod on profiles directory fails", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-chmod-fail-"));
      cleanupDirs.push(mockHome);

      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "test-server",
          url: "http://localhost:3100/mcp",
          token: "tok-1",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      const warnings: string[] = [];
      const originalChmod = fs.chmod;
      const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (targetPath, mode) => {
        if (typeof targetPath === "string" && targetPath.endsWith("profiles")) {
          throw new Error("Simulated EPERM chmod failure");
        }
        return originalChmod(targetPath, mode);
      });

      try {
        const prepared = await prepareHermesMcpHome({
          servers,
          config: { env: { HOME: mockHome } },
          onWarning: (w) => warnings.push(w),
        });
        cleanupDirs.push(prepared.homeDir);

        expect(warnings).toContain("Failed to tighten permissions on Hermes profiles directory");
      } finally {
        chmodSpy.mockRestore();
      }
    });

    it("cleans up created temp directory if a post-mkdtemp step throws", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-post-mkdtemp-fail-"));
      cleanupDirs.push(mockHome);

      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "test-server",
          url: "http://localhost:3100/mcp",
          token: "tok",
          connectionId: "c1",
          allowedTools: ["tool1"],
        },
      ];

      let createdDir: string | null = null;
      const originalWriteFile = fs.writeFile;
      const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (filePath, data, opts) => {
        if (typeof filePath === "string" && filePath.endsWith("config.yaml")) {
          createdDir = path.dirname(filePath);
          // Confirm directory exists right before throwing
          expect(await fs.access(createdDir).then(() => true).catch(() => false)).toBe(true);
          throw new Error("Simulated disk error during config.yaml write");
        }
        return originalWriteFile(filePath, data, opts);
      });

      try {
        await expect(
          prepareHermesMcpHome({
            servers,
            config: { env: { HOME: mockHome } },
          }),
        ).rejects.toThrow("Simulated disk error during config.yaml write");

        // Verify that the created homeDir was cleaned up in the catch block
        expect(createdDir).toBeTruthy();
        await expect(fs.access(createdDir!)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("tool_search is forced off in isolated profiles (direct MCP exposure)", () => {
    const servers: AdapterRuntimeMcpServer[] = [
      { name: "gw", url: "http://localhost:3100/mcp/a", token: "tok-a", connectionId: "conn-a", allowedTools: ["tool_a"] },
    ];

    it("writes tools.tool_search.enabled as the string \"off\" and never lets host config override it", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-home-"));
      cleanupDirs.push(mockHome);
      const hostHermesDir = path.join(mockHome, ".hermes");
      await fs.mkdir(hostHermesDir, { recursive: true });
      await fs.writeFile(
        path.join(hostHermesDir, "config.yaml"),
        [
          "model:",
          "  default: m",
          "tools:",
          "  tool_search:",
          "    enabled: auto",
          "  include: ['*']",
          "",
        ].join("\n"),
      );

      const prepared = await prepareHermesMcpHome({ servers, config: { env: { HOME: mockHome } } });
      cleanupDirs.push(prepared.homeDir);

      const raw = await fs.readFile(prepared.configPath, "utf8");
      expect(raw.match(/^tools:/gm)).toHaveLength(1);
      const written = YAML.parse(raw) as { tools: Record<string, unknown>; model: { default: string } };
      expect(written.tools).toEqual({ tool_search: { enabled: HERMES_TOOL_SEARCH_SETTING } });
      expect(written.tools.tool_search).toEqual({ enabled: "off" });
      expect(typeof (written.tools.tool_search as { enabled: unknown }).enabled).toBe("string");
      expect(written.model.default).toBe("m");
    });

    it("keeps direct exposure at the cutoff and leaves the bridge on above it (TECH-8184)", () => {
      expect(resolveHermesToolSearchSetting(1)).toBe("off");
      expect(resolveHermesToolSearchSetting(HERMES_TOOL_SEARCH_DIRECT_MAX_TOOLS)).toBe("off");
      expect(resolveHermesToolSearchSetting(HERMES_TOOL_SEARCH_DIRECT_MAX_TOOLS + 1)).toBe("auto");
    });

    it("writes tool_search \"auto\" for a large allowlist and still ignores host config", async () => {
      const manyTools = Array.from({ length: HERMES_TOOL_SEARCH_DIRECT_MAX_TOOLS + 1 }, (_, i) => `tool_${i}`);
      const largeServers: AdapterRuntimeMcpServer[] = [
        { name: "gw", url: "http://localhost:3100/mcp/a", token: "tok-a", connectionId: "conn-a", allowedTools: manyTools },
      ];
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-home-"));
      cleanupDirs.push(mockHome);
      const hostHermesDir = path.join(mockHome, ".hermes");
      await fs.mkdir(hostHermesDir, { recursive: true });
      await fs.writeFile(
        path.join(hostHermesDir, "config.yaml"),
        ["model:", "  default: m", "tools:", "  tool_search:", "    enabled: off", ""].join("\n"),
      );

      const prepared = await prepareHermesMcpHome({ servers: largeServers, config: { env: { HOME: mockHome } } });
      cleanupDirs.push(prepared.homeDir);

      const raw = await fs.readFile(prepared.configPath, "utf8");
      expect(raw.match(/^tools:/gm)).toHaveLength(1);
      const written = YAML.parse(raw) as {
        tools: Record<string, unknown>;
        mcp_servers: Record<string, { tools: { include: string[] } }>;
      };
      expect(written.tools).toEqual({ tool_search: { enabled: "auto" } });
      // The allowlist still bounds what the bridge can reach.
      expect(Object.values(written.mcp_servers)[0]?.tools.include).toEqual(manyTools);
    });

    it("keeps host `tools` out of the inheritable key allowlist", () => {
      expect(ALLOWED_HOST_CONFIG_KEYS.has("tools")).toBe(false);
      expect(ALLOWED_HOST_CONFIG_KEYS.has("mcp_servers")).toBe(false);
      expect(sanitizeHostConfigYaml("tools:\n  tool_search:\n    enabled: auto\nmodel: m\n")).not.toContain("tool_search");
    });
  });

  describe("resolveHostHermesDir and resolveHostHermesSkillsDir precedence", () => {
    const originalHermesHome = process.env.HERMES_HOME;
    const originalHome = process.env.HOME;

    afterEach(() => {
      if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = originalHermesHome;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    it("prefers config.env.HERMES_HOME over everything else", () => {
      process.env.HERMES_HOME = "/env/hermes";
      process.env.HOME = "/env/home";
      const config = {
        env: {
          HERMES_HOME: "/config/hermes",
          HOME: "/config/home",
        },
      };

      expect(resolveHostHermesDir(config)).toBe(path.resolve("/config/hermes"));
      expect(resolveHostHermesSkillsDir(config)).toBe(path.resolve("/config/hermes/skills"));
    });

    it("prefers process.env.HERMES_HOME over HOME when config.env.HERMES_HOME is absent", () => {
      process.env.HERMES_HOME = "/process/hermes";
      process.env.HOME = "/process/home";
      const config = {
        env: {
          HOME: "/config/home",
        },
      };

      expect(resolveHostHermesDir(config)).toBe(path.resolve("/process/hermes"));
      expect(resolveHostHermesSkillsDir(config)).toBe(path.resolve("/process/hermes/skills"));
    });

    it("falls back to config.env.HOME/.hermes when HERMES_HOME is unset", () => {
      delete process.env.HERMES_HOME;
      process.env.HOME = "/process/home";
      const config = {
        env: {
          HOME: "/config/home",
        },
      };

      expect(resolveHostHermesDir(config)).toBe(path.resolve("/config/home/.hermes"));
      expect(resolveHostHermesSkillsDir(config)).toBe(path.resolve("/config/home/.hermes/skills"));
    });

    it("falls back safely to os.homedir()/.hermes when config is omitted", () => {
      delete process.env.HERMES_HOME;
      const expectedDir = path.join(os.homedir(), ".hermes");

      expect(resolveHostHermesDir()).toBe(expectedDir);
      expect(resolveHostHermesSkillsDir()).toBe(path.join(expectedDir, "skills"));
    });
  });

  describe("Stale Profile Cleanup & Error Callbacks", () => {
    it("cleans up only expired paperclip-run-* profiles older than 24h and preserves user profiles", async () => {
      const mockProfilesDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-profiles-"));
      cleanupDirs.push(mockProfilesDir);

      const staleDir = path.join(mockProfilesDir, "paperclip-run-stale-123");
      const freshDir = path.join(mockProfilesDir, "paperclip-run-fresh-456");
      const userProfileDir = path.join(mockProfilesDir, "my-coder-profile");

      await fs.mkdir(staleDir, { recursive: true });
      await fs.mkdir(freshDir, { recursive: true });
      await fs.mkdir(userProfileDir, { recursive: true });

      // Set old mtime on staleDir (25 hours ago)
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600_000);
      await fs.utimes(staleDir, twentyFiveHoursAgo, twentyFiveHoursAgo);

      // Fresh dir mtime is recent (2 hours ago)
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      await fs.utimes(freshDir, twoHoursAgo, twoHoursAgo);

      await cleanupStaleHermesProfiles(mockProfilesDir, 24 * 3600_000);

      // staleDir should be deleted
      await expect(fs.access(staleDir)).rejects.toMatchObject({ code: "ENOENT" });

      // freshDir should remain
      await expect(fs.access(freshDir)).resolves.toBeUndefined();

      // userProfileDir should remain untouched
      await expect(fs.access(userProfileDir)).resolves.toBeUndefined();
    });

    it("invokes warning callback with redacted message on cleanup error", async () => {
      const warnings: string[] = [];
      // Cleanup a read-only or invalid dir simulation
      await cleanupHermesMcpHome("/dev/null/impossible-path", (msg) => {
        warnings.push(msg);
      });
      // Should not throw, but report non-sensitive warning
      expect(warnings.length).toBe(1);
      expect(warnings[0]).not.toContain("/dev/null/impossible-path");
      expect(warnings[0]).toContain("Temporary Hermes home cleanup encountered an error");
    });
  });

  describe("copyIsolatedSkills", () => {
    it("copies skills across multiple sibling directories without false suppression", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-src-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-dest-"));
      cleanupDirs.push(srcDir, destDir);

      await fs.mkdir(path.join(srcDir, "catA", "skill1"), { recursive: true });
      await fs.writeFile(path.join(srcDir, "catA", "skill1", "SKILL.md"), "# Skill 1\n");

      await fs.mkdir(path.join(srcDir, "catB", "skill2"), { recursive: true });
      await fs.writeFile(path.join(srcDir, "catB", "skill2", "SKILL.md"), "# Skill 2\n");

      await copyIsolatedSkills(srcDir, destDir);

      const dest1 = path.join(destDir, "catA", "skill1", "SKILL.md");
      const dest2 = path.join(destDir, "catB", "skill2", "SKILL.md");

      expect(await fs.readFile(dest1, "utf8")).toBe("# Skill 1\n");
      expect(await fs.readFile(dest2, "utf8")).toBe("# Skill 2\n");
    });

    it("detects and terminates symlink cycles without infinite recursion", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-cycle-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-cycledest-"));
      cleanupDirs.push(srcDir, destDir);

      const parentDir = path.join(srcDir, "cycle_parent");
      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(path.join(parentDir, "SKILL.md"), "# Cycle test\n");

      // Symlink pointing back to parentDir creates an internal cycle
      await fs.symlink(parentDir, path.join(parentDir, "loop"));

      const warnings: string[] = [];
      await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));

      expect(await fs.readFile(path.join(destDir, "cycle_parent", "SKILL.md"), "utf8")).toBe("# Cycle test\n");
      expect(warnings.some((w) => w.includes("cycle"))).toBe(true);
    });

    it("emits a single incomplete-snapshot warning when copying an alias of a snapshot with skipped source entries", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-incomp-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-incompdest-"));
      cleanupDirs.push(srcDir, destDir);

      // Create canonical skill with one good file and one faulty file that fails to read
      const realDir = path.join(srcDir, "real_skill");
      await fs.mkdir(realDir, { recursive: true });
      await fs.writeFile(path.join(realDir, "good.txt"), "Good file\n");
      await fs.writeFile(path.join(realDir, "faulty.txt"), "Faulty file\n");

      // Create an alias pointing to real_skill (processed after real_skill in alphabetical order)
      await fs.symlink(realDir, path.join(srcDir, "z_alias_skill"));

      const originalReadFile = fs.readFile;
      (fs as any).readFile = async (filePath: any, opts: any) => {
        if (typeof filePath === "string" && filePath.includes("faulty.txt")) {
          const err = new Error("EIO: disk read error");
          (err as any).code = "EIO";
          throw err;
        }
        return originalReadFile(filePath, opts as any);
      };

      const warnings: string[] = [];
      try {
        await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));
      } finally {
        (fs as any).readFile = originalReadFile;
      }

      // Initial read of faulty file emits warning
      expect(warnings.some((w) => w.includes("Failed to read source file") && w.includes("faulty.txt"))).toBe(true);

      // Reusing incomplete snapshot for alias emits exactly one warning
      const incompleteWarnings = warnings.filter((w) => w.includes("incomplete"));
      expect(incompleteWarnings.length).toBe(1);
      expect(incompleteWarnings[0]).toContain("z_alias_skill");

      // Verify good file was copied to both real and alias destination
      expect(await fs.readFile(path.join(destDir, "real_skill", "good.txt"), "utf8")).toBe("Good file\n");
      expect(await fs.readFile(path.join(destDir, "z_alias_skill", "good.txt"), "utf8")).toBe("Good file\n");
    });

    it("safely skips broken symlinks without error", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-broken-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-brokendest-"));
      cleanupDirs.push(srcDir, destDir);

      const validDir = path.join(srcDir, "valid");
      await fs.mkdir(validDir, { recursive: true });
      await fs.writeFile(path.join(validDir, "SKILL.md"), "# Valid skill\n");

      // Broken symlink to nonexistent file
      await fs.symlink(path.join(srcDir, "nonexistent"), path.join(validDir, "broken_link"));

      await copyIsolatedSkills(srcDir, destDir);

      expect(await fs.readFile(path.join(destDir, "valid", "SKILL.md"), "utf8")).toBe("# Valid skill\n");
    });

    it("handles diamond DAG without exponential traversal, reading shared canonical directory only once", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-diamond-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-diamonddest-"));
      cleanupDirs.push(srcDir, destDir);

      // Create a shared directory inside srcDir
      const sharedDir = path.join(srcDir, "shared_skill");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, "SKILL.md"), "# Shared Skill\n");

      // Create two categories that both symlink to the same shared directory (diamond DAG)
      const catA = path.join(srcDir, "category_a");
      const catB = path.join(srcDir, "category_b");
      await fs.mkdir(catA, { recursive: true });
      await fs.mkdir(catB, { recursive: true });
      await fs.symlink(sharedDir, path.join(catA, "shared_link"));
      await fs.symlink(sharedDir, path.join(catB, "shared_link"));

      let sharedReaddirCount = 0;
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (dirPath, opts) => {
        if (typeof dirPath === "string" && dirPath.includes("shared_skill")) {
          sharedReaddirCount++;
        }
        return originalReaddir(dirPath, opts);
      });

      const warnings: string[] = [];
      try {
        await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));
        // Shared directory should only be read once from source
        expect(sharedReaddirCount).toBe(1);

        // Both destination paths must receive complete cached isolated contents
        const destA = path.join(destDir, "category_a", "shared_link", "SKILL.md");
        const destB = path.join(destDir, "category_b", "shared_link", "SKILL.md");
        expect(await fs.readFile(destA, "utf8")).toBe("# Shared Skill\n");
        expect(await fs.readFile(destB, "utf8")).toBe("# Shared Skill\n");

        // Verify restrictive perms and no symlinks in destination
        const statA = await fs.lstat(path.join(destDir, "category_a", "shared_link"));
        expect(statA.isSymbolicLink()).toBe(false);
        expect(statA.isDirectory()).toBe(true);
        expect(statA.mode & 0o777).toBe(0o700);

        const statB = await fs.lstat(path.join(destDir, "category_b", "shared_link"));
        expect(statB.isSymbolicLink()).toBe(false);
        expect(statB.isDirectory()).toBe(true);
        expect(statB.mode & 0o777).toBe(0o700);

        const fileStat = await fs.stat(destB);
        expect(fileStat.mode & 0o777).toBe(0o600);
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it("handles alias-first traversal order leaving both destinations complete with restrictive perms and no symlinks", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-aliasfirst-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-aliasdest-"));
      cleanupDirs.push(srcDir, destDir);

      // Create target directory named 'z_real_skill' so 'a_alias_link' is traversed first
      const realDir = path.join(srcDir, "z_real_skill");
      await fs.mkdir(realDir, { recursive: true });
      await fs.writeFile(path.join(realDir, "SKILL.md"), "# Alias First Skill\n");

      // Symlink 'a_alias_link' points to 'z_real_skill'
      await fs.symlink(realDir, path.join(srcDir, "a_alias_link"));

      const srcReal = await fs.realpath(srcDir);
      let realDirReaddirCount = 0;
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (dirPath, opts) => {
        if (typeof dirPath === "string" && (dirPath.startsWith(srcDir) || dirPath.startsWith(srcReal)) && dirPath.includes("z_real_skill")) {
          realDirReaddirCount++;
        }
        return originalReaddir(dirPath, opts);
      });

      try {
        await copyIsolatedSkills(srcDir, destDir);
        // Source should only be traversed once
        expect(realDirReaddirCount).toBe(1);

        // Both destinations must be complete
        const aliasSkill = path.join(destDir, "a_alias_link", "SKILL.md");
        const realSkill = path.join(destDir, "z_real_skill", "SKILL.md");
        expect(await fs.readFile(aliasSkill, "utf8")).toBe("# Alias First Skill\n");
        expect(await fs.readFile(realSkill, "utf8")).toBe("# Alias First Skill\n");

        // Verify restrictive permissions and no symlinks
        const aliasStat = await fs.lstat(path.join(destDir, "a_alias_link"));
        expect(aliasStat.isSymbolicLink()).toBe(false);
        expect(aliasStat.isDirectory()).toBe(true);
        expect(aliasStat.mode & 0o777).toBe(0o700);

        const realStat = await fs.lstat(path.join(destDir, "z_real_skill"));
        expect(realStat.isSymbolicLink()).toBe(false);
        expect(realStat.isDirectory()).toBe(true);
        expect(realStat.mode & 0o777).toBe(0o700);
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it("handles real-first traversal order leaving both destinations complete with restrictive perms and no symlinks", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-realfirst-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-realdest-"));
      cleanupDirs.push(srcDir, destDir);

      // Create target directory named 'a_real_skill' so it is traversed before 'z_alias_link'
      const realDir = path.join(srcDir, "a_real_skill");
      await fs.mkdir(realDir, { recursive: true });
      await fs.writeFile(path.join(realDir, "SKILL.md"), "# Real First Skill\n");

      // Symlink 'z_alias_link' points to 'a_real_skill'
      await fs.symlink(realDir, path.join(srcDir, "z_alias_link"));

      const srcReal = await fs.realpath(srcDir);
      let realDirReaddirCount = 0;
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (dirPath, opts) => {
        if (typeof dirPath === "string" && (dirPath.startsWith(srcDir) || dirPath.startsWith(srcReal)) && dirPath.includes("a_real_skill")) {
          realDirReaddirCount++;
        }
        return originalReaddir(dirPath, opts);
      });

      try {
        await copyIsolatedSkills(srcDir, destDir);
        // Source should only be traversed once
        expect(realDirReaddirCount).toBe(1);

        // Both destinations must be complete
        const realSkill = path.join(destDir, "a_real_skill", "SKILL.md");
        const aliasSkill = path.join(destDir, "z_alias_link", "SKILL.md");
        expect(await fs.readFile(realSkill, "utf8")).toBe("# Real First Skill\n");
        expect(await fs.readFile(aliasSkill, "utf8")).toBe("# Real First Skill\n");

        // Verify restrictive permissions and no symlinks
        const realStat = await fs.lstat(path.join(destDir, "a_real_skill"));
        expect(realStat.isSymbolicLink()).toBe(false);
        expect(realStat.isDirectory()).toBe(true);
        expect(realStat.mode & 0o777).toBe(0o700);

        const aliasStat = await fs.lstat(path.join(destDir, "z_alias_link"));
        expect(aliasStat.isSymbolicLink()).toBe(false);
        expect(aliasStat.isDirectory()).toBe(true);
        expect(aliasStat.mode & 0o777).toBe(0o700);
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it("skips entry and emits warning when source readFile encounters EIO error without aborting run", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-eio-src-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-eio-dest-"));
      cleanupDirs.push(srcDir, destDir);

      const faultyFile = path.join(srcDir, "faulty.txt");
      const okFile = path.join(srcDir, "ok.txt");
      await fs.writeFile(faultyFile, "Faulty source data");
      await fs.writeFile(okFile, "Good source data");

      const warnings: string[] = [];
      const originalReadFile = fs.readFile;
      const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, opts) => {
        if (typeof filePath === "string" && filePath.includes("faulty.txt")) {
          const err = new Error("EIO: i/o error") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return originalReadFile(filePath, opts as any);
      });

      try {
        await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));

        // Must emit warning for the failed file read
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.some((w) => w.includes("Failed to read source file") && w.includes("faulty.txt"))).toBe(true);

        // Good file must still be copied
        expect(await fs.readFile(path.join(destDir, "ok.txt"), "utf8")).toBe("Good source data");
      } finally {
        readFileSpy.mockRestore();
      }
    });

    it("aborts fail-closed when destination writeFile encounters EIO error", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-desteio-src-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-desteio-dest-"));
      cleanupDirs.push(srcDir, destDir);

      await fs.writeFile(path.join(srcDir, "SKILL.md"), "# Content\n");

      const originalWriteFile = fs.writeFile;
      const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (filePath, data, opts) => {
        if (typeof filePath === "string" && filePath.startsWith(destDir)) {
          const err = new Error("EIO: disk write error") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return originalWriteFile(filePath, data, opts as any);
      });

      try {
        await expect(copyIsolatedSkills(srcDir, destDir)).rejects.toThrow("EIO: disk write error");
      } finally {
        writeFileSpy.mockRestore();
      }
    });

    it("emits redacted warning and skips entry on non-ENOENT source read failure without aborting run", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-perm-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-permdest-"));
      cleanupDirs.push(srcDir, destDir);

      const restrictedDir = path.join(srcDir, "restricted");
      await fs.mkdir(restrictedDir, { recursive: true });
      const validDir = path.join(srcDir, "valid");
      await fs.mkdir(validDir, { recursive: true });
      await fs.writeFile(path.join(validDir, "SKILL.md"), "# Valid skill\n");

      const warnings: string[] = [];
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (dirPath, opts) => {
        if (typeof dirPath === "string" && dirPath.includes("restricted")) {
          const err = new Error("Permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return originalReaddir(dirPath, opts);
      });

      try {
        await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));

        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toContain("Failed to read directory");
        expect(await fs.readFile(path.join(destDir, "valid", "SKILL.md"), "utf8")).toBe("# Valid skill\n");
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it("continues without skills when top-level host skills directory is unreadable", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-toplevel-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-topleveldest-"));
      cleanupDirs.push(srcDir, destDir);

      const warnings: string[] = [];
      const originalStat = fs.stat;
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (filePath, opts) => {
        if (typeof filePath === "string" && filePath === srcDir) {
          const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return originalStat(filePath, opts as any);
      });

      try {
        await copyIsolatedSkills(srcDir, destDir, (msg) => warnings.push(msg));
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("Failed to stat skills directory");
      } finally {
        statSpy.mockRestore();
      }
    });

    it("fails closed when destination write or chmod fails", async () => {
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-destfail-"));
      const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-destfaildest-"));
      cleanupDirs.push(srcDir, destDir);

      await fs.writeFile(path.join(srcDir, "SKILL.md"), "# Skill\n");

      // Make destination read-only so writes fail
      await fs.chmod(destDir, 0o500);

      try {
        await expect(copyIsolatedSkills(srcDir, path.join(destDir, "sub"))).rejects.toThrow();
      } finally {
        await fs.chmod(destDir, 0o700);
      }
    });
  });

  describe("Runtime Memory in Isolated Home", () => {
    const validMemConfig = validateHermesMemoryConfig({
      provider: "mem0",
      mode: "oss",
      userId: "company",
      agentId: "agent-test-mem-1",
      llm: {
        provider: "openai",
        config: { model: "gpt-5.4-mini" },
      },
      embedder: {
        provider: "openai",
        config: { model: "text-embedding-3-small" },
      },
      vectorStore: {
        provider: "pgvector",
        config: {
          host: "postgres-tenant-node.internal",
          port: 5432,
          user: "tenant_user",
          password: "SuperSecretPassword123!",
          dbname: "tenant_isolated_db",
          sslmode: "require",
          collectionName: "mem0_collection",
        },
      },
    });

    it("prepares isolated home with memory when servers list is empty", async () => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-mem-"));
      cleanupDirs.push(mockHost);

      const prepared = await prepareHermesMcpHome({
        servers: [],
        memory: validMemConfig,
        config: { env: { HERMES_HOME: mockHost } },
      });
      cleanupDirs.push(prepared.homeDir);

      // Verify all created directories and files are beneath the temp test root
      expect(prepared.homeDir.startsWith(mockHost)).toBe(true);
      expect(prepared.configPath.startsWith(mockHost)).toBe(true);
      expect(prepared.envPath.startsWith(mockHost)).toBe(true);
      expect(prepared.mem0JsonPath?.startsWith(mockHost)).toBe(true);

      expect(prepared.serverCount).toBe(0);
      expect(prepared.hasMemory).toBe(true);
      expect(prepared.mem0JsonPath).toBe(path.join(prepared.homeDir, "mem0.json"));

      // Verify that secrets are NOT exposed in prepared home result
      expect((prepared as any).password).toBeUndefined();
      expect(JSON.stringify(prepared)).not.toContain("SuperSecretPassword123!");

      // Verify mem0.json contents and 0600 mode
      const mem0Content = await fs.readFile(prepared.mem0JsonPath!, "utf8");
      const parsedMem0 = JSON.parse(mem0Content);
      expect(parsedMem0.mode).toBe("oss");
      expect(parsedMem0.user_id).toBe("company");
      expect(parsedMem0.agent_id).toBe("agent-test-mem-1");
      expect(parsedMem0.oss.vector_store.config.password).toBe("SuperSecretPassword123!");
      expect(parsedMem0.oss.vector_store.config.host).toBe("postgres-tenant-node.internal");

      const mem0Stat = await fs.stat(prepared.mem0JsonPath!);
      expect(mem0Stat.mode & 0o777).toBe(0o600);

      // Verify config.yaml includes memory.provider: mem0 and NO mcp_servers
      const configYaml = await fs.readFile(prepared.configPath, "utf8");
      expect(configYaml).toContain("memory:\n  provider: mem0");
      expect(configYaml).not.toContain("mcp_servers:");

      // Verify .env mode 0600
      const envStat = await fs.stat(prepared.envPath);
      expect(envStat.mode & 0o777).toBe(0o600);
    });

    it("emits memory.provider only (no mem0.json) for memoryProvider without runtime memory", async () => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-mem-"));
      cleanupDirs.push(mockHost);

      const prepared = await prepareHermesMcpHome({
        servers: [],
        memoryProvider: "mem0",
        config: { env: { HERMES_HOME: mockHost } },
      });
      cleanupDirs.push(prepared.homeDir);

      expect(prepared.mem0JsonPath).toBeUndefined();
      await expect(fs.access(path.join(prepared.homeDir, "mem0.json"))).rejects.toMatchObject({ code: "ENOENT" });
      const configYaml = await fs.readFile(prepared.configPath, "utf8");
      expect(configYaml).toContain("memory:\n  provider: mem0\n");
      expect(configYaml).not.toContain("mcp_servers:");
    });

    it.each([false, true])("memoryProvider honors the hermesMemoryConfig hardening flag (%s)", async (hermesMemoryConfig) => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-mem-"));
      cleanupDirs.push(mockHost);
      const prepared = await prepareHermesMcpHome({
        servers: [],
        memoryProvider: "mem0",
        flags: { ...resolveMemoryHardeningFlags({}), hermesMemoryConfig },
        config: { env: { HERMES_HOME: mockHost } },
      });
      cleanupDirs.push(prepared.homeDir);
      const configYaml = await fs.readFile(prepared.configPath, "utf8");
      expect(configYaml).toContain("memory:\n  provider: mem0\n");
      expect(configYaml.includes("memory_enabled: false")).toBe(hermesMemoryConfig);
    });

    it("prepares isolated home with BOTH servers and memory", async () => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-mem-"));
      cleanupDirs.push(mockHost);

      const server: AdapterRuntimeMcpServer = {
        name: "test-gw",
        url: "https://gateway.example.com",
        token: "gw-token-xyz",
        connectionId: "conn-1",
        allowedTools: ["fetch_records"],
      };

      const prepared = await prepareHermesMcpHome({
        servers: [server],
        memory: validMemConfig,
        config: { env: { HERMES_HOME: mockHost } },
      });
      cleanupDirs.push(prepared.homeDir);

      expect(prepared.homeDir.startsWith(mockHost)).toBe(true);
      expect(prepared.serverCount).toBe(1);
      expect(prepared.hasMemory).toBe(true);

      const configYaml = await fs.readFile(prepared.configPath, "utf8");
      expect(configYaml).toContain("memory:\n  provider: mem0");
      expect(configYaml).toContain("mcp_servers:");
      expect(configYaml).toContain("test_gw:");

      const envContent = await fs.readFile(prepared.envPath, "utf8");
      expect(envContent).toContain("HERMES_MCP_TOKEN_TEST_GW=");
    });

    it("rejects preparing isolated home when neither servers nor memory is provided", async () => {
      await expect(
        prepareHermesMcpHome({
          servers: [],
        }),
      ).rejects.toThrow("Cannot prepare Hermes isolated home: no servers or memory provided");

      await expect(
        prepareHermesMcpHome({}),
      ).rejects.toThrow("Cannot prepare Hermes isolated home: no servers or memory provided");
    });

    it("prepares a Ramp Router profile without servers or memory only inside a run home, with no host model/provider", async () => {
      const mockHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mock-home-"));
      cleanupDirs.push(mockHome);
      await fs.mkdir(path.join(mockHome, ".hermes"), { recursive: true });
      await fs.writeFile(
        path.join(mockHome, ".hermes", "config.yaml"),
        "model:\n  default: m\n  base_url: https://gw.example/v1\n  api_key: host-model-key\n" +
          "provider: custom\n" +
          "temperature: 0.2\n",
      );

      await expect(
        prepareHermesMcpHome({ canonicalRouterEndpoint: true, config: { env: { HOME: mockHome } } }),
      ).rejects.toThrow("Cannot prepare a Ramp Router Hermes profile without a run home directory");

      const runHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-router-run-home-"));
      cleanupDirs.push(runHome);
      const prepared = await prepareHermesMcpHome({
        canonicalRouterEndpoint: true,
        config: { env: { HOME: mockHome } },
        tempDirPrefix: path.join(runHome, "hermes-"),
      });
      expect(prepared.homeDir.startsWith(runHome)).toBe(true);
      const written = YAML.parse(await fs.readFile(prepared.configPath, "utf8")) as {
        model?: Record<string, unknown>;
        provider?: unknown;
        temperature?: unknown;
      };
      expect(written.model).toBeUndefined();
      expect(written.provider).toBeUndefined();
      expect(written.temperature).toBe(0.2);
    });

    it("cleans up directory and fails if writing or chmodding mem0.json fails", async () => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-mem-"));
      cleanupDirs.push(mockHost);

      // 1. Test chmod failure on mem0.json
      const realChmod = fs.chmod;
      const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (filePath, mode) => {
        if (typeof filePath === "string" && filePath.endsWith("mem0.json")) {
          throw new Error("Simulated chmod EPERM on mem0.json");
        }
        return realChmod(filePath, mode);
      });

      try {
        await expect(
          prepareHermesMcpHome({
            servers: [],
            memory: validMemConfig,
            config: { env: { HERMES_HOME: mockHost } },
          }),
        ).rejects.toThrow("Simulated chmod EPERM on mem0.json");
      } finally {
        chmodSpy.mockRestore();
      }

      // Check profiles dir: no orphaned directories should exist
      const profilesDir = path.join(mockHost, "profiles");
      let entries = await fs.readdir(profilesDir).catch(() => []);
      expect(entries).toEqual([]);

      // 2. Test writeFile failure on mem0.json
      const realWriteFile = fs.writeFile;
      const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (filePath, data, options) => {
        if (typeof filePath === "string" && filePath.endsWith("mem0.json")) {
          throw new Error("Simulated writeFile ENOSPC on mem0.json");
        }
        return realWriteFile(filePath, data, options as any);
      });

      try {
        await expect(
          prepareHermesMcpHome({
            servers: [],
            memory: validMemConfig,
            config: { env: { HERMES_HOME: mockHost } },
          }),
        ).rejects.toThrow("Simulated writeFile ENOSPC on mem0.json");
      } finally {
        writeFileSpy.mockRestore();
      }

      entries = await fs.readdir(profilesDir).catch(() => []);
      expect(entries).toEqual([]);
    });

    it("serializeHermesMcpYaml handles combinations of hostYaml, memory, and mcpServers", () => {
      // Memory only
      const memOnly = serializeHermesMcpYaml({}, "", true);
      expect(memOnly).toBe("memory:\n  provider: mem0\n");

      // Inherited host + memory only
      const hostAndMem = serializeHermesMcpYaml({}, "model: gpt-5.4", true);
      expect(hostAndMem).toBe("model: gpt-5.4\n\nmemory:\n  provider: mem0\n");

      // Memory + MCP server
      const memAndMcp = serializeHermesMcpYaml(
        {
          my_server: {
            url: "https://mcp.test",
            headers: { Authorization: "Bearer ${TOKEN}" },
            enabled: true,
            skip_preflight: true,
            tools: { resources: false, prompts: false, include: ["t1"] },
          },
        },
        "",
        true,
      );
      expect(memAndMcp).toContain("memory:\n  provider: mem0");
      expect(memAndMcp).toContain("mcp_servers:");
      expect(memAndMcp).toContain("my_server:");
    });

    it("serializeHermesMcpYaml reflects memory hardening flag on vs off", () => {
      const origEnv = process.env.PAPERCLIP_MEMORY_HARDENING;
      try {
        // Flag off: byte-identical legacy output
        delete process.env.PAPERCLIP_MEMORY_HARDENING;
        const offOutput = serializeHermesMcpYaml({}, "model: gpt-5.4", true);
        expect(offOutput).toBe("model: gpt-5.4\n\nmemory:\n  provider: mem0\n");

        // Flag on: memory_enabled: false and user_profile_enabled: false
        process.env.PAPERCLIP_MEMORY_HARDENING = "hermes-memory-config";
        const onOutput = serializeHermesMcpYaml({}, "model: gpt-5.4", true);
        expect(onOutput).toBe(
          "model: gpt-5.4\n\nmemory:\n  provider: mem0\n  memory_enabled: false\n  user_profile_enabled: false\n",
        );
      } finally {
        if (origEnv !== undefined) {
          process.env.PAPERCLIP_MEMORY_HARDENING = origEnv;
        } else {
          delete process.env.PAPERCLIP_MEMORY_HARDENING;
        }
      }
    });

    it("serializeHermesMcpYaml gives explicit flags precedence over ambient process.env", () => {
      const origEnv = process.env.PAPERCLIP_MEMORY_HARDENING;
      try {
        // process.env enables hardening, but explicit flags argument disables it
        process.env.PAPERCLIP_MEMORY_HARDENING = "hermes-memory-config";
        const explicitOff = serializeHermesMcpYaml({}, "model: gpt-5.4", true, {
          hermesMemoryConfig: false,
          hermesPromptSplit: false,
          agentScopedMem0: false,
          capabilityMemoryGuidance: false,
          mem0AutoSyncOff: false,
        });
        expect(explicitOff).toBe("model: gpt-5.4\n\nmemory:\n  provider: mem0\n");

        // process.env has no hardening, but explicit flags argument enables it
        delete process.env.PAPERCLIP_MEMORY_HARDENING;
        const explicitOn = serializeHermesMcpYaml({}, "model: gpt-5.4", true, {
          hermesMemoryConfig: true,
          hermesPromptSplit: false,
          agentScopedMem0: false,
          capabilityMemoryGuidance: false,
          mem0AutoSyncOff: false,
        });
        expect(explicitOn).toBe(
          "model: gpt-5.4\n\nmemory:\n  provider: mem0\n  memory_enabled: false\n  user_profile_enabled: false\n",
        );
      } finally {
        if (origEnv !== undefined) {
          process.env.PAPERCLIP_MEMORY_HARDENING = origEnv;
        } else {
          delete process.env.PAPERCLIP_MEMORY_HARDENING;
        }
      }
    });

    it("prepareHermesMcpHome honors explicit options.flags over ambient env", async () => {
      const origEnv = process.env.PAPERCLIP_MEMORY_HARDENING;
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-flags-explicit-"));
      cleanupDirs.push(mockHost);
      try {
        process.env.PAPERCLIP_MEMORY_HARDENING = "hermes-memory-config";
        // Explicit options.flags: false overrides ambient process.env
        const prepared = await prepareHermesMcpHome({
          servers: [],
          memory: validMemConfig,
          config: { env: { HERMES_HOME: mockHost } },
          flags: {
            hermesMemoryConfig: false,
            hermesPromptSplit: false,
            agentScopedMem0: false,
            capabilityMemoryGuidance: false,
            mem0AutoSyncOff: false,
          },
        });
        cleanupDirs.push(prepared.homeDir);

        const configYaml = await fs.readFile(prepared.configPath, "utf8");
        expect(configYaml).toContain("memory:\n  provider: mem0\n");
        expect(configYaml).not.toContain("memory_enabled: false");

        const mem0Content = JSON.parse(await fs.readFile(prepared.mem0JsonPath!, "utf8"));
        expect(mem0Content.sync_max_chars).toBeUndefined();
      } finally {
        if (origEnv !== undefined) {
          process.env.PAPERCLIP_MEMORY_HARDENING = origEnv;
        } else {
          delete process.env.PAPERCLIP_MEMORY_HARDENING;
        }
      }
    });

    it("prepareHermesMcpHome falls back to config.env when options.flags is undefined", async () => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-flags-config-fallback-"));
      cleanupDirs.push(mockHost);

      const prepared = await prepareHermesMcpHome({
        servers: [],
        memory: validMemConfig,
        config: {
          env: {
            HERMES_HOME: mockHost,
            PAPERCLIP_MEMORY_HARDENING: "hermes-memory-config",
          },
        },
      });
      cleanupDirs.push(prepared.homeDir);

      const configYaml = await fs.readFile(prepared.configPath, "utf8");
      expect(configYaml).toContain("memory_enabled: false");
      expect(configYaml).toContain("user_profile_enabled: false");

      const mem0Content = JSON.parse(await fs.readFile(prepared.mem0JsonPath!, "utf8"));
      expect(mem0Content.sync_max_chars).toBe(6000);
      expect(mem0Content.auto_sync).toBeUndefined();
    });

    it("prepareHermesMcpHome emits auto_sync: false under mem0-auto-sync-off hardening", async () => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-flags-auto-sync-off-"));
      cleanupDirs.push(mockHost);

      const prepared = await prepareHermesMcpHome({
        servers: [],
        memory: validMemConfig,
        config: {
          env: {
            HERMES_HOME: mockHost,
            PAPERCLIP_MEMORY_HARDENING: "mem0-auto-sync-off,hermes-memory-config",
          },
        },
      });
      cleanupDirs.push(prepared.homeDir);

      const rawMem0 = await fs.readFile(prepared.mem0JsonPath!, "utf8");
      const parsedMem0 = JSON.parse(rawMem0);
      expect(parsedMem0.sync_max_chars).toBe(6000);
      expect(parsedMem0.auto_sync).toBe(false);

      // Verify key ordering: auto_sync immediately follows sync_max_chars
      const lines = rawMem0.split("\n");
      const syncMaxCharsIdx = lines.findIndex((l) => l.includes('"sync_max_chars":'));
      const autoSyncIdx = lines.findIndex((l) => l.includes('"auto_sync":'));
      expect(autoSyncIdx).toBe(syncMaxCharsIdx + 1);
    });

    it("prepareHermesMcpHome preserves legacy mem0.json without auto_sync when mem0-auto-sync-off is absent", async () => {
      const mockHost = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-flags-legacy-mem0-"));
      cleanupDirs.push(mockHost);

      const prepared = await prepareHermesMcpHome({
        servers: [],
        memory: validMemConfig,
        config: {
          env: {
            HERMES_HOME: mockHost,
            PAPERCLIP_MEMORY_HARDENING: "hermes-memory-config",
          },
        },
      });
      cleanupDirs.push(prepared.homeDir);

      const rawMem0 = await fs.readFile(prepared.mem0JsonPath!, "utf8");
      const parsedMem0 = JSON.parse(rawMem0);
      expect(parsedMem0.auto_sync).toBeUndefined();
      expect(rawMem0).not.toContain("auto_sync");
    });

    it("never emits disabled_toolsets in serialized YAML", () => {
      const output = serializeHermesMcpYaml(
        {
          my_server: {
            url: "https://mcp.test",
            headers: { Authorization: "Bearer ${TOKEN}" },
            enabled: true,
            skip_preflight: true,
            tools: { resources: false, prompts: false, include: ["t1"] },
          },
        },
        "model: gpt-5.4",
        true,
      );
      expect(output).not.toContain("disabled_toolsets");
    });
  });

  it("bridgeRelay mode points servers at relay routes and writes no MCP token", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-relay-"));
    cleanupDirs.push(root);
    const prepared = await prepareHermesMcpHome({
      servers: [{ name: "Gateway", url: "https://paperclip.example/mcp/gateways/g1", token: "tok-RELAY-SENTINEL", connectionId: "c1", allowedTools: ["t"] }],
      bridgeRelay: true,
      isolatedFromHost: true,
      tempDirPrefix: path.join(root, "hermes-"),
    });
    const config = await fs.readFile(prepared.configPath, "utf8");
    const dotenvText = await fs.readFile(prepared.envPath, "utf8");
    expect(config).toContain(`url: "\${PAPERCLIP_API_URL}${hermesMcpRelayPath(prepared.serverKeys[0]!)}"`);
    expect(config).toContain('Authorization: "Bearer ${PAPERCLIP_API_KEY}"');
    expect(`${config}${dotenvText}${JSON.stringify(prepared.env)}`).not.toContain("tok-RELAY-SENTINEL");
    expect(config).not.toContain("paperclip.example");
  });
});
