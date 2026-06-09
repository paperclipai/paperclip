import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentCommands } from "../commands/client/agent.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "33333333-3333-4333-8333-333333333333";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerAgentCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

describe("agent lifecycle commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps agent lifecycle and state endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run([
      "agent", "create",
      "--company-id", COMPANY_ID,
      "--payload-json", JSON.stringify({ name: "Builder", adapterType: "codex_local" }),
    ]);
    await run(["agent", "hire", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await run(["agent", "update", AGENT_ID, "--payload-json", JSON.stringify({ title: "Senior Builder" })]);
    await run(["agent", "pause", AGENT_ID]);
    await run(["agent", "resume", AGENT_ID]);
    await run(["agent", "approve", AGENT_ID]);
    await run(["agent", "terminate", AGENT_ID]);
    await run(["agent", "heartbeat:invoke", AGENT_ID]);
    await run(["agent", "claude-login", AGENT_ID]);
    await run(["agent", "delete", AGENT_ID, "--yes"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/agents`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/agent-hires`],
      ["PATCH", `http://localhost:3100/api/agents/${AGENT_ID}`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/pause`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/resume`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/approve`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/terminate`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/heartbeat/invoke`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/claude-login`],
      ["DELETE", `http://localhost:3100/api/agents/${AGENT_ID}`],
    ]);
  });

  it("wraps configuration, runtime, skills, and instructions endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["agent", "permissions:update", AGENT_ID, "--payload-json", JSON.stringify({ canCreateAgents: true, canAssignTasks: true })]);
    await run(["agent", "configuration", AGENT_ID]);
    await run(["agent", "config-revisions", AGENT_ID]);
    await run(["agent", "config-revision:get", AGENT_ID, REVISION_ID]);
    await run(["agent", "config-revision:rollback", AGENT_ID, REVISION_ID]);
    await run(["agent", "runtime-state", AGENT_ID]);
    await run(["agent", "runtime-state:reset-session", AGENT_ID, "--task-key", "task-1"]);
    await run(["agent", "task-sessions", AGENT_ID]);
    await run(["agent", "skills", AGENT_ID]);
    await run(["agent", "skills:sync", AGENT_ID, "--desired-skills", "paperclip,github"]);
    await run(["agent", "instructions-path:update", AGENT_ID, "--payload-json", JSON.stringify({ path: "/tmp/AGENTS.md" })]);
    await run(["agent", "instructions-bundle", AGENT_ID]);
    await run(["agent", "instructions-bundle:update", AGENT_ID, "--payload-json", JSON.stringify({ mode: "managed" })]);
    await run(["agent", "instructions-file:get", AGENT_ID, "--path", "AGENTS.md"]);
    await run(["agent", "instructions-file:put", AGENT_ID, "--path", "AGENTS.md", "--content", "hello"]);
    await run(["agent", "instructions-file:delete", AGENT_ID, "--path", "AGENTS.md"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["PATCH", `http://localhost:3100/api/agents/${AGENT_ID}/permissions`],
      ["GET", `http://localhost:3100/api/agents/${AGENT_ID}/configuration`],
      ["GET", `http://localhost:3100/api/agents/${AGENT_ID}/config-revisions`],
      ["GET", `http://localhost:3100/api/agents/${AGENT_ID}/config-revisions/${REVISION_ID}`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/config-revisions/${REVISION_ID}/rollback`],
      ["GET", `http://localhost:3100/api/agents/${AGENT_ID}/runtime-state`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/runtime-state/reset-session`],
      ["GET", `http://localhost:3100/api/agents/${AGENT_ID}/task-sessions`],
      ["GET", `http://localhost:3100/api/agents/${AGENT_ID}/skills`],
      ["POST", `http://localhost:3100/api/agents/${AGENT_ID}/skills/sync`],
      ["PATCH", `http://localhost:3100/api/agents/${AGENT_ID}/instructions-path`],
      ["GET", `http://localhost:3100/api/agents/${AGENT_ID}/instructions-bundle`],
      ["PATCH", `http://localhost:3100/api/agents/${AGENT_ID}/instructions-bundle`],
      ["GET", `http://localhost:3100/api/agents/${AGENT_ID}/instructions-bundle/file?path=AGENTS.md`],
      ["PUT", `http://localhost:3100/api/agents/${AGENT_ID}/instructions-bundle/file`],
      ["DELETE", `http://localhost:3100/api/agents/${AGENT_ID}/instructions-bundle/file?path=AGENTS.md`],
    ]);
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
