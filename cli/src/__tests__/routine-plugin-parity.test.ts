import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPluginCommands } from "../commands/client/plugin.js";
import { registerRoutineApiCommands } from "../commands/client/routine-api.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const TRIGGER_ID = "55555555-5555-4555-8555-555555555555";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRoutineApiCommands(program);
  registerPluginCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

describe("routine and plugin parity commands", () => {
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

  it("wraps routine API endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["routine", "list", "--company-id", COMPANY_ID, "--project-id", "p1"]);
    await run(["routine", "create", "--company-id", COMPANY_ID, "--payload-json", "{}", "--pipeline", "content"]);
    await run(["routine", "get", ROUTINE_ID]);
    await run(["routine", "update", ROUTINE_ID, "--payload-json", "{}"]);
    await run(["routine", "revisions", ROUTINE_ID]);
    await run(["routine", "revision:restore", ROUTINE_ID, REVISION_ID]);
    await run(["routine", "runs", ROUTINE_ID, "--limit", "5"]);
    await run(["routine", "run", ROUTINE_ID]);
    await run(["routine", "trigger:create", ROUTINE_ID, "--payload-json", "{}"]);
    await run(["routine", "trigger:update", TRIGGER_ID, "--payload-json", "{}"]);
    await run(["routine", "trigger:delete", TRIGGER_ID]);
    await run(["routine", "trigger:rotate-secret", TRIGGER_ID]);
    await run(["routine", "trigger:fire", "public-id"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/routines?projectId=p1`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/routines`],
      ["GET", `http://localhost:3100/api/routines/${ROUTINE_ID}`],
      ["PATCH", `http://localhost:3100/api/routines/${ROUTINE_ID}`],
      ["GET", `http://localhost:3100/api/routines/${ROUTINE_ID}/revisions`],
      ["POST", `http://localhost:3100/api/routines/${ROUTINE_ID}/revisions/${REVISION_ID}/restore`],
      ["GET", `http://localhost:3100/api/routines/${ROUTINE_ID}/runs?limit=5`],
      ["POST", `http://localhost:3100/api/routines/${ROUTINE_ID}/run`],
      ["POST", `http://localhost:3100/api/routines/${ROUTINE_ID}/triggers`],
      ["PATCH", `http://localhost:3100/api/routine-triggers/${TRIGGER_ID}`],
      ["DELETE", `http://localhost:3100/api/routine-triggers/${TRIGGER_ID}`],
      ["POST", `http://localhost:3100/api/routine-triggers/${TRIGGER_ID}/rotate-secret`],
      ["POST", "http://localhost:3100/api/routine-triggers/public/public-id/fire"],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toMatchObject({
      originKind: "pipeline_automation",
      originId: "content",
    });
  });

  it("wraps deeper plugin endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["plugin", "ui-contributions"]);
    await run(["plugin", "tools"]);
    await run(["plugin", "tool:execute", "--payload-json", "{}"]);
    await run(["plugin", "health", "plug"]);
    await run(["plugin", "logs", "plug"]);
    await run(["plugin", "upgrade", "plug"]);
    await run(["plugin", "config", "plug"]);
    await run(["plugin", "config:set", "plug", "--payload-json", "{}"]);
    await run(["plugin", "config:test", "plug", "--payload-json", "{}"]);
    await run(["plugin", "jobs", "plug"]);
    await run(["plugin", "job:runs", "plug", "job1"]);
    await run(["plugin", "job:trigger", "plug", "job1"]);
    await run(["plugin", "webhook", "plug", "endpoint", "--payload-json", "{}"]);
    await run(["plugin", "dashboard", "plug"]);
    await run(["plugin", "bridge:data", "plug", "--payload-json", "{}"]);
    await run(["plugin", "bridge:action", "plug", "--payload-json", "{}"]);
    await run(["plugin", "bridge:stream", "plug", "events", "--duration-ms", "1"]);
    await run(["plugin", "data", "plug", "key", "--payload-json", "{}"]);
    await run(["plugin", "action", "plug", "key", "--payload-json", "{}"]);
    await run(["plugin", "local-folders", "plug", "--company-id", COMPANY_ID]);
    await run(["plugin", "local-folder:status", "plug", "source", "--company-id", COMPANY_ID]);
    await run(["plugin", "local-folder:validate", "plug", "source", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["plugin", "local-folder:set", "plug", "source", "--company-id", COMPANY_ID, "--payload-json", "{}"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/plugins/ui-contributions"],
      ["GET", "http://localhost:3100/api/plugins/tools"],
      ["POST", "http://localhost:3100/api/plugins/tools/execute"],
      ["GET", "http://localhost:3100/api/plugins/plug/health"],
      ["GET", "http://localhost:3100/api/plugins/plug/logs"],
      ["POST", "http://localhost:3100/api/plugins/plug/upgrade"],
      ["GET", "http://localhost:3100/api/plugins/plug/config"],
      ["POST", "http://localhost:3100/api/plugins/plug/config"],
      ["POST", "http://localhost:3100/api/plugins/plug/config/test"],
      ["GET", "http://localhost:3100/api/plugins/plug/jobs"],
      ["GET", "http://localhost:3100/api/plugins/plug/jobs/job1/runs"],
      ["POST", "http://localhost:3100/api/plugins/plug/jobs/job1/trigger"],
      ["POST", "http://localhost:3100/api/plugins/plug/webhooks/endpoint"],
      ["GET", "http://localhost:3100/api/plugins/plug/dashboard"],
      ["POST", "http://localhost:3100/api/plugins/plug/bridge/data"],
      ["POST", "http://localhost:3100/api/plugins/plug/bridge/action"],
      ["GET", "http://localhost:3100/api/plugins/plug/bridge/stream/events"],
      ["POST", "http://localhost:3100/api/plugins/plug/data/key"],
      ["POST", "http://localhost:3100/api/plugins/plug/actions/key"],
      ["GET", `http://localhost:3100/api/plugins/plug/companies/${COMPANY_ID}/local-folders`],
      ["GET", `http://localhost:3100/api/plugins/plug/companies/${COMPANY_ID}/local-folders/source/status`],
      ["POST", `http://localhost:3100/api/plugins/plug/companies/${COMPANY_ID}/local-folders/source/validate`],
      ["PUT", `http://localhost:3100/api/plugins/plug/companies/${COMPANY_ID}/local-folders/source`],
    ]);
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
