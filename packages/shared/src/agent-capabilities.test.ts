import { describe, expect, it } from "vitest";
import {
  agentCapabilityApplyPreviewRequestSchema,
  agentCapabilityConfigSchema,
  buildAgentCapabilityApplyPreviewProposal,
  buildAgentCapabilityAuditSummary,
  resolveAgentCapabilityConfigForCreate,
  type AgentCapabilityApplyPreviewProposal,
  type AgentCapabilityConfig,
  type AgentCapabilityConfigInput,
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

  // LET-342 / LET-343: ref/id fields are echoed back through Apply Preview
  // change rows, expectedEffects copy, and proposalIdentity hash inputs.
  // The capability-ref regex previously permitted credential shapes (sk_live_…,
  // ghp_…, AKIA…, AIza…, JWTs) to pass as "stable keys". The schema must run
  // the raw-secret detector against each user-controlled ref/id field so
  // secret-shaped values fail validation before proposal generation.
  describe("rejects credential-shaped values in user-controlled ref/id fields", () => {
    const fakeAwsKey = `${"AK" + "IA"}1234567890ABCDEF`;
    const fakeGithubToken = ["ghp", "fake0000000000000000fake1234"].join("_");
    const fakeStripeKey = ["sk", "live", "fake0000000000000000fake1234"].join("_");

    it("rejects secret-shaped MCP server id", () => {
      expect(() =>
        agentCapabilityConfigSchema.parse({
          mcpServers: [
            {
              id: fakeStripeKey,
              provider: "manual",
              displayName: "Safe",
              transport: "stdio",
              command: "npx safe",
            },
          ],
        }),
      ).toThrow(/secret/i);
    });

    it("rejects secret-shaped catalogId", () => {
      expect(() =>
        agentCapabilityConfigSchema.parse({
          mcpServers: [
            {
              id: "safe-id",
              provider: "manual",
              catalogId: fakeAwsKey,
              displayName: "Safe",
              transport: "stdio",
              command: "npx safe",
            },
          ],
        }),
      ).toThrow(/secret/i);
    });

    it("rejects secret-shaped skillRefs", () => {
      expect(() =>
        agentCapabilityConfigSchema.parse({
          skillRefs: [fakeGithubToken],
        }),
      ).toThrow(/secret/i);
    });

    it("rejects secret-shaped toolRefs", () => {
      expect(() =>
        agentCapabilityConfigSchema.parse({
          toolRefs: [fakeAwsKey],
        }),
      ).toThrow(/secret/i);
    });

    it("rejects secret-shaped draftConfig fields through the apply-preview request schema before proposal generation", () => {
      expect(() =>
        agentCapabilityApplyPreviewRequestSchema.parse({
          draftConfig: {
            mcpServers: [
              {
                id: fakeStripeKey,
                provider: "manual",
                displayName: "Safe",
                transport: "stdio",
                command: "npx safe",
              },
            ],
          },
        }),
      ).toThrow(/secret/i);
      expect(() =>
        agentCapabilityApplyPreviewRequestSchema.parse({
          draftConfig: {
            mcpServers: [],
            skillRefs: [fakeGithubToken],
          },
        }),
      ).toThrow(/secret/i);
      expect(() =>
        agentCapabilityApplyPreviewRequestSchema.parse({
          draftConfig: {
            mcpServers: [],
            toolRefs: [fakeAwsKey],
          },
        }),
      ).toThrow(/secret/i);
    });

    it("still accepts well-formed ids, catalogIds, and refs", () => {
      expect(() =>
        agentCapabilityConfigSchema.parse({
          mcpServers: [
            {
              id: "paperclip-local",
              provider: "manual",
              catalogId: "anthropic/paperclip-local@1",
              displayName: "Paperclip MCP",
              transport: "stdio",
              command: "npx -y @paperclipai/mcp-server",
              requiredSecretNames: ["PAPERCLIP_API_KEY"],
            },
          ],
          skillRefs: ["native-mcp", "research.web"],
          toolRefs: ["paperclipApiRequest"],
        }),
      ).not.toThrow();
    });
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

  // LET-336: dry-run Apply Preview proposal builder must be deterministic, sanitized,
  // and never represent live apply/install/connect/execute.
  describe("buildAgentCapabilityApplyPreviewProposal (LET-140-F)", () => {
    function cfg(overrides: Partial<AgentCapabilityConfigInput> = {}): AgentCapabilityConfig {
      return agentCapabilityConfigSchema.parse({
        version: 1,
        mcpServers: [],
        skillRefs: [],
        toolRefs: [],
        liveApply: false,
        liveExternalActions: false,
        ...overrides,
      });
    }

    function strip(proposal: AgentCapabilityApplyPreviewProposal) {
      return { ...proposal, generatedAt: "FROZEN" };
    }

    it("returns a no-op proposal when current and draft are equal", () => {
      const config = cfg({
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

      const proposal = buildAgentCapabilityApplyPreviewProposal({
        scope: "agent_local",
        companyId: "company-1",
        agentId: "agent-1",
        currentConfig: config,
        draftConfig: config,
        availableSecretNames: ["PAPERCLIP_API_KEY"],
      });

      expect(proposal.dryRun).toBe(true);
      expect(proposal.liveActionPerformed).toBe(false);
      expect(proposal.liveApply).toBe(false);
      expect(proposal.liveExternalActions).toBe(false);
      expect(proposal.status).toBe("no_op");
      expect(proposal.approvalRequiredForLiveApply).toBe(false);
      expect(proposal.totals).toEqual({ additions: 0, removals: 0, updates: 0 });
      expect(proposal.copy.dryRunNote).toMatch(/dry-run/i);
      expect(proposal.copy.dryRunNote).toMatch(/no live (?:mcp|action)/i);
    });

    it("classifies additions, removals, and updates with risk and changed fields", () => {
      const current = cfg({
        mcpServers: [
          {
            id: "paperclip-local",
            provider: "manual",
            displayName: "Paperclip MCP",
            transport: "stdio",
            command: "npx -y @paperclipai/mcp-server",
            requiredSecretNames: ["PAPERCLIP_API_KEY"],
          },
          {
            id: "to-remove",
            provider: "manual",
            displayName: "Old MCP",
            transport: "stdio",
            command: "npx -y old",
          },
        ],
        skillRefs: ["native-mcp"],
        toolRefs: ["paperclipApiRequest"],
      });
      const draft = cfg({
        mcpServers: [
          {
            id: "paperclip-local",
            provider: "manual",
            displayName: "Paperclip MCP (updated)",
            transport: "stdio",
            command: "npx -y @paperclipai/mcp-server --new",
            requiredSecretNames: ["PAPERCLIP_API_KEY"],
          },
          {
            id: "new-remote",
            provider: "manual",
            displayName: "Remote MCP",
            transport: "streamable_http",
            remoteUrl: "https://mcp.example.com/sse",
            requiredSecretNames: ["REMOTE_TOKEN_NAME"],
          },
        ],
        skillRefs: ["native-mcp", "new-skill"],
        toolRefs: [],
      });

      const proposal = buildAgentCapabilityApplyPreviewProposal({
        scope: "agent_local",
        companyId: "company-1",
        agentId: "agent-1",
        currentConfig: current,
        draftConfig: draft,
        availableSecretNames: ["PAPERCLIP_API_KEY"],
      });

      expect(proposal.status).toBe("changes_pending_approval");
      expect(proposal.approvalRequiredForLiveApply).toBe(true);
      expect(proposal.mcpServers.additions.map((r) => r.id)).toEqual(["new-remote"]);
      expect(proposal.mcpServers.removals.map((r) => r.id)).toEqual(["to-remove"]);
      expect(proposal.mcpServers.updates.map((r) => r.id)).toEqual(["paperclip-local"]);
      expect(proposal.mcpServers.updates[0]!.changedFields).toEqual(
        expect.arrayContaining(["command", "displayName"]),
      );
      expect(proposal.mcpServers.additions[0]!.riskClass).toBe("high");
      expect(proposal.mcpServers.additions[0]!.missingSecretNames).toEqual(["REMOTE_TOKEN_NAME"]);
      expect(proposal.mcpServers.removals[0]!.riskClass).toBe("low");
      expect(proposal.skillRefs.additions.map((r) => r.ref)).toEqual(["new-skill"]);
      expect(proposal.toolRefs.removals.map((r) => r.ref)).toEqual(["paperclipApiRequest"]);
      expect(proposal.missingSecretNames).toEqual(["REMOTE_TOKEN_NAME"]);
      expect(proposal.totals).toEqual({ additions: 2, removals: 2, updates: 1 });
      expect(proposal.riskSummary.highRiskCount).toBeGreaterThanOrEqual(2);
      expect(proposal.expectedEffects.join(" ")).toMatch(/approval-gated/);
    });

    it("produces a deterministic proposalIdentity for the same input regardless of when it runs", () => {
      const current = cfg();
      const draft = cfg({
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

      const a = buildAgentCapabilityApplyPreviewProposal({
        scope: "agent_local",
        companyId: "company-1",
        agentId: "agent-1",
        currentConfig: current,
        draftConfig: draft,
        availableSecretNames: ["PAPERCLIP_API_KEY"],
      });
      const b = buildAgentCapabilityApplyPreviewProposal({
        scope: "agent_local",
        companyId: "company-1",
        agentId: "agent-1",
        currentConfig: current,
        draftConfig: draft,
        availableSecretNames: ["PAPERCLIP_API_KEY"],
      });

      expect(a.proposalIdentity).toBe(b.proposalIdentity);
      expect(a.proposalIdentity).toMatch(/^acp1:[0-9a-f]{16}$/);
      expect(strip(a)).toEqual(strip(b));

      const c = buildAgentCapabilityApplyPreviewProposal({
        scope: "agent_local",
        companyId: "company-1",
        agentId: "agent-2",
        currentConfig: current,
        draftConfig: draft,
        availableSecretNames: ["PAPERCLIP_API_KEY"],
      });
      expect(c.proposalIdentity).not.toBe(a.proposalIdentity);
    });

    it("never echoes raw command, remoteUrl, or secret values in the proposal payload", () => {
      const current = cfg();
      const draft = cfg({
        mcpServers: [
          {
            id: "paperclip-local",
            provider: "manual",
            displayName: "Paperclip MCP",
            transport: "stdio",
            command: "npx -y @paperclipai/mcp-server --token-flag",
            requiredSecretNames: ["PAPERCLIP_API_KEY"],
          },
          {
            id: "remote",
            provider: "manual",
            displayName: "Remote MCP",
            transport: "sse",
            remoteUrl: "https://internal.example.com/mcp",
          },
        ],
      });

      const proposal = buildAgentCapabilityApplyPreviewProposal({
        scope: "agent_local",
        companyId: "company-1",
        agentId: "agent-1",
        currentConfig: current,
        draftConfig: draft,
        availableSecretNames: [],
      });

      const serialized = JSON.stringify(proposal);
      expect(serialized).not.toContain("npx -y @paperclipai/mcp-server --token-flag");
      expect(serialized).not.toContain("https://internal.example.com/mcp");
      // Status-only secret posture: the named secret reference is present but
      // never a raw value.
      expect(serialized).toContain("PAPERCLIP_API_KEY");
      expect(proposal.mcpServers.additions[0]!.missingSecretNames).toContain("PAPERCLIP_API_KEY");
    });

    it("includes inherited-context guidance for agent_local scope and omits it for company_default", () => {
      const current = cfg();
      const draft = cfg();

      const agentLocal = buildAgentCapabilityApplyPreviewProposal({
        scope: "agent_local",
        companyId: "company-1",
        agentId: "agent-1",
        currentConfig: current,
        draftConfig: draft,
        globalDefaultsAvailable: true,
      });
      expect(agentLocal.inheritedContext).toMatchObject({
        globalDefaultsAvailable: true,
      });

      const companyDefault = buildAgentCapabilityApplyPreviewProposal({
        scope: "company_default",
        companyId: "company-1",
        agentId: null,
        currentConfig: current,
        draftConfig: draft,
      });
      expect(companyDefault.inheritedContext).toBeNull();
    });

    it("agentCapabilityApplyPreviewRequestSchema rejects raw secret values in draftConfig", () => {
      expect(() =>
        agentCapabilityApplyPreviewRequestSchema.parse({
          draftConfig: {
            mcpServers: [
              {
                id: "leak",
                provider: "manual",
                displayName: "Leak",
                transport: "stdio",
                command: "leak --api-key sk_live_should_not_be_here",
              },
            ],
          },
        }),
      ).toThrow(/secret/i);
    });

    it("rejects unknown fields on the request body", () => {
      expect(() =>
        agentCapabilityApplyPreviewRequestSchema.parse({
          draftConfig: { mcpServers: [] },
          unexpectedField: true,
        } as unknown),
      ).toThrow();
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
