import { describe, expect, it } from "vitest";
import {
  agentCapabilityConfigSchema,
  buildAgentCapabilityAuditSummary,
  resolveAgentCapabilityConfigForCreate,
} from "./agent-capabilities.js";

describe("agent capability config schema", () => {
  it("normalizes desired MCP connections without marking them installed or connected", () => {
    const config = agentCapabilityConfigSchema.parse({
      mcpServers: [
        {
          id: "paperclip-local",
          provider: "manual",
          displayName: "Paperclip MCP",
          transport: "stdio",
          command: "npx -y @paperclipai/mcp-server",
          requiredSecretNames: ["PAPERCLIP_API_KEY"],
        },
      ],
      skillRefs: ["native-mcp"],
      toolRefs: ["paperclipApiRequest"],
    });

    expect(config.version).toBe(1);
    expect(config.mcpServers[0]).toMatchObject({
      id: "paperclip-local",
      desiredState: "enabled",
      liveState: "not_installed",
      requiredSecretNames: ["PAPERCLIP_API_KEY"],
    });
    expect(config.liveApply).toBe(false);
    expect(config.liveExternalActions).toBe(false);
  });

  it("rejects caller claims that desired config is already live-connected", () => {
    for (const liveState of ["approval_required", "installed", "connected", "failed"] as const) {
      expect(() =>
        agentCapabilityConfigSchema.parse({
          mcpServers: [
            {
              id: `github-${liveState}`,
              provider: "manual",
              displayName: "GitHub MCP",
              transport: "stdio",
              command: "github-mcp-server",
              liveState,
            },
          ],
        }),
      ).toThrow(/liveState/i);
    }
  });

  it("rejects desired configs that request live apply or external actions", () => {
    expect(() =>
      agentCapabilityConfigSchema.parse({
        mcpServers: [],
        liveApply: true,
      }),
    ).toThrow(/Invalid literal value/);
    expect(() =>
      agentCapabilityConfigSchema.parse({
        mcpServers: [],
        liveExternalActions: true,
      }),
    ).toThrow(/Invalid literal value/);
  });

  it("rejects raw secret values while allowing named secret requirements", () => {
    expect(() =>
      agentCapabilityConfigSchema.parse({
        mcpServers: [
          {
            id: "unsafe",
            provider: "manual",
            displayName: "Unsafe MCP",
            transport: "stdio",
            command: "unsafe --api-key sk_live_should_not_be_here",
            requiredSecretNames: ["SAFE_SECRET_NAME"],
          },
        ],
      }),
    ).toThrow(/secret/i);
    const fakeGithubToken = ["ghp", "not-a-real-test-token-1234567890"].join("_");
    expect(() =>
      agentCapabilityConfigSchema.parse({
        mcpServers: [
          {
            id: "unsafe-name",
            provider: "manual",
            displayName: `GitHub ${fakeGithubToken}`,
            transport: "stdio",
            command: "safe-mcp-server",
          },
        ],
      }),
    ).toThrow(/secret/i);
  });

  // LET-321 reviewer fix: requiredSecretNames previously only enforced the
  // env-style identifier regex, so an uppercase credential shape (e.g. an
  // AWS access key id like AKIA<16 upper/digits>) could pass as a "name".
  // The schema must also run the raw-secret detector against each entry.
  it("rejects credential-shaped values smuggled into requiredSecretNames", () => {
    const awsKeyShape = `${"AK" + "IA"}1234567890ABCDEF`;
    expect(() =>
      agentCapabilityConfigSchema.parse({
        mcpServers: [
          {
            id: "secret-name-leak",
            provider: "manual",
            displayName: "Looks fine",
            transport: "stdio",
            command: "npx safe",
            requiredSecretNames: [awsKeyShape],
          },
        ],
      }),
    ).toThrow(/secret/i);

    // Sanity check: a real env-style name with no credential shape still parses.
    expect(() =>
      agentCapabilityConfigSchema.parse({
        mcpServers: [
          {
            id: "safe-secret-name",
            provider: "manual",
            displayName: "Looks fine",
            transport: "stdio",
            command: "npx safe",
            requiredSecretNames: ["SAFE_ENV_NAME"],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("builds audit summaries without commands, urls, or secret values", () => {
    const config = agentCapabilityConfigSchema.parse({
      mcpServers: [
        {
          id: "paperclip-local",
          provider: "manual",
          displayName: "Paperclip MCP",
          transport: "stdio",
          command: "npx -y @paperclipai/mcp-server",
          requiredSecretNames: ["PAPERCLIP_API_KEY"],
        },
      ],
      skillRefs: ["native-mcp"],
      toolRefs: ["paperclipApiRequest"],
    });

    expect(buildAgentCapabilityAuditSummary(config)).toEqual({
      version: 1,
      mcpServerCount: 1,
      mcpServerIds: ["paperclip-local"],
      requiredSecretNames: ["PAPERCLIP_API_KEY"],
      skillRefCount: 1,
      toolRefCount: 1,
      liveApply: false,
      liveExternalActions: false,
    });
  });

  it("lets newly-created agents inherit company desired capability defaults unless explicit local config is supplied", () => {
    const companyDefaults = agentCapabilityConfigSchema.parse({
      mcpServers: [
        {
          id: "paperclip-local",
          provider: "manual",
          displayName: "Paperclip MCP",
          transport: "stdio",
          command: "npx -y @paperclipai/mcp-server",
          requiredSecretNames: ["PAPERCLIP_API_KEY"],
        },
      ],
      skillRefs: ["native-mcp"],
    });

    expect(resolveAgentCapabilityConfigForCreate(undefined, companyDefaults)).toMatchObject({
      mcpServers: [expect.objectContaining({ id: "paperclip-local", liveState: "not_installed" })],
      skillRefs: ["native-mcp"],
      liveApply: false,
      liveExternalActions: false,
    });
    expect(
      resolveAgentCapabilityConfigForCreate({ toolRefs: ["customTool"] }, companyDefaults),
    ).toMatchObject({
      mcpServers: [],
      skillRefs: [],
      toolRefs: ["customTool"],
    });
  });
});
