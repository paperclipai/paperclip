import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsCommands } from "../commands/client/skills.js";
import { resolveCompanySkillReference } from "../commands/client/skills.js";

const ORIGINAL_ENV = { ...process.env };

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerSkillsCommands(program);
  return program;
}

async function runCommand(args: string[]): Promise<void> {
  await makeProgram().parseAsync(args, { from: "user" });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    companyId: "company-1",
    key: "paperclip/review-prs",
    slug: "review-prs",
    name: "Review PRs",
    description: "Review pull requests",
    markdown: "# Review PRs",
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    metadata: null,
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    attachedAgentCount: 2,
    editable: true,
    editableReason: null,
    sourceLabel: null,
    sourceBadge: "local",
    sourcePath: null,
    ...overrides,
  };
}

function catalogSkill(overrides: Record<string, unknown> = {}) {
  return {
    id: "paperclipai:bundled:software-development:github-pr-workflow",
    key: "paperclipai/bundled/software-development/github-pr-workflow",
    kind: "bundled",
    category: "software-development",
    slug: "github-pr-workflow",
    name: "github-pr-workflow",
    description: "Prepare pull requests, review responses, and verification notes.",
    path: "catalog/bundled/software-development/github-pr-workflow",
    entrypoint: "SKILL.md",
    trustLevel: "markdown_only",
    compatibility: "compatible",
    defaultInstall: false,
    recommendedForRoles: ["engineer"],
    requires: [],
    tags: ["github", "pull-requests"],
    files: [{ path: "SKILL.md", kind: "skill", sizeBytes: 128, sha256: "sha256:abc" }],
    contentHash: "sha256:catalog",
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Coder",
    role: "engineer",
    status: "active",
    reportsTo: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("skills CLI helpers", () => {
  it("resolves skill refs by id, key, or unique normalized slug", () => {
    const rows = [
      skill({ id: "skill-a", key: "paperclip/a", slug: "alpha", name: "Alpha" }),
      skill({ id: "skill-b", key: "paperclip/b", slug: "beta-skill", name: "Beta" }),
    ];

    expect(resolveCompanySkillReference(rows, "skill-a").key).toBe("paperclip/a");
    expect(resolveCompanySkillReference(rows, "paperclip/b").id).toBe("skill-b");
    expect(resolveCompanySkillReference(rows, "Beta Skill").id).toBe("skill-b");
  });

  it("rejects ambiguous slug refs", () => {
    const rows = [
      skill({ id: "skill-a", key: "paperclip/a", slug: "same", name: "A" }),
      skill({ id: "skill-b", key: "paperclip/b", slug: "same", name: "B" }),
    ];

    expect(() => resolveCompanySkillReference(rows, "same")).toThrow(/Ambiguous skill slug/);
  });
});

describe("skills CLI commands", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeChunks: unknown[];

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_COMPANY_ID;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    writeChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writeChunks.push(chunk);
      return true;
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists company skills as JSON through the shared client context", async () => {
    const rows = [skill()];
    fetchMock.mockResolvedValueOnce(jsonResponse(rows));

    await runCommand([
      "skills",
      "list",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company-1/skills",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer token" }),
      }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(rows);
  });

  it("resolves a skill slug before reading detail", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([skill()]))
      .mockResolvedValueOnce(jsonResponse({ ...skill(), usedByAgents: [] }));

    await runCommand([
      "skills",
      "show",
      "Review PRs",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://paperclip.test/api/companies/company-1/skills/11111111-1111-1111-1111-111111111111",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("prints skill files as raw pipeable content in human mode", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([skill()]))
      .mockResolvedValueOnce(jsonResponse({
        skillId: "11111111-1111-1111-1111-111111111111",
        path: "SKILL.md",
        kind: "skill",
        content: "# Review PRs",
        language: "markdown",
        markdown: true,
        editable: true,
      }));

    await runCommand([
      "skills",
      "file",
      "review-prs",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
    ]);

    expect(logSpy).not.toHaveBeenCalled();
    expect(writeChunks.join("")).toBe("# Review PRs\n");
  });

  it("browses catalog skills with filters in table output", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([catalogSkill()]));

    await runCommand([
      "skills",
      "browse",
      "--kind",
      "bundled",
      "--category",
      "software-development",
      "--query",
      "github",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/skills/catalog?kind=bundled&category=software-development&q=github",
      expect.objectContaining({ method: "GET" }),
    );
    const rendered = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(rendered).toContain("id");
    expect(rendered).toContain("paperclipai:bundled:software-development:github-pr-workflow");
    expect(rendered).toContain("roles");
  });

  it("searches catalog skills as JSON", async () => {
    const rows = [catalogSkill()];
    fetchMock.mockResolvedValueOnce(jsonResponse(rows));

    await runCommand([
      "skills",
      "search",
      "pull requests",
      "--kind",
      "bundled",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/skills/catalog?kind=bundled&q=pull+requests",
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(rows);
  });

  it("inspects catalog skill detail by query ref so keys with slashes work", async () => {
    const detail = catalogSkill();
    fetchMock.mockResolvedValueOnce(jsonResponse(detail));

    await runCommand([
      "skills",
      "inspect",
      "paperclipai/bundled/software-development/github-pr-workflow",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/skills/catalog/ref?ref=paperclipai%2Fbundled%2Fsoftware-development%2Fgithub-pr-workflow",
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(detail);
  });

  it("installs catalog skills into the company library without agent sync", async () => {
    const result = {
      action: "created",
      skill: skill({
        key: "paperclipai/bundled/software-development/github-pr-workflow",
        slug: "pr-flow",
        sourceType: "catalog",
      }),
      catalogSkill: catalogSkill(),
      warnings: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(result, 201));

    await runCommand([
      "skills",
      "install",
      "github-pr-workflow",
      "--as",
      "pr-flow",
      "--force",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company-1/skills/install-catalog",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          catalogSkillId: "github-pr-workflow",
          slug: "pr-flow",
          force: true,
        }),
      }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);
  });

  it("passes force to skill updates", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([skill()]))
      .mockResolvedValueOnce(jsonResponse(skill({ sourceRef: "sha256:new" })));

    await runCommand([
      "skills",
      "update",
      "review-prs",
      "--force",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://paperclip.test/api/companies/company-1/skills/11111111-1111-1111-1111-111111111111/install-update",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ force: true }),
      }),
    );
  });

  it("audits installed skill bytes through the server", async () => {
    const audit = {
      skillId: "11111111-1111-1111-1111-111111111111",
      installedHash: "sha256:installed",
      originHash: "sha256:origin",
      verdict: "warning",
      codes: ["network_reference"],
      findings: [{
        code: "network_reference",
        severity: "warning",
        message: "Skill content references network-capable commands or URLs.",
        path: "SKILL.md",
      }],
      scannedAt: "2026-05-26T00:00:00.000Z",
      scanVersion: "skills-audit-v1",
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse([skill()]))
      .mockResolvedValueOnce(jsonResponse(audit));

    await runCommand([
      "skills",
      "audit",
      "review-prs",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://paperclip.test/api/companies/company-1/skills/11111111-1111-1111-1111-111111111111/audit",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(audit);
  });

  it("requires confirmation for reset and sends force when confirmed", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([skill({ sourceType: "catalog" })]))
      .mockResolvedValueOnce(jsonResponse(skill({ sourceType: "catalog" })));

    await runCommand([
      "skills",
      "reset",
      "review-prs",
      "--yes",
      "--force",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://paperclip.test/api/companies/company-1/skills/11111111-1111-1111-1111-111111111111/reset",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ force: true }),
      }),
    );
  });

  it("syncs desired company skill refs to an agent and returns the runtime snapshot", async () => {
    const snapshot = {
      adapterType: "codex_local",
      supported: true,
      mode: "persistent",
      desiredSkills: ["paperclip/review-prs"],
      entries: [
        {
          key: "paperclip/review-prs",
          runtimeName: "review-prs",
          desired: true,
          managed: true,
          required: false,
          state: "installed",
          origin: "company_managed",
          detail: null,
        },
      ],
      warnings: [],
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(agent()))
      .mockResolvedValueOnce(jsonResponse(snapshot));

    await runCommand([
      "skills",
      "agent",
      "sync",
      "coder",
      "--skill",
      "review-prs",
      "--skill",
      "paperclip/qa",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://paperclip.test/api/agents/coder?companyId=company-1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://paperclip.test/api/agents/agent-1/skills/sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ desiredSkills: ["review-prs", "paperclip/qa"] }),
      }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(snapshot);
  });
});
