import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";

const companySvc = {
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const agentSvc = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const accessSvc = {
  ensureMembership: vi.fn(),
  listActiveUserMemberships: vi.fn(),
  copyActiveUserMemberships: vi.fn(),
  setPrincipalPermission: vi.fn(),
};

const projectSvc = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
};

const issueSvc = {
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  create: vi.fn(),
};

const routineSvc = {
  list: vi.fn(),
  getDetail: vi.fn(),
  create: vi.fn(),
  createTrigger: vi.fn(),
};

const companySkillSvc = {
  list: vi.fn(),
  listFull: vi.fn(),
  readFile: vi.fn(),
  importPackageFiles: vi.fn(),
};

const assetSvc = {
  getById: vi.fn(),
  create: vi.fn(),
};

const agentInstructionsSvc = {
  exportFiles: vi.fn(),
  materializeManagedBundle: vi.fn(),
};

vi.mock("../services/companies.js", () => ({
  companyService: () => companySvc,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => agentSvc,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => accessSvc,
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => projectSvc,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => issueSvc,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => routineSvc,
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => companySkillSvc,
}));

vi.mock("../services/assets.js", () => ({
  assetService: () => assetSvc,
}));

vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: () => agentInstructionsSvc,
}));

vi.mock("../routes/org-chart-svg.js", () => ({
  renderOrgChartPng: vi.fn(async () => Buffer.from("png")),
}));

const { companyPortabilityService, parseGitHubSourceUrl } = await import("../services/company-portability.js");

function asTextFile(entry: CompanyPortabilityFileEntry | undefined) {
  expect(typeof entry).toBe("string");
  return typeof entry === "string" ? entry : "";
}

describe("company portability", () => {
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const companyPlaybookKey = "company/company-1/company-playbook";

  beforeEach(() => {
    vi.clearAllMocks();
    companySvc.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      description: null,
      issuePrefix: "PAP",
      brandColor: "#5c5fff",
      logoAssetId: null,
      logoUrl: null,
      requireBoardApprovalForNewAgents: true,
    });
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        status: "idle",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are ClaudeCoder.",
          paperclipSkillSync: {
            desiredSkills: [paperclipKey],
          },
          instructionsFilePath: "/tmp/ignored.md",
          cwd: "/tmp/ignored",
          command: "/Users/dotta/.local/bin/claude",
          model: "claude-opus-4-6",
          env: {
            ANTHROPIC_API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
            GH_TOKEN: {
              type: "secret_ref",
              secretId: "secret-2",
              version: "latest",
            },
            PATH: {
              type: "plain",
              value: "/usr/bin:/bin",
            },
          },
        },
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
        budgetMonthlyCents: 0,
        permissions: {
          canCreateAgents: false,
        },
        metadata: null,
      },
      {
        id: "agent-2",
        name: "CMO",
        status: "idle",
        role: "cmo",
        title: "Chief Marketing Officer",
        icon: "globe",
        reportsTo: null,
        capabilities: "Owns marketing",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are CMO.",
        },
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
        budgetMonthlyCents: 0,
        permissions: {
          canCreateAgents: false,
        },
        metadata: null,
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    projectSvc.createWorkspace.mockResolvedValue(null);
    projectSvc.listWorkspaces.mockResolvedValue([]);
    issueSvc.list.mockResolvedValue([]);
    issueSvc.getById.mockResolvedValue(null);
    issueSvc.getByIdentifier.mockResolvedValue(null);
    routineSvc.list.mockResolvedValue([]);
    routineSvc.getDetail.mockImplementation(async (id: string) => {
      const rows = await routineSvc.list();
      return rows.find((row: { id: string }) => row.id === id) ?? null;
    });
    routineSvc.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "routine-created",
      companyId: "company-1",
      projectId: input.projectId,
      goalId: null,
      parentIssueId: null,
      title: input.title,
      description: input.description ?? null,
      assigneeAgentId: input.assigneeAgentId,
      priority: input.priority ?? "medium",
      status: input.status ?? "active",
      concurrencyPolicy: input.concurrencyPolicy ?? "coalesce_if_active",
      catchUpPolicy: input.catchUpPolicy ?? "skip_missed",
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      lastTriggeredAt: null,
      lastEnqueuedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    routineSvc.createTrigger.mockImplementation(async (_routineId: string, input: Record<string, unknown>) => ({
      id: "trigger-created",
      companyId: "company-1",
      routineId: "routine-created",
      kind: input.kind,
      label: input.label ?? null,
      enabled: input.enabled ?? true,
      cronExpression: input.kind === "schedule" ? input.cronExpression ?? null : null,
      timezone: input.kind === "schedule" ? input.timezone ?? null : null,
      nextRunAt: null,
      lastFiredAt: null,
      publicId: null,
      secretId: null,
      signingMode: input.kind === "webhook" ? input.signingMode ?? "bearer" : null,
      replayWindowSec: input.kind === "webhook" ? input.replayWindowSec ?? 300 : null,
      lastRotatedAt: null,
      lastResult: null,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const companySkills = [
      {
        id: "skill-1",
        companyId: "company-1",
        key: paperclipKey,
        slug: "paperclip",
        name: "paperclip",
        description: "Paperclip coordination skill",
        markdown: "---\nname: paperclip\ndescription: Paperclip coordination skill\n---\n\n# Paperclip\n",
        sourceType: "github",
        sourceLocator: "https://github.com/paperclipai/paperclip/tree/master/skills/paperclip",
        sourceRef: "0123456789abcdef0123456789abcdef01234567",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [
          { path: "SKILL.md", kind: "skill" },
          { path: "references/api.md", kind: "reference" },
        ],
        metadata: {
          sourceKind: "github",
          owner: "paperclipai",
          repo: "paperclip",
          ref: "0123456789abcdef0123456789abcdef01234567",
          trackingRef: "master",
          repoSkillDir: "skills/paperclip",
        },
      },
      {
        id: "skill-2",
        companyId: "company-1",
        key: companyPlaybookKey,
        slug: "company-playbook",
        name: "company-playbook",
        description: "Internal company skill",
        markdown: "---\nname: company-playbook\ndescription: Internal company skill\n---\n\n# Company Playbook\n",
        sourceType: "local_path",
        sourceLocator: "/tmp/company-playbook",
        sourceRef: null,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [
          { path: "SKILL.md", kind: "skill" },
          { path: "references/checklist.md", kind: "reference" },
        ],
        metadata: {
          sourceKind: "local_path",
        },
      },
    ];
    companySkillSvc.list.mockResolvedValue(companySkills);
    companySkillSvc.listFull.mockResolvedValue(companySkills);
    companySkillSvc.readFile.mockImplementation(async (_companyId: string, skillId: string, relativePath: string) => {
      if (skillId === "skill-2") {
        return {
          skillId,
          path: relativePath,
          kind: relativePath === "SKILL.md" ? "skill" : "reference",
          content: relativePath === "SKILL.md"
            ? "---\nname: company-playbook\ndescription: Internal company skill\n---\n\n# Company Playbook\n"
            : "# Checklist\n",
          language: "markdown",
          markdown: true,
          editable: true,
        };
      }

      return {
        skillId,
        path: relativePath,
        kind: relativePath === "SKILL.md" ? "skill" : "reference",
        content: relativePath === "SKILL.md"
          ? "---\nname: paperclip\ndescription: Paperclip coordination skill\n---\n\n# Paperclip\n"
          : "# API\n",
        language: "markdown",
        markdown: true,
        editable: false,
      };
    });
    companySkillSvc.importPackageFiles.mockResolvedValue([]);
    assetSvc.getById.mockReset();
    assetSvc.getById.mockResolvedValue(null);
    assetSvc.create.mockReset();
    accessSvc.setPrincipalPermission.mockResolvedValue(undefined);
    assetSvc.create.mockResolvedValue({
      id: "asset-created",
    });
    accessSvc.listActiveUserMemberships.mockResolvedValue([
      {
        id: "membership-1",
        companyId: "company-1",
        principalType: "user",
        principalId: "user-1",
        membershipRole: "owner",
        status: "active",
      },
    ]);
    accessSvc.copyActiveUserMemberships.mockResolvedValue([]);
    agentInstructionsSvc.exportFiles.mockImplementation(async (agent: { name: string }) => ({
      files: { "AGENTS.md": agent.name === "CMO" ? "You are CMO." : "You are ClaudeCoder." },
      entryFile: "AGENTS.md",
      warnings: [],
    }));
    agentInstructionsSvc.materializeManagedBundle.mockImplementation(async (agent: { adapterConfig: Record<string, unknown> }) => ({
      bundle: null,
      adapterConfig: {
        ...agent.adapterConfig,
        instructionsBundleMode: "managed",
        instructionsRootPath: `/tmp/${agent.id}`,
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: `/tmp/${agent.id}/AGENTS.md`,
      },
    }));
  });

  it("parses canonical GitHub import URLs with explicit ref and package path", () => {
    expect(
      parseGitHubSourceUrl("https://github.com/paperclipai/companies?ref=feature%2Fdemo&path=gstack"),
    ).toEqual({
      hostname: "github.com",
      owner: "paperclipai",
      repo: "companies",
      ref: "feature/demo",
      basePath: "gstack",
      companyPath: "gstack/COMPANY.md",
    });
  });

  it("parses canonical GitHub import URLs with explicit companyPath", () => {
    expect(
      parseGitHubSourceUrl(
        "https://github.com/paperclipai/companies?ref=abc123&companyPath=gstack%2FCOMPANY.md",
      ),
    ).toEqual({
      hostname: "github.com",
      owner: "paperclipai",
      repo: "companies",
      ref: "abc123",
      basePath: "gstack",
      companyPath: "gstack/COMPANY.md",
    });
  });

  it("exports referenced skills as stubs by default with sanitized Paperclip extension data", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    expect(asTextFile(exported.files["COMPANY.md"])).toContain('name: "Paperclip"');
    expect(asTextFile(exported.files["COMPANY.md"])).toContain('schema: "agentcompanies/v1"');
    expect(asTextFile(exported.files["agents/claudecoder/AGENTS.md"])).toContain("You are ClaudeCoder.");
    expect(asTextFile(exported.files["agents/claudecoder/AGENTS.md"])).toContain("skills:");
    expect(asTextFile(exported.files["agents/claudecoder/AGENTS.md"])).toContain(`- "${paperclipKey}"`);
    expect(asTextFile(exported.files["agents/cmo/AGENTS.md"])).not.toContain("skills:");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"])).toContain("metadata:");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"])).toContain('kind: "github-dir"');
    expect(exported.files["skills/paperclipai/paperclip/paperclip/references/api.md"]).toBeUndefined();
    expect(asTextFile(exported.files["skills/company/PAP/company-playbook/SKILL.md"])).toContain("# Company Playbook");
    expect(asTextFile(exported.files["skills/company/PAP/company-playbook/references/checklist.md"])).toContain("# Checklist");

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain('schema: "paperclip/v1"');
    expect(extension).not.toContain("promptTemplate");
    expect(extension).not.toContain("instructionsFilePath");
    expect(extension).not.toContain("command:");
    expect(extension).not.toContain("secretId");
    expect(extension).not.toContain('type: "secret_ref"');
    expect(extension).toContain("inputs:");
    expect(extension).toContain("ANTHROPIC_API_KEY:");
    expect(extension).toContain('requirement: "optional"');
    expect(extension).toContain('default: ""');
    expect(extension).not.toContain("paperclipSkillSync");
    expect(extension).not.toContain("PATH:");
    expect(extension).not.toContain("requireBoardApprovalForNewAgents: true");
    expect(extension).not.toContain("budgetMonthlyCents: 0");
    expect(exported.warnings).toContain("Agent claudecoder command /Users/dotta/.local/bin/claude was omitted from export because it is system-dependent.");
    expect(exported.warnings).toContain("Agent claudecoder PATH override was omitted from export because it is system-dependent.");
  });

  it("exports default sidebar order into the Paperclip extension and manifest", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-2",
        companyId: "company-1",
        name: "Zulu",
        urlKey: "zulu",
        description: null,
        leadAgentId: null,
        targetDate: null,
        color: null,
        status: "planned",
        executionWorkspacePolicy: null,
        archivedAt: null,
        workspaces: [],
      },
      {
        id: "project-1",
        companyId: "company-1",
        name: "Alpha",
        urlKey: "alpha",
        description: null,
        leadAgentId: null,
        targetDate: null,
        color: null,
        status: "planned",
        executionWorkspacePolicy: null,
        archivedAt: null,
        workspaces: [],
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: false,
      },
    });

    expect(asTextFile(exported.files[".paperclip.yaml"])).toContain([
      "sidebar:",
      "  agents:",
      '    - "claudecoder"',
      '    - "cmo"',
      "  projects:",
      '    - "alpha"',
      '    - "zulu"',
    ].join("\n"));
    expect(exported.manifest.sidebar).toEqual({
      agents: ["claudecoder", "cmo"],
      projects: ["alpha", "zulu"],
    });
  });

  it("expands referenced skills when requested", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      expandReferencedSkills: true,
    });

    expect(asTextFile(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"])).toContain("# Paperclip");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"])).toContain("metadata:");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/paperclip/references/api.md"])).toContain("# API");
  });

  it("exports only selected skills when skills filter is provided", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      skills: ["company-playbook"],
    });

    expect(exported.files["skills/company/PAP/company-playbook/SKILL.md"]).toBeDefined();
    expect(asTextFile(exported.files["skills/company/PAP/company-playbook/SKILL.md"])).toContain("# Company Playbook");
    expect(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"]).toBeUndefined();
  });

  it("warns and exports all skills when skills filter matches nothing", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      skills: ["nonexistent-skill"],
    });

    expect(exported.warnings).toContainEqual(expect.stringContaining("nonexistent-skill"));
    expect(exported.files["skills/company/PAP/company-playbook/SKILL.md"]).toBeDefined();
    expect(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"]).toBeDefined();
  });

  it("exports the company logo into images/ and references it from .paperclip.yaml", async () => {
    const storage = {
      getObject: vi.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from("png-bytes")]),
      }),
    };
    companySvc.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      description: null,
      issuePrefix: "PAP",
      brandColor: "#5c5fff",
      logoAssetId: "logo-1",
      logoUrl: "/api/assets/logo-1/content",
      requireBoardApprovalForNewAgents: true,
    });
    assetSvc.getById.mockResolvedValue({
      id: "logo-1",
      companyId: "company-1",
      objectKey: "assets/companies/logo-1",
      contentType: "image/png",
      originalFilename: "logo.png",
    });

    const portability = companyPortabilityService({} as any, storage as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: false,
        projects: false,
        issues: false,
      },
    });

    expect(storage.getObject).toHaveBeenCalledWith("company-1", "assets/companies/logo-1");
    expect(exported.files["images/company-logo.png"]).toEqual({
      encoding: "base64",
      data: Buffer.from("png-bytes").toString("base64"),
      contentType: "image/png",
    });
    expect(exported.files[".paperclip.yaml"]).toContain('logoPath: "images/company-logo.png"');
  });

  it("exports duplicate skill slugs into readable namespaced paths", async () => {
    const portability = companyPortabilityService({} as any);

    companySkillSvc.readFile.mockImplementation(async (_companyId: string, skillId: string, relativePath: string) => {
      if (skillId === "skill-local") {
        return {
          skillId,
          path: relativePath,
          kind: "skill",
          content: "---\nname: release-changelog\n---\n\n# Local Release Changelog\n",
          language: "markdown",
          markdown: true,
          editable: true,
        };
      }

      return {
        skillId,
        path: relativePath,
        kind: "skill",
        content: "---\nname: release-changelog\n---\n\n# Bundled Release Changelog\n",
        language: "markdown",
        markdown: true,
        editable: false,
      };
    });

    companySkillSvc.listFull.mockResolvedValue([
      {
        id: "skill-local",
        companyId: "company-1",
        key: "local/36dfd631da/release-changelog",
        slug: "release-changelog",
        name: "release-changelog",
        description: "Local release changelog skill",
        markdown: "---\nname: release-changelog\n---\n\n# Local Release Changelog\n",
        sourceType: "local_path",
        sourceLocator: "/tmp/release-changelog",
        sourceRef: null,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: {
          sourceKind: "local_path",
        },
      },
      {
        id: "skill-paperclip",
        companyId: "company-1",
        key: "paperclipai/paperclip/release-changelog",
        slug: "release-changelog",
        name: "release-changelog",
        description: "Bundled release changelog skill",
        markdown: "---\nname: release-changelog\n---\n\n# Bundled Release Changelog\n",
        sourceType: "github",
        sourceLocator: "https://github.com/paperclipai/paperclip/tree/master/skills/release-changelog",
        sourceRef: "0123456789abcdef0123456789abcdef01234567",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: {
          sourceKind: "paperclip_bundled",
          owner: "paperclipai",
          repo: "paperclip",
          ref: "0123456789abcdef0123456789abcdef01234567",
          trackingRef: "master",
          repoSkillDir: "skills/release-changelog",
        },
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    expect(asTextFile(exported.files["skills/local/release-changelog/SKILL.md"])).toContain("# Local Release Changelog");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/release-changelog/SKILL.md"])).toContain("metadata:");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/release-changelog/SKILL.md"])).toContain("paperclipai/paperclip/release-changelog");
  });

  it("builds export previews without tasks by default", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        urlKey: "launch",
        description: "Ship it",
        leadAgentId: "agent-1",
        targetDate: null,
        color: null,
        status: "planned",
        executionWorkspacePolicy: null,
        archivedAt: null,
      },
    ]);
    issueSvc.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Write launch task",
        description: "Task body",
        projectId: "project-1",
        assigneeAgentId: "agent-1",
        status: "todo",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        executionWorkspaceSettings: null,
        assigneeAdapterOverrides: null,
      },
    ]);

    const preview = await portability.previewExport("company-1", {
      include: {
        company: true,
        agents: true,
        projects: true,
      },
    });

    expect(preview.counts.issues).toBe(0);
    expect(preview.fileInventory.some((entry) => entry.path.startsWith("tasks/"))).toBe(false);
  });

  it("exports portable project workspace metadata and remaps it on import", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        urlKey: "launch",
        description: "Ship it",
        leadAgentId: "agent-1",
        targetDate: "2026-03-31",
        color: "#123456",
        status: "planned",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: "workspace-1",
          workspaceStrategy: {
            type: "project_primary",
          },
        },
        workspaces: [
          {
            id: "workspace-1",
            companyId: "company-1",
            projectId: "project-1",
            name: "Main Repo",
            sourceType: "git_repo",
            cwd: "/Users/dotta/paperclip",
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
            defaultRef: "main",
            visibility: "default",
            setupCommand: "pnpm install",
            cleanupCommand: "rm -rf .paperclip-tmp",
            remoteProvider: null,
            remoteWorkspaceRef: null,
            sharedWorkspaceKey: null,
            metadata: {
              language: "typescript",
            },
            isPrimary: true,
            createdAt: new Date("2026-03-01T00:00:00Z"),
            updatedAt: new Date("2026-03-01T00:00:00Z"),
          },
          {
            id: "workspace-2",
            companyId: "company-1",
            projectId: "project-1",
            name: "Local Scratch",
            sourceType: "local_path",
            cwd: "/tmp/paperclip-local",
            repoUrl: null,
            repoRef: null,
            defaultRef: null,
            visibility: "advanced",
            setupCommand: null,
            cleanupCommand: null,
            remoteProvider: null,
            remoteWorkspaceRef: null,
            sharedWorkspaceKey: null,
            metadata: null,
            isPrimary: false,
            createdAt: new Date("2026-03-01T00:00:00Z"),
            updatedAt: new Date("2026-03-01T00:00:00Z"),
          },
        ],
        archivedAt: null,
      },
    ]);
    issueSvc.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Write launch task",
        description: "Task body",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        assigneeAgentId: "agent-1",
        status: "todo",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        executionWorkspaceSettings: {
          mode: "shared_workspace",
        },
        assigneeAdapterOverrides: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: false,
        projects: true,
        issues: true,
      },
    });

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("workspaces:");
    expect(extension).toContain("main-repo:");
    expect(extension).toContain('repoUrl: "https://github.com/paperclipai/paperclip.git"');
    expect(extension).toContain('defaultProjectWorkspaceKey: "main-repo"');
    expect(extension).toContain('projectWorkspaceKey: "main-repo"');
    expect(extension).not.toContain("/Users/dotta/paperclip");
    expect(extension).not.toContain("workspace-1");
    expect(exported.warnings).toContain("Project launch workspace Local Scratch was omitted from export because it does not have a portable repoUrl.");

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);
    projectSvc.create.mockResolvedValue({
      id: "project-imported",
      name: "Launch",
      urlKey: "launch",
    });
    projectSvc.update.mockImplementation(async (projectId: string, data: Record<string, unknown>) => ({
      id: projectId,
      name: "Launch",
      urlKey: "launch",
      ...data,
    }));
    projectSvc.createWorkspace.mockImplementation(async (projectId: string, data: Record<string, unknown>) => ({
      id: "workspace-imported",
      companyId: "company-imported",
      projectId,
      name: `${data.name ?? "Workspace"}`,
      sourceType: `${data.sourceType ?? "git_repo"}`,
      cwd: null,
      repoUrl: typeof data.repoUrl === "string" ? data.repoUrl : null,
      repoRef: typeof data.repoRef === "string" ? data.repoRef : null,
      defaultRef: typeof data.defaultRef === "string" ? data.defaultRef : null,
      visibility: `${data.visibility ?? "default"}`,
      setupCommand: typeof data.setupCommand === "string" ? data.setupCommand : null,
      cleanupCommand: typeof data.cleanupCommand === "string" ? data.cleanupCommand : null,
      remoteProvider: null,
      remoteWorkspaceRef: null,
      sharedWorkspaceKey: null,
      metadata: (data.metadata as Record<string, unknown> | null | undefined) ?? null,
      isPrimary: Boolean(data.isPrimary),
      createdAt: new Date("2026-03-02T00:00:00Z"),
      updatedAt: new Date("2026-03-02T00:00:00Z"),
    }));
    issueSvc.create.mockResolvedValue({
      id: "issue-imported",
      title: "Write launch task",
    });

    await portability.importBundle({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: false,
        projects: true,
        issues: true,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      collisionStrategy: "rename",
    }, "user-1");

    expect(projectSvc.createWorkspace).toHaveBeenCalledWith("project-imported", expect.objectContaining({
      name: "Main Repo",
      sourceType: "git_repo",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      repoRef: "main",
      defaultRef: "main",
      visibility: "default",
    }));
    expect(projectSvc.update).toHaveBeenCalledWith("project-imported", expect.objectContaining({
      executionWorkspacePolicy: expect.objectContaining({
        enabled: true,
        defaultMode: "shared_workspace",
        defaultProjectWorkspaceId: "workspace-imported",
      }),
    }));
    expect(issueSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      projectId: "project-imported",
      projectWorkspaceId: "workspace-imported",
      title: "Write launch task",
    }));
  });

  it("infers portable git metadata from a local checkout without task warning fan-out", async () => {
    const portability = companyPortabilityService({} as any);
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-portability-git-"));
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/paperclipai/paperclip.git"], {
      cwd: repoDir,
      stdio: "ignore",
    });

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Paperclip App",
        urlKey: "paperclip-app",
        description: "Ship it",
        leadAgentId: null,
        targetDate: null,
        color: null,
        status: "planned",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: "workspace-1",
        },
        workspaces: [
          {
            id: "workspace-1",
            companyId: "company-1",
            projectId: "project-1",
            name: "paperclip",
            sourceType: "local_path",
            cwd: repoDir,
            repoUrl: null,
            repoRef: null,
            defaultRef: null,
            visibility: "default",
            setupCommand: null,
            cleanupCommand: null,
            remoteProvider: null,
            remoteWorkspaceRef: null,
            sharedWorkspaceKey: null,
            metadata: null,
            isPrimary: true,
            createdAt: new Date("2026-03-01T00:00:00Z"),
            updatedAt: new Date("2026-03-01T00:00:00Z"),
          },
        ],
        archivedAt: null,
      },
    ]);
    issueSvc.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Task one",
        description: "Task body",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        assigneeAgentId: null,
        status: "todo",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        executionWorkspaceSettings: null,
        assigneeAdapterOverrides: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: false,
        agents: false,
        projects: true,
        issues: true,
      },
    });

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain('repoUrl: "https://github.com/paperclipai/paperclip.git"');
    expect(extension).toContain('projectWorkspaceKey: "paperclip"');
    expect(exported.warnings).not.toContainEqual(expect.stringContaining("does not have a portable repoUrl"));
    expect(exported.warnings).not.toContainEqual(expect.stringContaining("reference workspace workspace-1"));
  });

  it("collapses repeated task workspace warnings into one summary per missing workspace", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        urlKey: "launch",
        description: "Ship it",
        leadAgentId: null,
        targetDate: null,
        color: null,
        status: "planned",
        executionWorkspacePolicy: null,
        workspaces: [
          {
            id: "workspace-1",
            companyId: "company-1",
            projectId: "project-1",
            name: "Local Scratch",
            sourceType: "local_path",
            cwd: "/tmp/local-only",
            repoUrl: null,
            repoRef: null,
            defaultRef: null,
            visibility: "default",
            setupCommand: null,
            cleanupCommand: null,
            remoteProvider: null,
            remoteWorkspaceRef: null,
            sharedWorkspaceKey: null,
            metadata: null,
            isPrimary: true,
            createdAt: new Date("2026-03-01T00:00:00Z"),
            updatedAt: new Date("2026-03-01T00:00:00Z"),
          },
        ],
        archivedAt: null,
      },
    ]);
    issueSvc.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Task one",
        description: null,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        assigneeAgentId: null,
        status: "todo",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        executionWorkspaceSettings: null,
        assigneeAdapterOverrides: null,
      },
      {
        id: "issue-2",
        identifier: "PAP-2",
        title: "Task two",
        description: null,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        assigneeAgentId: null,
        status: "todo",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        executionWorkspaceSettings: null,
        assigneeAdapterOverrides: null,
      },
      {
        id: "issue-3",
        identifier: "PAP-3",
        title: "Task three",
        description: null,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        assigneeAgentId: null,
        status: "todo",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        executionWorkspaceSettings: null,
        assigneeAdapterOverrides: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: false,
        agents: false,
        projects: true,
        issues: true,
      },
    });

    expect(exported.warnings).toContain("Project launch workspace Local Scratch was omitted from export because it does not have a portable repoUrl.");
    expect(exported.warnings).toContain("Tasks pap-1, pap-2, pap-3 reference workspace workspace-1, but that workspace could not be exported portably.");
    expect(exported.warnings.filter((warning) => warning.includes("workspace reference workspace-1 was omitted from export"))).toHaveLength(0);
    expect(exported.warnings.filter((warning) => warning.includes("could not be exported portably"))).toHaveLength(1);
  });

  it("reads env inputs back from .paperclip.yaml during preview import", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    const preview = await portability.previewImport({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
    });

    expect(preview.errors).toEqual([]);
    expect(preview.envInputs).toEqual([
      {
        key: "ANTHROPIC_API_KEY",
        description: "Provide ANTHROPIC_API_KEY for agent claudecoder",
        agentSlug: "claudecoder",
        kind: "secret",
        requirement: "optional",
        defaultValue: "",
        portability: "portable",
      },
      {
        key: "GH_TOKEN",
        description: "Provide GH_TOKEN for agent claudecoder",
        agentSlug: "claudecoder",
        kind: "secret",
        requirement: "optional",
        defaultValue: "",
        portability: "portable",
      },
    ]);
  });

  it("exports routines as recurring task packages with Paperclip routine extensions", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        urlKey: "launch",
        description: "Ship it",
        leadAgentId: "agent-1",
        targetDate: null,
        color: null,
        status: "planned",
        executionWorkspacePolicy: null,
        archivedAt: null,
      },
    ]);
    routineSvc.list.mockResolvedValue([
      {
        id: "routine-1",
        companyId: "company-1",
        projectId: "project-1",
        goalId: null,
        parentIssueId: null,
        title: "Monday Review",
        description: "Review pipeline health",
        assigneeAgentId: "agent-1",
        priority: "high",
        status: "paused",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "enqueue_missed_with_cap",
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        lastTriggeredAt: null,
        lastEnqueuedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        triggers: [
          {
            id: "trigger-1",
            companyId: "company-1",
            routineId: "routine-1",
            kind: "schedule",
            label: "Weekly cadence",
            enabled: true,
            cronExpression: "0 9 * * 1",
            timezone: "America/Chicago",
            nextRunAt: null,
            lastFiredAt: null,
            publicId: "public-1",
            secretId: "secret-1",
            signingMode: null,
            replayWindowSec: null,
            lastRotatedAt: null,
            lastResult: null,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: "trigger-2",
            companyId: "company-1",
            routineId: "routine-1",
            kind: "webhook",
            label: "External nudge",
            enabled: false,
            cronExpression: null,
            timezone: null,
            nextRunAt: null,
            lastFiredAt: null,
            publicId: "public-2",
            secretId: "secret-2",
            signingMode: "hmac_sha256",
            replayWindowSec: 120,
            lastRotatedAt: null,
            lastResult: null,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        lastRun: null,
        activeIssue: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: false,
      },
    });

    expect(asTextFile(exported.files["tasks/monday-review/TASK.md"])).toContain('recurring: true');
    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("routines:");
    expect(extension).toContain("monday-review:");
    expect(extension).toContain('cronExpression: "0 9 * * 1"');
    expect(extension).toContain('signingMode: "hmac_sha256"');
    expect(extension).not.toContain("secretId");
    expect(extension).not.toContain("publicId");
    expect(exported.manifest.issues).toEqual([
      expect.objectContaining({
        slug: "monday-review",
        recurring: true,
        status: "paused",
        priority: "high",
        routine: expect.objectContaining({
          concurrencyPolicy: "always_enqueue",
          catchUpPolicy: "enqueue_missed_with_cap",
          triggers: expect.arrayContaining([
            expect.objectContaining({ kind: "schedule", cronExpression: "0 9 * * 1", timezone: "America/Chicago" }),
            expect.objectContaining({ kind: "webhook", enabled: false, signingMode: "hmac_sha256", replayWindowSec: 120 }),
          ]),
        }),
      }),
    ]);
  });

  it("imports recurring task packages as routines instead of one-time issues", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });
    projectSvc.create.mockResolvedValue({
      id: "project-created",
      name: "Launch",
      urlKey: "launch",
    });
    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);

    const files = {
      "COMPANY.md": [
        "---",
        'schema: "agentcompanies/v1"',
        'name: "Imported Paperclip"',
        "---",
        "",
      ].join("\n"),
      "agents/claudecoder/AGENTS.md": [
        "---",
        'name: "ClaudeCoder"',
        "---",
        "",
        "You write code.",
        "",
      ].join("\n"),
      "projects/launch/PROJECT.md": [
        "---",
        'name: "Launch"',
        "---",
        "",
      ].join("\n"),
      "tasks/monday-review/TASK.md": [
        "---",
        'name: "Monday Review"',
        'project: "launch"',
        'assignee: "claudecoder"',
        "recurring: true",
        "---",
        "",
        "Review pipeline health.",
        "",
      ].join("\n"),
      ".paperclip.yaml": [
        'schema: "paperclip/v1"',
        "routines:",
        "  monday-review:",
        '    status: "paused"',
        '    priority: "high"',
        '    concurrencyPolicy: "always_enqueue"',
        '    catchUpPolicy: "enqueue_missed_with_cap"',
        "    triggers:",
        "      - kind: schedule",
        '        cronExpression: "0 9 * * 1"',
        '        timezone: "America/Chicago"',
        '      - kind: webhook',
        '        enabled: false',
        '        signingMode: "hmac_sha256"',
        '        replayWindowSec: 120',
        "",
      ].join("\n"),
    };

    const preview = await portability.previewImport({
      source: { type: "inline", rootPath: "paperclip-demo", files },
      include: { company: true, agents: true, projects: true, issues: true, skills: false },
      target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
      agents: "all",
      collisionStrategy: "rename",
    });

    expect(preview.errors).toEqual([]);
    expect(preview.plan.issuePlans).toEqual([
      expect.objectContaining({
        slug: "monday-review",
        reason: "Recurring task will be imported as a routine.",
      }),
    ]);

    await portability.importBundle({
      source: { type: "inline", rootPath: "paperclip-demo", files },
      include: { company: true, agents: true, projects: true, issues: true, skills: false },
      target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
      agents: "all",
      collisionStrategy: "rename",
    }, "user-1");

    expect(routineSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      projectId: "project-created",
      title: "Monday Review",
      assigneeAgentId: "agent-created",
      priority: "high",
      status: "paused",
      concurrencyPolicy: "always_enqueue",
      catchUpPolicy: "enqueue_missed_with_cap",
    }), expect.any(Object));
    expect(routineSvc.createTrigger).toHaveBeenCalledTimes(2);
    expect(routineSvc.createTrigger).toHaveBeenCalledWith("routine-created", expect.objectContaining({
      kind: "schedule",
      cronExpression: "0 9 * * 1",
      timezone: "America/Chicago",
    }), expect.any(Object));
    expect(routineSvc.createTrigger).toHaveBeenCalledWith("routine-created", expect.objectContaining({
      kind: "webhook",
      enabled: false,
      signingMode: "hmac_sha256",
      replayWindowSec: 120,
    }), expect.any(Object));
    expect(issueSvc.create).not.toHaveBeenCalled();
  });

  it("migrates legacy schedule.recurrence imports into routine triggers", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });
    projectSvc.create.mockResolvedValue({
      id: "project-created",
      name: "Launch",
      urlKey: "launch",
    });
    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);

    const files = {
      "COMPANY.md": ['---', 'schema: "agentcompanies/v1"', 'name: "Imported Paperclip"', "---", ""].join("\n"),
      "agents/claudecoder/AGENTS.md": ['---', 'name: "ClaudeCoder"', "---", "", "You write code.", ""].join("\n"),
      "projects/launch/PROJECT.md": ['---', 'name: "Launch"', "---", ""].join("\n"),
      "tasks/monday-review/TASK.md": [
        "---",
        'name: "Monday Review"',
        'project: "launch"',
        'assignee: "claudecoder"',
        "schedule:",
        '  timezone: "America/Chicago"',
        '  startsAt: "2026-03-16T09:00:00-05:00"',
        "  recurrence:",
        '    frequency: "weekly"',
        "    interval: 1",
        "    weekdays:",
        '      - "monday"',
        "---",
        "",
        "Review pipeline health.",
        "",
      ].join("\n"),
    };

    const preview = await portability.previewImport({
      source: { type: "inline", rootPath: "paperclip-demo", files },
      include: { company: true, agents: true, projects: true, issues: true, skills: false },
      target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
      agents: "all",
      collisionStrategy: "rename",
    });

    expect(preview.errors).toEqual([]);
    expect(preview.manifest.issues[0]).toEqual(expect.objectContaining({
      recurring: true,
      legacyRecurrence: expect.objectContaining({ frequency: "weekly" }),
    }));

    await portability.importBundle({
      source: { type: "inline", rootPath: "paperclip-demo", files },
      include: { company: true, agents: true, projects: true, issues: true, skills: false },
      target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
      agents: "all",
      collisionStrategy: "rename",
    }, "user-1");

    expect(routineSvc.createTrigger).toHaveBeenCalledWith("routine-created", expect.objectContaining({
      kind: "schedule",
      cronExpression: "0 9 * * 1",
      timezone: "America/Chicago",
    }), expect.any(Object));
    expect(issueSvc.create).not.toHaveBeenCalled();
  });

  it("flags recurring task imports that are missing routine-required fields", async () => {
    const portability = companyPortabilityService({} as any);

    const preview = await portability.previewImport({
      source: {
        type: "inline",
        rootPath: "paperclip-demo",
        files: {
          "COMPANY.md": ['---', 'schema: "agentcompanies/v1"', 'name: "Imported Paperclip"', "---", ""].join("\n"),
          "tasks/monday-review/TASK.md": [
            "---",
            'name: "Monday Review"',
            "recurring: true",
            "---",
            "",
            "Review pipeline health.",
            "",
          ].join("\n"),
        },
      },
      include: { company: true, agents: false, projects: false, issues: true, skills: false },
      target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
      collisionStrategy: "rename",
    });

    expect(preview.errors).toContain("Recurring task monday-review must declare a project to import as a routine.");
    expect(preview.errors).toContain("Recurring task monday-review must declare an assignee to import as a routine.");
  });

  it("imports a vendor-neutral package without .paperclip.yaml", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const preview = await portability.previewImport({
      source: {
        type: "inline",
        rootPath: "paperclip-demo",
        files: {
          "COMPANY.md": [
            "---",
            'schema: "agentcompanies/v1"',
            'name: "Imported Paperclip"',
            'description: "Portable company package"',
            "---",
            "",
            "# Imported Paperclip",
            "",
          ].join("\n"),
          "agents/claudecoder/AGENTS.md": [
            "---",
            'name: "ClaudeCoder"',
            'title: "Software Engineer"',
            "---",
            "",
            "# ClaudeCoder",
            "",
            "You write code.",
            "",
          ].join("\n"),
        },
      },
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
    });

    expect(preview.errors).toEqual([]);
    expect(preview.manifest.company?.name).toBe("Imported Paperclip");
    expect(preview.manifest.agents).toEqual([
      expect.objectContaining({
        slug: "claudecoder",
        name: "ClaudeCoder",
        adapterType: "process",
      }),
    ]);
    expect(preview.envInputs).toEqual([]);

    await portability.importBundle({
      source: {
        type: "inline",
        rootPath: "paperclip-demo",
        files: {
          "COMPANY.md": [
            "---",
            'schema: "agentcompanies/v1"',
            'name: "Imported Paperclip"',
            'description: "Portable company package"',
            "---",
            "",
            "# Imported Paperclip",
            "",
          ].join("\n"),
          "agents/claudecoder/AGENTS.md": [
            "---",
            'name: "ClaudeCoder"',
            'title: "Software Engineer"',
            "---",
            "",
            "# ClaudeCoder",
            "",
            "You write code.",
            "",
          ].join("\n"),
        },
      },
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
    }, "user-1");

    expect(companySvc.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Imported Paperclip",
      description: "Portable company package",
    }));
    expect(agentSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      name: "ClaudeCoder",
      adapterType: "process",
    }));
  });

  it("preserves agent role from frontmatter when extension block omits it", async () => {
    const portability = companyPortabilityService({} as any);

    const preview = await portability.previewImport({
      source: {
        type: "inline",
        rootPath: "ceo-package",
        files: {
          "COMPANY.md": [
            "---",
            'schema: "agentcompanies/v1"',
            'name: "CEO Role Test"',
            "---",
            "",
          ].join("\n"),
          "agents/ceo/AGENTS.md": [
            "---",
            'name: "CEO"',
            'role: "ceo"',
            "---",
            "",
            "# CEO",
            "",
            "You run the company.",
            "",
          ].join("\n"),
        },
      },
      include: { company: true, agents: true, projects: false, issues: false },
      target: { mode: "new_company", newCompanyName: "CEO Role Test" },
      agents: "all",
      collisionStrategy: "rename",
    });

    expect(preview.errors).toEqual([]);
    expect(preview.manifest.agents).toEqual([
      expect.objectContaining({
        slug: "ceo",
        name: "CEO",
        role: "ceo",
      }),
    ]);
  });

  it("treats no-separator auth and api key env names as secrets during export", async () => {
    const portability = companyPortabilityService({} as any);

    agentSvc.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        status: "idle",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are ClaudeCoder.",
          env: {
            APIKEY: {
              type: "plain",
              value: "sk-plain-api",
            },
            GITHUBAUTH: {
              type: "plain",
              value: "gh-auth-token",
            },
            PRIVATEKEY: {
              type: "plain",
              value: "private-key-value",
            },
          },
        },
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        permissions: {},
        metadata: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("APIKEY:");
    expect(extension).toContain("GITHUBAUTH:");
    expect(extension).toContain("PRIVATEKEY:");
    expect(extension).not.toContain("sk-plain-api");
    expect(extension).not.toContain("gh-auth-token");
    expect(extension).not.toContain("private-key-value");
    expect(extension).toContain('kind: "secret"');
  });

  it("imports packaged skills and restores desired skill refs on agents", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
    }, "user-1");

    const textOnlyFiles = Object.fromEntries(Object.entries(exported.files).filter(([, v]) => typeof v === "string"));
    expect(companySkillSvc.importPackageFiles).toHaveBeenCalledWith("company-imported", textOnlyFiles, {
      onConflict: "replace",
    });
    expect(agentSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      adapterConfig: expect.objectContaining({
        paperclipSkillSync: {
          desiredSkills: [paperclipKey],
        },
      }),
    }));
  });

  it("imports a packaged company logo and attaches it to the target company", async () => {
    const storage = {
      putFile: vi.fn().mockResolvedValue({
        provider: "local_disk",
        objectKey: "assets/companies/imported-logo",
        contentType: "image/png",
        byteSize: 9,
        sha256: "logo-sha",
        originalFilename: "company-logo.png",
      }),
    };
    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
      logoAssetId: null,
    });
    companySvc.update.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
      logoAssetId: "asset-created",
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const portability = companyPortabilityService({} as any, storage as any);
    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    exported.files["images/company-logo.png"] = {
      encoding: "base64",
      data: Buffer.from("png-bytes").toString("base64"),
      contentType: "image/png",
    };
    exported.files[".paperclip.yaml"] = `${exported.files[".paperclip.yaml"]}`.replace(
      'brandColor: "#5c5fff"\n',
      'brandColor: "#5c5fff"\n  logoPath: "images/company-logo.png"\n',
    );

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
    }, "user-1");

    expect(storage.putFile).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-imported",
      namespace: "assets/companies",
      originalFilename: "company-logo.png",
      contentType: "image/png",
      body: Buffer.from("png-bytes"),
    }));
    expect(assetSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      objectKey: "assets/companies/imported-logo",
      contentType: "image/png",
      createdByUserId: "user-1",
    }));
    expect(companySvc.update).toHaveBeenCalledWith("company-imported", {
      logoAssetId: "asset-created",
    });
  });

  it("copies source company memberships for safe new-company imports", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
    }, null, {
      mode: "agent_safe",
      sourceCompanyId: "company-1",
    });

    expect(accessSvc.listActiveUserMemberships).toHaveBeenCalledWith("company-1");
    expect(accessSvc.copyActiveUserMemberships).toHaveBeenCalledWith("company-1", "company-imported");
    expect(accessSvc.ensureMembership).not.toHaveBeenCalledWith("company-imported", "user", expect.anything(), "owner", "active");
    const textOnlyFiles = Object.fromEntries(Object.entries(exported.files).filter(([, v]) => typeof v === "string"));
    expect(companySkillSvc.importPackageFiles).toHaveBeenCalledWith("company-imported", textOnlyFiles, {
      onConflict: "rename",
    });
  });

  it("disables timer heartbeats on imported agents", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    agentSvc.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: `agent-${String(input.name).toLowerCase()}`,
      name: input.name,
      adapterConfig: input.adapterConfig,
      runtimeConfig: input.runtimeConfig,
    }));

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
    }, "user-1");

    const createdClaude = agentSvc.create.mock.calls.find(([, input]) => input.name === "ClaudeCoder");
    expect(createdClaude?.[1]).toMatchObject({
      runtimeConfig: {
        heartbeat: {
          enabled: false,
        },
      },
    });
  });

  it("imports only selected files and leaves unchecked company metadata alone", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);
    companySvc.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      description: "Existing company",
      brandColor: "#123456",
      requireBoardApprovalForNewAgents: false,
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-cmo",
      name: "CMO",
    });

    const result = await portability.importBundle({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
      },
      selectedFiles: ["agents/cmo/AGENTS.md"],
      target: {
        mode: "existing_company",
        companyId: "company-1",
      },
      agents: "all",
      collisionStrategy: "rename",
    }, "user-1");

    expect(companySvc.update).not.toHaveBeenCalled();
    expect(companySkillSvc.importPackageFiles).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        "COMPANY.md": expect.any(String),
        "agents/cmo/AGENTS.md": expect.any(String),
      }),
      {
        onConflict: "replace",
      },
    );
    expect(companySkillSvc.importPackageFiles).toHaveBeenCalledWith(
      "company-1",
      expect.not.objectContaining({
        "agents/claudecoder/AGENTS.md": expect.any(String),
      }),
      {
        onConflict: "replace",
      },
    );
    expect(agentSvc.create).toHaveBeenCalledTimes(1);
    expect(agentSvc.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      name: "CMO",
      runtimeConfig: {
        heartbeat: {
          enabled: false,
        },
      },
    }));
    expect(result.company.action).toBe("unchanged");
    expect(result.agents).toEqual([
      {
        slug: "cmo",
        id: "agent-cmo",
        action: "created",
        name: "CMO",
        reason: null,
      },
    ]);
  });

  it("applies adapter overrides while keeping imported AGENTS content implicit", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
      adapterOverrides: {
        claudecoder: {
          adapterType: "codex_local",
          adapterConfig: {
            dangerouslyBypassApprovalsAndSandbox: true,
            instructionsFilePath: "/tmp/should-not-survive.md",
          },
        },
      },
    }, "user-1");

    expect(agentSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      adapterType: "codex_local",
      adapterConfig: expect.objectContaining({
        dangerouslyBypassApprovalsAndSandbox: true,
      }),
    }));
    expect(agentSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      adapterConfig: expect.not.objectContaining({
        instructionsFilePath: expect.anything(),
        promptTemplate: expect.anything(),
      }),
    }));
    expect(agentInstructionsSvc.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ClaudeCoder" }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are ClaudeCoder."),
      }),
      expect.objectContaining({
        clearLegacyPromptTemplate: true,
        replaceExisting: true,
      }),
    );
    const materializedFiles = agentInstructionsSvc.materializeManagedBundle.mock.calls[0]?.[1] as Record<string, string>;
    expect(materializedFiles["AGENTS.md"]).not.toMatch(/^---\n/);
    expect(materializedFiles["AGENTS.md"]).not.toContain('name: "ClaudeCoder"');
  });

  it("strips root AGENTS frontmatter when importing a nested agent entry path", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });
    const originalAgentsMarkdown = exported.files["agents/claudecoder/AGENTS.md"];
    expect(typeof originalAgentsMarkdown).toBe("string");

    const files = {
      ...exported.files,
      "agents/claudecoder/nested/AGENTS.md": originalAgentsMarkdown!,
    };

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files,
      },
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: ["claudecoder"],
      collisionStrategy: "rename",
      adapterOverrides: {
        claudecoder: {
          adapterType: "codex_local",
          adapterConfig: {
            dangerouslyBypassApprovalsAndSandbox: true,
          },
        },
      },
    }, "user-1");

    const nestedMaterializedFiles = agentInstructionsSvc.materializeManagedBundle.mock.calls
      .map(([, filesArg]) => filesArg as Record<string, string>)
      .find((filesArg) => typeof filesArg["nested/AGENTS.md"] === "string");

    expect(nestedMaterializedFiles).toBeDefined();
    expect(nestedMaterializedFiles?.["nested/AGENTS.md"]).toContain("You are ClaudeCoder.");
    expect(nestedMaterializedFiles?.["AGENTS.md"]).toContain("You are ClaudeCoder.");
    expect(nestedMaterializedFiles?.["AGENTS.md"]).not.toMatch(/^---\n/);
    expect(nestedMaterializedFiles?.["AGENTS.md"]).not.toContain('name: "ClaudeCoder"');
  });
});
