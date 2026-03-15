import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerCompanyCommands } from "../commands/client/company.js";

describe("company templates commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists built-in templates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([
        {
          id: "safe-autonomous-organization",
          name: "Safe Autonomous Organization",
          description: "Governance-first autonomous operating company",
          category: "governance",
          maturity: "opinionated",
          useCases: ["governance-first automation", "high-trust operations"],
          agentCount: 6,
          recommended: true,
        },
      ]), { status: 200 }),
    );
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    const program = new Command();
    registerCompanyCommands(program);

    await program.parseAsync(
      ["company", "templates", "list", "--api-base", "http://localhost:3100"],
      { from: "user" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/templates");
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("id=safe-autonomous-organization"));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("maturity=opinionated"));
  });

  it("gets one built-in template as json", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: "solo-founder-lite",
        name: "Solo Founder Lite",
        description: "Lean starter company",
        category: "starter",
        maturity: "starter",
        useCases: ["first-time setup", "local experimentation"],
        recommended: true,
        setupMarkdown: null,
        manifest: {
          schemaVersion: 1,
          title: "Solo Founder Lite",
          description: "Lean starter company",
          includes: {
            company: true,
            agents: true,
            goals: false,
            projects: false,
            issues: false,
          },
          company: {
            name: "Solo Founder Lite",
            issuePrefix: "SFL",
            description: null,
            path: "COMPANY.md",
          },
          agents: [],
          goals: [],
          projects: [],
          issues: [],
          requiredSecrets: [],
        },
      }), { status: 200 }),
    );
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    const program = new Command();
    registerCompanyCommands(program);

    await program.parseAsync(
      ["company", "templates", "get", "solo-founder-lite", "--api-base", "http://localhost:3100", "--json"],
      { from: "user" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/templates/solo-founder-lite");
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("\"id\": \"solo-founder-lite\""));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("\"maturity\": \"starter\""));
  });
});
