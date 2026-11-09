import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerActivityCommands } from "../commands/client/activity.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "33333333-3333-4333-8333-333333333333";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerActivityCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

describe("activity parity commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps activity endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(jsonResponse([])))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse()))
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);

    await run(["activity", "list", "--company-id", COMPANY_ID, "--agent-id", "agent-1"]);
    await run(["activity", "create", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["activity", "issue", ISSUE_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/activity?agentId=agent-1`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/activity`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/activity?limit=100`],
    ]);
  });

  it("walks issue activity pages until a short page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `activity-${index}` }));
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(jsonResponse(firstPage)))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse([{ id: "activity-100" }])));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.mocked(console.log);

    await run(["activity", "issue", ISSUE_ID, "--json"]);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `http://localhost:3100/api/issues/${ISSUE_ID}/activity?limit=100`,
      `http://localhost:3100/api/issues/${ISSUE_ID}/activity?limit=100&before=activity-99`,
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toHaveLength(101);
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
