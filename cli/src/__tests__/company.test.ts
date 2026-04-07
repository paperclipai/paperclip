import { describe, expect, it } from "vitest";
import type { CompanyPortabilityPreviewResult } from "@paperclipai/shared";
import {
  buildCompanyDashboardUrl,
  buildDefaultImportAdapterOverrides,
  buildDefaultImportSelectionState,
  buildImportSelectionCatalog,
  buildSelectedFilesFromImportSelection,
  renderCompanyImportPreview,
  renderCompanyImportResult,
  resolveCompanyImportApplyConfirmationMode,
  resolveCompanyImportApiPath,
} from "../commands/client/company.js";

describe("resolveCompanyImportApiPath", () => {
  it("uses company-scoped preview route for existing-company dry runs", () => {
    expect(
      resolveCompanyImportApiPath({
        dryRun: true,
        targetMode: "existing_company",
        companyId: "company-123",
      }),
    ).toBe("/api/companies/company-123/imports/preview");
  });

  it("uses company-scoped apply route for existing-company imports", () => {
    expect(
      resolveCompanyImportApiPath({
        dryRun: false,
        targetMode: "existing_company",
        companyId: "company-123",
      }),
    ).toBe("/api/companies/company-123/imports/apply");
  });

  it("keeps global routes for new-company imports", () => {
    expect(
      resolveCompanyImportApiPath({
        dryRun: true,
        targetMode: "new_company",
      }),
    ).toBe("/api/companies/import/preview");

    expect(
      resolveCompanyImportApiPath({
        dryRun: false,
        targetMode: "new_company",
      }),
    ).toBe("/api/companies/import");
  });

  it("throws when an existing-company import is missing a company id", () => {
    expect(() =>
      resolveCompanyImportApiPath({
        dryRun: true,
        targetMode: "existing_company",
        companyId: " ",
      })
    ).toThrow(/require a companyId/i);
  });
});

describe("resolveCompanyImportApplyConfirmationMode", () => {
  it("skips confirmation when --yes is set", () => {
    expect(
      resolveCompanyImportApplyConfirmationMode({
        yes: true,
        interactive: false,
        json: false,
      }),
    ).toBe("skip");
  });

  it("prompts in interactive text mode when --yes is not set", () => {
    expect(
      resolveCompanyImportApplyConfirmationMode({
        yes: false,
        interactive: true,
        json: false,
      }),
    ).toBe("prompt");
  });

  it("requires --yes for non-interactive apply", () => {
    expect(() =>
      resolveCompanyImportApplyConfirmationMode({
        yes: false,
        interactive: false,
        json: false,
      })
    ).toThrow(/non-interactive terminal requires --yes/i);
  });

  it("requires --yes for json apply", () => {
    expect(() =>
      resolveCompanyImportApplyConfirmationMode({
        yes: false,
        interactive: false,
        json: true,
      })
    ).toThrow(/with --json requires --yes/i);
  });
});

describe("buildCompanyDashboardUrl", () => {
  it("preserves the configured base path when building a dashboard URL", () => {
    expect(buildCompanyDashboardUrl("https://paperclip.example/app/", "PAP")).toBe(
      "https://paperclip.example/app/PAP/dashboard",
    );
  });
});

describe("renderCompanyImportPreview", () => {
  it("summarizes the preview with counts, selection info, and truncated examples", () => {
    const preview: CompanyPortabilityPreviewResult = {
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: true,
      },
      targetCompanyId: "company-123",
      targetCompanyName: "Imported Co",
      collisionStrategy: "rename",
      selectedAgentSlugs: ["ceo", "cto", "eng-1", "eng-2", "eng-3", "eng-4", "eng-5"],
      plan: {
        companyAction: "update",
        agentPlans: [
          { slug: "ceo", action: "create", plannedName: "CEO", existingAgentId: null, reason: null },
          { slug: "cto", action: "update", plannedName: "CTO", existingAgentId: "agent-2", reason: "replace strategy" },
          { slug: "eng-1", action: "skip", plannedName: "Engineer 1", existingAgentId: "agent-3", reason: "skip strategy" },
          { slug: "eng-2", action: "create", plannedName: "Engineer 2", existingAgentId: null, reason: null },
          { slug: "eng-3", action: "create", plannedName: "Engineer 3", existingAgentId: null, reason: null },
          { slug: "eng-4", action: "create", plannedName: "Engineer 4", existingAgentId: null, reason: null },
          { slug: "eng-5", action: "create", plannedName: "Engineer 5", existingAgentId: null, reason: null },
        ],
        projectPlans: [
          { slug: "alpha", action: "create", plannedName: "Alpha", existingProjectId: null, reason: null },
        ],
        issuePlans: [
          { slug: "kickoff", action: "create", plannedTitle: "Kickoff", reason: null },
        ],
      },
      manifest: {
        schemaVersion: 1,
        generatedAt: "2026-03-23T17:00:00.000Z",
        source: {
          companyId: "company-src",
          companyName: "Source Co",
        },
        includes: {
          company: true,
          agents: true,
          projects: true,
          issues: true,
          skills: true,
        },
        company: {
          path: "COMPANY.md",
          name: "Source Co",
          description: null,
          brandColor: null,
          logoPath: null,
          requireBoardApprovalForNewAgents: false,
          feedbackDataSharingEnabled: false,
          feedbackDataSharingConsentAt: null,
          feedbackDataSharingConsentByUserId: null,
          feedbackDataSharingTermsVersion: null,
        },
        sidebar: {
          agents: ["ceo"],
          projects: ["alpha"],
        },
        agents: [
          {
            slug: "ceo",
            name: "CEO",
            path: "agents/ceo/AGENT.md",
            skills: [],
            role: "ceo",
            title: null,
            icon: null,
            capabilities: null,
            reportsToSlug: null,
            adapterType: "codex_local",
            adapterConfig: {},
            runtimeConfig: {},
            permissions: {},
            budgetMonthlyCents: 0,
            metadata: null,
          },
        ],
        skills: [
          {
            key: "skill-a",
            slug: "skill-a",
            name: "Skill A",
            path: "skills/skill-a/SKILL.md",
            description: null,
            sourceType: "inline",
            sourceLocator: null,
            sourceRef: null,
            trustLevel: null,
            compatibility: null,
            metadata: null,
            fileInventory: [],
          },
        ],
        projects: [
          {
            slug: "alpha",
            name: "Alpha",
            path: "projects/alpha/PROJECT.md",
            description: null,
            ownerAgentSlug: null,
            leadAgentSlug: null,
            targetDate: null,
            color: null,
            status: null,
            executionWorkspacePolicy: null,
            workspaces: [],
            env: null,
            metadata: null,
          },
        ],
        issues: [
          {
            slug: "kickoff",
            identifier: null,
            title: "Kickoff",
            path: "projects/alpha/issues/kickoff/TASK.md",
            projectSlug: "alpha",
            projectWorkspaceKey: null,
            assigneeAgentSlug: "ceo",
            description: null,
            recurring: false,
            routine: null,
            legacyRecurrence: null,
            status: null,
            priority: null,
            labelIds: [],
            billingCode: null,
            executionWorkspaceSettings: null,
            assigneeAdapterOverrides: null,
            metadata: null,
          },
        ],
        envInputs: [
          {
            key: "OPENAI_API_KEY",
            description: null,
            agentSlug: "ceo",
            projectSlug: null,
            kind: "secret",
            requirement: "required",
            defaultValue: null,
            portability: "portable",
          },
        ],
      },
      files: {
        "COMPANY.md": "# Source Co",
      },
      envInputs: [
        {
          key: "OPENAI_API_KEY",
          description: null,
          agentSlug: "ceo",
          projectSlug: null,
          kind: "secret",
          requirement: "required",
          defaultValue: null,
          portability: "portable",
        },
      ],
      warnings: ["One warning"],
      errors: ["One error"],
    };

    const rendered = renderCompanyImportPreview(preview, {
      sourceLabel: "GitHub: https://github.com/paperclipai/companies/demo",
      targetLabel: "Imported Co (company-123)",
      infoMessages: ["Using claude-local adapter"],
    });

    expect(rendered).toContain("Include");
    expect(rendered).toContain("company, projects, tasks, agents, skills");
    expect(rendered).toContain("7 agents total");
    expect(rendered).toContain("1 project total");
    expect(rendered).toContain("1 task total");
    expect(rendered).toContain("skills: 1 skill packaged");
    expect(rendered).toContain("+1 more");
    expect(rendered).toContain("Using claude-local adapter");
    expect(rendered).toContain("Warnings");
    expect(rendered).toContain("Errors");
  });
});

describe("renderCompanyImportResult", () => {
  it("summarizes import results with created, updated, and skipped counts", () => {
    const rendered = renderCompanyImportResult(
      {
        company: {
          id: "company-123",
          name: "Imported Co",
          action: "updated",
        },
        agents: [
          { slug: "ceo", id: "agent-1", action: "created", name: "CEO", reason: null },
          { slug: "cto", id: "agent-2", action: "updated", name: "CTO", reason: "replace strategy" },
          { slug: "ops", id: null, action: "skipped", name: "Ops", reason: "skip strategy" },
        ],
        projects: [
          { slug: "app", id: "project-1", action: "created", name: "App", reason: null },
          { slug: "ops", id: "project-2", action: "updated", name: "Operations", reason: "replace strategy" },
          { slug: "archive", id: null, action: "skipped", name: "Archive", reason: "skip strategy" },
        ],
        envInputs: [],
        warnings: ["Review API keys"],
      },
      {
        targetLabel: "Imported Co (company-123)",
        companyUrl: "https://paperclip.example/PAP/dashboard",
        infoMessages: ["Using claude-local adapter"],
      },
    );

    expect(rendered).toContain("Company");
    expect(rendered).toContain("https://paperclip.example/PAP/dashboard");
    expect(rendered).toContain("3 agents total (1 created, 1 updated, 1 skipped)");
    expect(rendered).toContain("3 projects total (1 created, 1 updated, 1 skipped)");
    expect(rendered).toContain("Agent results");
    expect(rendered).toContain("Project results");
    expect(rendered).toContain("Using claude-local adapter");
    expect(rendered).toContain("Review API keys");
  });
});

describe("import selection catalog", () => {
  it("defaults to everything and keeps project selection separate from task selection", () => {
    const preview: CompanyPortabilityPreviewResult = {
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: true,
      },
      targetCompanyId: "company-123",
      targetCompanyName: "Imported Co",
      collisionStrategy: "rename",
      selectedAgentSlugs: ["ceo"],
      plan: {
        companyAction: "create",
        agentPlans: [],
        projectPlans: [],
        issuePlans: [],
      },
      manifest: {
        schemaVersion: 1,
        generatedAt: "2026-03-23T18:00:00.000Z",
        source: {
          companyId: "company-src",
          companyName: "Source Co",
        },
        includes: {
          company: true,
          agents: true,
          projects: true,
          issues: true,
          skills: true,
        },
        company: {
          path: "COMPANY.md",
          name: "Source Co",
          description: null,
          brandColor: null,
          logoPath: "images/company-logo.png",
          requireBoardApprovalForNewAgents: false,
          feedbackDataSharingEnabled: false,
          feedbackDataSharingConsentAt: null,
          feedbackDataSharingConsentByUserId: null,
          feedbackDataSharingTermsVersion: null,
        },
        sidebar: {
          agents: ["ceo"],
          projects: ["alpha"],
        },
        agents: [
          {
            slug: "ceo",
            name: "CEO",
            path: "agents/ceo/AGENT.md",
            skills: [],
            role: "ceo",
            title: null,
            icon: null,
            capabilities: null,
            reportsToSlug: null,
            adapterType: "codex_local",
            adapterConfig: {},
            runtimeConfig: {},
            permissions: {},
            budgetMonthlyCents: 0,
            metadata: null,
          },
        ],
        skills: [
          {
            key: "skill-a",
            slug: "skill-a",
            name: "Skill A",
            path: "skills/skill-a/SKILL.md",
            description: null,
            sourceType: "inline",
            sourceLocator: null,
            sourceRef: null,
            trustLevel: null,
            compatibility: null,
            metadata: null,
            fileInventory: [{ path: "skills/skill-a/helper.md", kind: "doc" }],
          },
        ],
        projects: [
          {
            slug: "alpha",
            name: "Alpha",
            path: "projects/alpha/PROJECT.md",
            description: null,
            ownerAgentSlug: null,
            leadAgentSlug: null,
            targetDate: null,
            color: null,
            status: null,
            executionWorkspacePolicy: null,
            workspaces: [],
            env: null,
            metadata: null,
          },
        ],
        issues: [
          {
            slug: "kickoff",
            identifier: null,
            title: "Kickoff",
            path: "projects/alpha/issues/kickoff/TASK.md",
            projectSlug: "alpha",
            projectWorkspaceKey: null,
            assigneeAgentSlug: "ceo",
            description: null,
            recurring: false,
            routine: null,
            legacyRecurrence: null,
            status: null,
            priority: null,
            labelIds: [],
            billingCode: null,
            executionWorkspaceSettings: null,
            assigneeAdapterOverrides: null,
            metadata: null,
          },
        ],
        envInputs: [],
      },
      files: {
        "COMPANY.md": "# Source Co",
        "README.md": "# Readme",
        ".paperclip.yaml": "schema: paperclip/v1\n",
        "images/company-logo.png": {
          encoding: "base64",
          data: "",
          contentType: "image/png",
        },
        "projects/alpha/PROJECT.md": "# Alpha",
        "projects/alpha/notes.md": "project notes",
        "projects/alpha/issues/kickoff/TASK.md": "# Kickoff",
        "projects/alpha/issues/kickoff/details.md": "task details",
        "agents/ceo/AGENT.md": "# CEO",
        "agents/ceo/prompt.md": "prompt",
        "skills/skill-a/SKILL.md": "# Skill A",
        "skills/skill-a/helper.md": "helper",
      },
      envInputs: [],
      warnings: [],
      errors: [],
    };

    const catalog = buildImportSelectionCatalog(preview);
    const state = buildDefaultImportSelectionState(catalog);

    expect(state.company).toBe(true);
    expect(state.projects.has("alpha")).toBe(true);
    expect(state.issues.has("kickoff")).toBe(true);
    expect(state.agents.has("ceo")).toBe(true);
    expect(state.skills.has("skill-a")).toBe(true);

    state.company = false;
    state.issues.clear();
    state.agents.clear();
    state.skills.clear();

    const selectedFiles = buildSelectedFilesFromImportSelection(catalog, state);

    expect(selectedFiles).toContain(".paperclip.yaml");
    expect(selectedFiles).toContain("projects/alpha/PROJECT.md");
    expect(selectedFiles).toContain("projects/alpha/notes.md");
    expect(selectedFiles).not.toContain("projects/alpha/issues/kickoff/TASK.md");
    expect(selectedFiles).not.toContain("projects/alpha/issues/kickoff/details.md");
  });
});

describe("default adapter overrides", () => {
  it("maps process-only imported agents to claude_local", () => {
    const preview: CompanyPortabilityPreviewResult = {
      include: {
        company: false,
        agents: true,
        projects: false,
        issues: false,
        skills: false,
      },
      targetCompanyId: null,
      targetCompanyName: null,
      collisionStrategy: "rename",
      selectedAgentSlugs: ["legacy-agent", "explicit-agent"],
      plan: {
        companyAction: "none",
        agentPlans: [],
        projectPlans: [],
        issuePlans: [],
      },
      manifest: {
        schemaVersion: 1,
        generatedAt: "2026-03-23T18:20:00.000Z",
        source: null,
        includes: {
          company: false,
          agents: true,
          projects: false,
          issues: false,
          skills: false,
        },
        company: null,
        sidebar: null,
        agents: [
          {
            slug: "legacy-agent",
            name: "Legacy Agent",
            path: "agents/legacy-agent/AGENT.md",
            skills: [],
            role: "agent",
            title: null,
            icon: null,
            capabilities: null,
            reportsToSlug: null,
            adapterType: "process",
            adapterConfig: {},
            runtimeConfig: {},
            permissions: {},
            budgetMonthlyCents: 0,
            metadata: null,
          },
          {
            slug: "explicit-agent",
            name: "Explicit Agent",
            path: "agents/explicit-agent/AGENT.md",
            skills: [],
            role: "agent",
            title: null,
            icon: null,
            capabilities: null,
            reportsToSlug: null,
            adapterType: "codex_local",
            adapterConfig: {},
            runtimeConfig: {},
            permissions: {},
            budgetMonthlyCents: 0,
            metadata: null,
          },
        ],
        skills: [],
        projects: [],
        issues: [],
        envInputs: [],
      },
      files: {},
      envInputs: [],
      warnings: [],
      errors: [],
    };

    expect(buildDefaultImportAdapterOverrides(preview)).toEqual({
      "legacy-agent": {
        adapterType: "claude_local",
      },
    });
  });
});
