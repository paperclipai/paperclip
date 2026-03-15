import { beforeEach, describe, expect, it, vi } from "vitest";

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
};

const projectSvc = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const issueSvc = {
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  create: vi.fn(),
};

const companySkillSvc = {
  list: vi.fn(),
  readFile: vi.fn(),
  importPackageFiles: vi.fn(),
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

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => companySkillSvc,
}));

const { companyPortabilityService } = await import("../services/company-portability.js");

describe("company portability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    companySvc.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      description: null,
      brandColor: "#5c5fff",
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
            desiredSkills: ["paperclip"],
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
    issueSvc.list.mockResolvedValue([]);
    issueSvc.getById.mockResolvedValue(null);
    issueSvc.getByIdentifier.mockResolvedValue(null);
    companySkillSvc.list.mockResolvedValue([
      {
        id: "skill-1",
        companyId: "company-1",
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
    ]);
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

    expect(exported.files["COMPANY.md"]).toContain('name: "Paperclip"');
    expect(exported.files["COMPANY.md"]).toContain('schema: "agentcompanies/v1"');
    expect(exported.files["agents/claudecoder/AGENTS.md"]).toContain("You are ClaudeCoder.");
    expect(exported.files["agents/claudecoder/AGENTS.md"]).toContain("skills:");
    expect(exported.files["agents/claudecoder/AGENTS.md"]).toContain('- "paperclip"');
    expect(exported.files["agents/cmo/AGENTS.md"]).not.toContain("skills:");
    expect(exported.files["skills/paperclip/SKILL.md"]).toContain("metadata:");
    expect(exported.files["skills/paperclip/SKILL.md"]).toContain('kind: "github-dir"');
    expect(exported.files["skills/paperclip/references/api.md"]).toBeUndefined();
    expect(exported.files["skills/company-playbook/SKILL.md"]).toContain("# Company Playbook");
    expect(exported.files["skills/company-playbook/references/checklist.md"]).toContain("# Checklist");

    const extension = exported.files[".paperclip.yaml"];
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
    expect(extension).not.toContain("PATH:");
    expect(extension).not.toContain("requireBoardApprovalForNewAgents: true");
    expect(extension).not.toContain("budgetMonthlyCents: 0");
    expect(exported.warnings).toContain("Agent claudecoder command /Users/dotta/.local/bin/claude was omitted from export because it is system-dependent.");
    expect(exported.warnings).toContain("Agent claudecoder PATH override was omitted from export because it is system-dependent.");
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

    expect(exported.files["skills/paperclip/SKILL.md"]).toContain("# Paperclip");
    expect(exported.files["skills/paperclip/SKILL.md"]).toContain("metadata:");
    expect(exported.files["skills/paperclip/references/api.md"]).toContain("# API");
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

    expect(companySkillSvc.importPackageFiles).toHaveBeenCalledWith("company-imported", exported.files);
    expect(agentSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      adapterConfig: expect.objectContaining({
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      }),
    }));
  });
});
