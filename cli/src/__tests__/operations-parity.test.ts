import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCostCommands } from "../commands/client/cost.js";
import { registerWorkspaceCommands } from "../commands/client/workspace.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const PROJECT_ID = "66666666-6666-4666-8666-666666666666";
const PROJECT_WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";
const ENV_ID = "88888888-8888-4888-8888-888888888888";
const INCIDENT_ID = "99999999-9999-4999-8999-999999999999";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCostCommands(program);
  registerWorkspaceCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

describe("operations parity commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps cost, finance, and budget endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["cost", "summary", "--company-id", COMPANY_ID]);
    await run(["cost", "by-agent", "--company-id", COMPANY_ID]);
    await run(["cost", "by-project", "--company-id", COMPANY_ID]);
    await run(["cost", "issue", ISSUE_ID]);
    await run(["cost", "event:create", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["finance", "event:create", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["finance", "summary", "--company-id", COMPANY_ID]);
    await run(["budget", "overview", "--company-id", COMPANY_ID]);
    await run(["budget", "policy:upsert", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["budget", "company:update", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["budget", "agent:update", AGENT_ID, "--payload-json", "{}"]);
    await run(["budget", "incident:resolve", INCIDENT_ID, "--company-id", COMPANY_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/summary`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/by-agent`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/by-project`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/cost-summary`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/cost-events`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/finance-events`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/finance-summary`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/budgets/overview`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/budgets/policies`],
      ["PATCH", `http://localhost:3100/api/companies/${COMPANY_ID}/budgets`],
      ["PATCH", `http://localhost:3100/api/agents/${AGENT_ID}/budgets`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/budget-incidents/${INCIDENT_ID}/resolve`],
    ]);
  });

  it("wraps org, execution workspace, environment, and project workspace endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["org", "get", "--company-id", COMPANY_ID]);
    await run(["org", "svg", "--company-id", COMPANY_ID]);
    await run(["agent-config", "list", "--company-id", COMPANY_ID]);
    await run(["workspace", "list", "--company-id", COMPANY_ID]);
    await run(["workspace", "get", WORKSPACE_ID]);
    await run(["workspace", "close-readiness", WORKSPACE_ID]);
    await run(["workspace", "operations", WORKSPACE_ID]);
    await run(["workspace", "update", WORKSPACE_ID, "--payload-json", "{}"]);
    await run(["workspace", "runtime-service", WORKSPACE_ID, "restart", "--payload-json", "{}"]);
    await run(["environment", "list", "--company-id", COMPANY_ID]);
    await run(["environment", "capabilities", "--company-id", COMPANY_ID]);
    await run(["environment", "create", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["environment", "get", ENV_ID]);
    await run(["environment", "leases", ENV_ID]);
    await run(["environment", "update", ENV_ID, "--payload-json", "{}"]);
    await run(["environment", "delete", ENV_ID]);
    await run(["environment", "probe", ENV_ID]);
    await run(["environment", "probe-config", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["project-workspace", "list", PROJECT_ID]);
    await run(["project-workspace", "create", PROJECT_ID, "--payload-json", "{}"]);
    await run(["project-workspace", "update", PROJECT_ID, PROJECT_WORKSPACE_ID, "--payload-json", "{}"]);
    await run(["project-workspace", "runtime-command", PROJECT_ID, PROJECT_WORKSPACE_ID, "run", "--payload-json", "{}"]);
    await run(["project-workspace", "delete", PROJECT_ID, PROJECT_WORKSPACE_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/org`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/org.svg`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-configurations`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/execution-workspaces`],
      ["GET", `http://localhost:3100/api/execution-workspaces/${WORKSPACE_ID}`],
      ["GET", `http://localhost:3100/api/execution-workspaces/${WORKSPACE_ID}/close-readiness`],
      ["GET", `http://localhost:3100/api/execution-workspaces/${WORKSPACE_ID}/workspace-operations`],
      ["PATCH", `http://localhost:3100/api/execution-workspaces/${WORKSPACE_ID}`],
      ["POST", `http://localhost:3100/api/execution-workspaces/${WORKSPACE_ID}/runtime-services/restart`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/environments`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/environments/capabilities`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/environments`],
      ["GET", `http://localhost:3100/api/environments/${ENV_ID}`],
      ["GET", `http://localhost:3100/api/environments/${ENV_ID}/leases`],
      ["PATCH", `http://localhost:3100/api/environments/${ENV_ID}`],
      ["DELETE", `http://localhost:3100/api/environments/${ENV_ID}`],
      ["POST", `http://localhost:3100/api/environments/${ENV_ID}/probe`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/environments/probe-config`],
      ["GET", `http://localhost:3100/api/projects/${PROJECT_ID}/workspaces`],
      ["POST", `http://localhost:3100/api/projects/${PROJECT_ID}/workspaces`],
      ["PATCH", `http://localhost:3100/api/projects/${PROJECT_ID}/workspaces/${PROJECT_WORKSPACE_ID}`],
      ["POST", `http://localhost:3100/api/projects/${PROJECT_ID}/workspaces/${PROJECT_WORKSPACE_ID}/runtime-commands/run`],
      ["DELETE", `http://localhost:3100/api/projects/${PROJECT_ID}/workspaces/${PROJECT_WORKSPACE_ID}`],
    ]);
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
