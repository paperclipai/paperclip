import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTeamCommands } from "../commands/client/teams.js";

const ORIGINAL_ENV = { ...process.env };

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerTeamCommands(program);
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

function catalogTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: "paperclipai:bundled:software-development:product-engineering",
    key: "paperclipai/bundled/software-development/product-engineering",
    kind: "bundled",
    category: "software-development",
    slug: "product-engineering",
    name: "Product Engineering",
    description: "A software development team with CTO, coder, and QA roles.",
    path: "catalog/bundled/software-development/product-engineering",
    entrypoint: "TEAM.md",
    schema: "agentcompanies/v1",
    defaultInstall: true,
    recommendedForCompanyTypes: ["software"],
    tags: ["engineering"],
    counts: { agents: 3, projects: 1, tasks: 1, routines: 0, localSkills: 0, catalogSkills: 1, externalSkillSources: 0 },
    rootAgentSlugs: ["cto"],
    agentSlugs: ["cto", "senior-coder", "qa"],
    projectSlugs: ["product-engineering"],
    requiredSkills: [],
    envInputs: [],
    sourceRefs: [],
    files: [{ path: "TEAM.md", kind: "team", sizeBytes: 128, sha256: "sha256:team" }],
    trustLevel: "markdown_only",
    compatibility: "compatible",
    contentHash: "sha256:catalog-team",
    ...overrides,
  };
}

function installedCatalogTeam(overrides: Record<string, unknown> = {}) {
  return {
    catalogId: "paperclipai:bundled:software-development:product-engineering",
    catalogKey: "paperclipai/bundled/software-development/product-engineering",
    present: true,
    currentContentHash: "sha256:catalog-team",
    installedOriginHashes: ["sha256:catalog-team"],
    agentCount: 3,
    outOfDate: false,
    ...overrides,
  };
}

describe("teams CLI commands", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_COMPANY_ID;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("browses catalog teams with filters in table output", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([catalogTeam()]));

    await runCommand([
      "teams",
      "browse",
      "--kind",
      "bundled",
      "--category",
      "software-development",
      "--query",
      "engineering",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/teams/catalog?kind=bundled&category=software-development&q=engineering",
      expect.objectContaining({ method: "GET" }),
    );
    const rendered = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(rendered).toContain("id");
    expect(rendered).toContain("paperclipai:bundled:software-development:product-engineering");
  });

  it("searches catalog teams as JSON", async () => {
    const rows = [catalogTeam()];
    fetchMock.mockResolvedValueOnce(jsonResponse(rows));

    await runCommand([
      "teams",
      "search",
      "engineering",
      "--kind",
      "bundled",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/teams/catalog?kind=bundled&q=engineering",
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(rows);
  });

  it("lists catalog teams with installed status for a company", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([
        catalogTeam(),
        catalogTeam({
          id: "paperclipai:optional:content:content-machine",
          key: "paperclipai/optional/content/content-machine",
          kind: "optional",
          category: "content",
          slug: "content-machine",
          name: "Content Machine",
          contentHash: "sha256:content-current",
        }),
      ]))
      .mockResolvedValueOnce(jsonResponse([
        installedCatalogTeam({
          currentContentHash: "sha256:catalog-team",
          installedOriginHashes: ["sha256:older"],
          outOfDate: true,
        }),
      ]));

    await runCommand([
      "teams",
      "list",
      "--kind",
      "bundled",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://paperclip.test/api/teams/catalog?kind=bundled",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://paperclip.test/api/companies/company-1/teams/catalog/installed",
      expect.objectContaining({ method: "GET" }),
    );
    const rendered = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(rendered).toContain("installedStatus");
    expect(rendered).toContain("out_of_date");
    expect(rendered).toContain("not_installed");
  });

  it("lists installed status as JSON including removed catalog teams", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([catalogTeam()]))
      .mockResolvedValueOnce(jsonResponse([
        installedCatalogTeam(),
        installedCatalogTeam({
          catalogId: "paperclipai:removed:team",
          catalogKey: "paperclipai/removed/team",
          present: false,
          currentContentHash: null,
          installedOriginHashes: ["sha256:removed"],
          agentCount: 2,
        }),
      ]));

    await runCommand([
      "teams",
      "list",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    const rows = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(rows).toMatchObject([
      {
        catalogId: "paperclipai:bundled:software-development:product-engineering",
        catalogKey: "paperclipai/bundled/software-development/product-engineering",
        installedStatus: "installed",
        installedAgentCount: 3,
        outOfDate: false,
      },
      {
        catalogId: "paperclipai:removed:team",
        catalogKey: "paperclipai/removed/team",
        installedStatus: "installed_missing",
        installedAgentCount: 2,
        present: false,
      },
    ]);
  });

  it("inspects catalog team detail by query ref so keys with slashes work", async () => {
    const detail = catalogTeam();
    fetchMock.mockResolvedValueOnce(jsonResponse(detail));

    await runCommand([
      "teams",
      "inspect",
      "paperclipai/bundled/software-development/product-engineering",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/teams/catalog/ref?ref=paperclipai%2Fbundled%2Fsoftware-development%2Fproduct-engineering",
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(detail);
  });

  it("previews catalog team installs with trust policy flags", async () => {
    const result = {
      team: catalogTeam(),
      portabilityPreview: {
        plan: { companyAction: "none", agentPlans: [], projectPlans: [], issuePlans: [] },
        warnings: [],
        errors: [],
      },
      skillPreparations: [],
      warnings: [],
      errors: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(result));

    await runCommand([
      "teams",
      "preview",
      "product-engineering",
      "--target-manager-slug",
      "engineering-lead",
      "--allow-external-sources",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company-1/teams/catalog/ref/preview?ref=product-engineering",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          targetManagerSlug: "engineering-lead",
          sourcePolicy: { allowExternalSources: true },
        }),
      }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);
  });

  it("installs catalog teams and passes selection options", async () => {
    const result = {
      team: catalogTeam(),
      portabilityImport: {
        company: { id: "company-1", name: "Paperclip", action: "unchanged" },
        agents: [],
        projects: [],
        envInputs: [],
        warnings: [],
      },
      skillPreparations: [],
      warnings: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(result, 201));

    await runCommand([
      "teams",
      "install",
      "product-engineering",
      "--agent",
      "cto",
      "--selected-file",
      "agents/cto/AGENTS.md",
      "--collision-strategy",
      "skip",
      "--secret-value",
      "agent:cto:OPENAI_API_KEY=sk-test",
      "--adapter-override",
      "cto=opencode_local",
      "--company-id",
      "company/1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company%2F1/teams/catalog/ref/install?ref=product-engineering",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          agents: ["cto"],
          collisionStrategy: "skip",
          selectedFiles: ["agents/cto/AGENTS.md"],
          adapterOverrides: { cto: { adapterType: "opencode_local" } },
          secretValues: { "agent:cto:OPENAI_API_KEY": "sk-test" },
        }),
      }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);
  });

  it("requests board approval when agent-run install lacks create-agent permission", async () => {
    const approval = {
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: {},
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Missing permission: can create agents" }, 403))
      .mockResolvedValueOnce(jsonResponse(approval, 201));

    await runCommand([
      "teams",
      "install",
      "product-engineering",
      "--target-manager-agent-id",
      "manager-1",
      "--collision-strategy",
      "rename",
      "--secret-value",
      "agent:cto:OPENAI_API_KEY=sk-live-secret",
      "--company-id",
      "company-1",
      "--request-approval-on-forbidden",
      "--approval-issue-id",
      "11111111-1111-4111-8111-111111111111",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://paperclip.test/api/companies/company-1/teams/catalog/ref/install?ref=product-engineering",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          targetManagerAgentId: "manager-1",
          collisionStrategy: "rename",
          secretValues: { "agent:cto:OPENAI_API_KEY": "sk-live-secret" },
        }),
      }),
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://paperclip.test/api/companies/company-1/approvals",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );
    const approvalPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(approvalPayload).toMatchObject({
      type: "request_board_approval",
      issueIds: ["11111111-1111-4111-8111-111111111111"],
      payload: {
        title: "Approve catalog team install: product-engineering",
        installAttempt: {
          companyId: "company-1",
          catalogRef: "product-engineering",
          deniedReason: "Missing permission: can create agents",
          options: {
            targetManagerAgentId: "manager-1",
            collisionStrategy: "rename",
          },
        },
      },
    });
    const rendered = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(rendered).toMatchObject({
      status: "approval_requested",
      approval,
      installAttempt: {
        companyId: "company-1",
        catalogRef: "product-engineering",
        deniedReason: "Missing permission: can create agents",
        options: {
          targetManagerAgentId: "manager-1",
          collisionStrategy: "rename",
          secretValues: { "agent:cto:OPENAI_API_KEY": "[redacted]" },
        },
      },
    });
    expect(JSON.stringify(approvalPayload)).not.toContain("sk-live-secret");
    expect(String(logSpy.mock.calls[0]?.[0])).not.toContain("sk-live-secret");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("auto-requests board approval for forbidden installs inside a Paperclip task run", async () => {
    process.env.PAPERCLIP_TASK_ID = "11111111-1111-4111-8111-111111111111";
    const approval = {
      id: "approval-2",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: {},
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Missing permission: can create agents" }, 403))
      .mockResolvedValueOnce(jsonResponse(approval, 201));

    await runCommand([
      "teams",
      "install",
      "product-engineering",
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
      "http://paperclip.test/api/companies/company-1/approvals",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );
    const approvalPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(approvalPayload).toMatchObject({
      type: "request_board_approval",
      issueIds: ["11111111-1111-4111-8111-111111111111"],
      payload: {
        installAttempt: {
          companyId: "company-1",
          catalogRef: "product-engineering",
          deniedReason: "Missing permission: can create agents",
        },
      },
    });
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      status: "approval_requested",
      approval,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not request board approval for unrelated forbidden install errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Agent key cannot access another company" }, 403));
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(runCommand([
      "teams",
      "install",
      "product-engineering",
      "--company-id",
      "company-1",
      "--request-approval-on-forbidden",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
    ])).rejects.toThrow("exit:1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company-1/teams/catalog/ref/install?ref=product-engineering",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("Agent key cannot access another company");
  });

  it("surfaces server blocks for unsafe local-path catalog team sources", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: 'Local path skill source "../unsafe" is development-only and is not allowed for catalog team install.',
    }, 422));
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(runCommand([
      "teams",
      "install",
      "unsafe-local-team",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
    ])).rejects.toThrow("exit:1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company-1/teams/catalog/ref/install?ref=unsafe-local-team",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("API error 422");
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("development-only");
  });
});
