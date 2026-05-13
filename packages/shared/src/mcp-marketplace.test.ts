import { describe, expect, it } from "vitest";
import {
  buildMcpInstallPreview,
  mcpCatalogEntrySchema,
  normalizeMcpCatalogEntry,
} from "./mcp-marketplace.js";

describe("MCP marketplace connector", () => {
  it("normalizes catalog entries from external registries and redacts install inputs", () => {
    const entry = normalizeMcpCatalogEntry(
      mcpCatalogEntrySchema.parse({
        provider: "official_registry",
        id: "io.github.example/github-mcp",
        name: "github-mcp",
        title: "GitHub MCP",
        description: "Repository automation tools",
        version: "1.2.3",
        transport: "streamable_http",
        remoteUrl: "https://mcp.example.test/github",
        sourceUrl: "https://github.com/example/github-mcp",
        license: "MIT",
        requiredEnv: [
          { name: "GITHUB_TOKEN", required: true, description: "GitHub token" },
          { name: "OPTIONAL_PROJECT", required: false },
        ],
        tools: [
          { name: "github.create_issue", description: "Create an issue" },
          { name: "paperclipListIssues", description: "Read Paperclip issues" },
        ],
        trust: {
          verifiedPublisher: true,
          sourceAvailable: true,
          containerized: false,
        },
      }),
    );

    expect(entry.provider).toBe("official_registry");
    expect(entry.requiredSecretNames).toEqual(["GITHUB_TOKEN"]);
    expect(entry.requiredOptionalEnvNames).toEqual(["OPTIONAL_PROJECT"]);

    const preview = buildMcpInstallPreview(entry);
    expect(preview.action).toBe("blocked_pending_approval");
    expect(preview.requiresApproval).toBe(true);
    expect(preview.envTemplate.GITHUB_TOKEN).toBe("[REQUIRED_SECRET:GITHUB_TOKEN]");
    expect(JSON.stringify(preview)).not.toContain("ghp_");
    expect(preview.toolPolicies.some((policy) => policy.toolName === "github.create_issue" && policy.requiresExplicitApproval)).toBe(true);
    expect(preview.toolPolicies.some((policy) => policy.toolName === "paperclipListIssues" && !policy.requiresExplicitApproval)).toBe(true);
  });

  it("defaults unknown or untrusted marketplace entries to blocked previews", () => {
    const entry = normalizeMcpCatalogEntry({
      provider: "manual",
      id: "custom-shell",
      name: "custom-shell",
      description: "Unknown shell tools",
      transport: "stdio",
      command: "npx custom-shell-mcp",
      tools: [{ name: "shell.exec" }],
      trust: { verifiedPublisher: false, sourceAvailable: false, containerized: false },
    });

    const preview = buildMcpInstallPreview(entry);
    expect(preview.action).toBe("blocked_pending_approval");
    expect(preview.blockers).toContain("publisher is not verified");
    expect(preview.blockers).toContain("source is not available");
  });
});
