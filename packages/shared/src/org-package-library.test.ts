import { describe, expect, it } from "vitest";
import {
  buildOrgPackageInstallPreview,
  paperclipOrgPackageManifestSchema,
} from "./org-package-library.js";

describe("organization package library", () => {
  it("validates shareable org packages and produces approval-gated install previews", () => {
    const manifest = paperclipOrgPackageManifestSchema.parse({
      version: 1,
      key: "growth-agent-pack",
      name: "Growth Agent Pack",
      description: "Internal skills/prompts/MCP bundle for growth agents",
      provenance: {
        author: "Paperclip Ops",
        source: "internal",
        sourceRef: "main",
        trustLevel: "reviewed",
      },
      skills: [{ key: "growth-research", name: "Growth research", version: "1.0.0" }],
      prompts: [{ key: "growth-system", title: "Growth system prompt", body: "You are a careful growth analyst." }],
      mcpBundles: [
        {
          key: "analytics-readonly",
          servers: [{ catalogId: "io.github.example/analytics", permissionProfile: "read_only" }],
        },
      ],
      agentTemplates: [
        {
          key: "growth-analyst",
          title: "Growth Analyst",
          promptRef: "growth-system",
          skillRefs: ["growth-research"],
          mcpBundleRefs: ["analytics-readonly"],
        },
      ],
      permissionPolicies: [{ key: "analytics.read", gate: "none", reason: "Read-only analytics" }],
      requiredSecretInputs: [{ name: "ANALYTICS_TOKEN", scope: "mcp", required: true }],
    });

    const preview = buildOrgPackageInstallPreview(manifest, {
      existingPackageKeys: [],
      existingAgentTemplateKeys: [],
      existingSkillKeys: [],
    });

    expect(preview.action).toBe("create");
    expect(preview.requiresApproval).toBe(true);
    expect(preview.summary.skills).toBe(1);
    expect(preview.summary.prompts).toBe(1);
    expect(preview.summary.mcpBundles).toBe(1);
    expect(preview.summary.agentTemplates).toBe(1);
    expect(preview.secretInputs).toEqual([{ name: "ANALYTICS_TOKEN", scope: "mcp", required: true }]);
    expect(JSON.stringify(preview)).not.toContain("secret-value");
  });

  it("detects conflicts before applying package changes", () => {
    const manifest = paperclipOrgPackageManifestSchema.parse({
      version: 1,
      key: "reviewer-pack",
      name: "Reviewer Pack",
      provenance: { author: "Ops", source: "internal", trustLevel: "draft" },
      skills: [{ key: "code-review", name: "Code review" }],
      prompts: [],
      mcpBundles: [],
      agentTemplates: [{ key: "code-reviewer", title: "Code Reviewer" }],
      permissionPolicies: [],
      requiredSecretInputs: [],
    });

    const preview = buildOrgPackageInstallPreview(manifest, {
      existingPackageKeys: ["reviewer-pack"],
      existingAgentTemplateKeys: ["code-reviewer"],
      existingSkillKeys: ["code-review"],
    });

    expect(preview.action).toBe("update");
    expect(preview.conflicts).toContain("package reviewer-pack already exists");
    expect(preview.conflicts).toContain("agent template code-reviewer already exists");
    expect(preview.conflicts).toContain("skill code-review already exists");
    expect(preview.requiresApproval).toBe(true);
  });
});
