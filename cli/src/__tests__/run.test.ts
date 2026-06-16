import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentCommands } from "../commands/client/agent.js";
import { registerIssueCommands } from "../commands/client/issue.js";
import { registerRunCommands } from "../commands/client/run.js";
import { shouldAutoEnableUiDevMiddleware } from "../commands/run.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";

function createRunConfig(deploymentMode: "local_trusted" | "authenticated") {
  return {
    server: {
      deploymentMode,
      exposure: "private",
    },
  } as any;
}

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  const run = program.command("run").action(() => {});
  registerRunCommands(run);
  registerAgentCommands(program);
  registerIssueCommands(program);
  return program;
}

describe("run inspection commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists and reads heartbeat runs through run subcommands", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: RUN_ID, companyId: COMPANY_ID, agentId: AGENT_ID, status: "running", invocationSource: "on_demand" },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: RUN_ID,
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        status: "running",
        invocationSource: "on_demand",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        text: "hello",
        offset: 0,
        nextOffset: 5,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: RUN_ID, status: "cancelled" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "run", "list",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--agent-id", AGENT_ID,
      "--limit", "25",
    ], { from: "user" });

    await createProgram().parseAsync([
      "run", "get", RUN_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });

    await createProgram().parseAsync([
      "run", "log", RUN_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--offset", "4",
      "--limit-bytes", "100",
      "--text",
    ], { from: "user" });

    await createProgram().parseAsync([
      "run", "cancel", RUN_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3100/api/companies/${COMPANY_ID}/heartbeat-runs?agentId=${AGENT_ID}&limit=25`,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/heartbeat-runs/${RUN_ID}`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `http://localhost:3100/api/heartbeat-runs/${RUN_ID}/log?offset=4&limitBytes=100`,
    );
    expect(fetchMock.mock.calls[3]?.[0]).toBe(`http://localhost:3100/api/heartbeat-runs/${RUN_ID}/cancel`);
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("POST");
  });

  it("supports run events, issues, workspace operations, and watchdog decisions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 1, runId: RUN_ID, agentId: AGENT_ID, seq: 1, eventType: "output", message: "hi" },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: ISSUE_ID, identifier: "PC-1", title: "Fix it", status: "in_progress", priority: "normal" },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: "55555555-5555-4555-8555-555555555555", status: "succeeded", phase: "workspace_provision" },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "workspace" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "decision-1", decision: "continue" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "run", "events", RUN_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--after-seq", "7",
      "--limit", "50",
    ], { from: "user" });
    await createProgram().parseAsync([
      "run", "issues", RUN_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });
    await createProgram().parseAsync([
      "run", "workspace-operations", RUN_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });
    await createProgram().parseAsync([
      "run", "workspace-log", "55555555-5555-4555-8555-555555555555",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });
    await createProgram().parseAsync([
      "run", "watchdog-decision", RUN_ID,
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--decision", "continue",
      "--reason", "operator reviewed",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3100/api/heartbeat-runs/${RUN_ID}/events?afterSeq=7&limit=50`,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/heartbeat-runs/${RUN_ID}/issues`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`http://localhost:3100/api/heartbeat-runs/${RUN_ID}/workspace-operations`);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "http://localhost:3100/api/workspace-operations/55555555-5555-4555-8555-555555555555/log?offset=0",
    );
    expect(fetchMock.mock.calls[4]?.[0]).toBe(`http://localhost:3100/api/heartbeat-runs/${RUN_ID}/watchdog-decisions`);
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toMatchObject({
      decision: "continue",
      reason: "operator reviewed",
    });
  });

  it("wakes agents and exposes issue run helpers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: AGENT_ID,
        name: "Builder",
        companyId: COMPANY_ID,
        urlKey: "builder",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: RUN_ID,
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        status: "queued",
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: RUN_ID, status: "succeeded" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: RUN_ID, status: "running" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: RUN_ID, status: "running" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "agent", "wake", "builder",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
      "--company-id", COMPANY_ID,
      "--reason", "manual check",
      "--payload", "{\"issueId\":\"PC-1\"}",
    ], { from: "user" });
    await createProgram().parseAsync([
      "issue", "runs", "PC-1",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });
    await createProgram().parseAsync([
      "issue", "live-runs", "PC-1",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });
    await createProgram().parseAsync([
      "issue", "active-run", "PC-1",
      "--api-base", "http://localhost:3100",
      "--api-key", "board-token",
    ], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/agents/builder?companyId=${COMPANY_ID}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3100/api/agents/${AGENT_ID}/wakeup`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual check",
      payload: { issueId: "PC-1" },
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3100/api/issues/PC-1/runs");
    expect(fetchMock.mock.calls[3]?.[0]).toBe("http://localhost:3100/api/issues/PC-1/live-runs");
    expect(fetchMock.mock.calls[4]?.[0]).toBe("http://localhost:3100/api/issues/PC-1/active-run");
  });
});

describe("paperclipai run UI mode selection", () => {
  it("keeps Vite middleware for local trusted source checkouts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-run-ui-"));
    try {
      const entrypoint = path.join(root, "server/src/index.ts");
      fs.mkdirSync(path.join(root, "ui/dist"), { recursive: true });
      fs.writeFileSync(path.join(root, "ui/dist/index.html"), "<html></html>", "utf8");

      expect(shouldAutoEnableUiDevMiddleware({
        entrypoint,
        projectRoot: root,
        config: createRunConfig("local_trusted"),
      })).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses static UI for authenticated source checkouts when a built UI exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-run-ui-"));
    try {
      const entrypoint = path.join(root, "server/src/index.ts");
      fs.mkdirSync(path.join(root, "ui/dist"), { recursive: true });
      fs.writeFileSync(path.join(root, "ui/dist/index.html"), "<html></html>", "utf8");

      expect(shouldAutoEnableUiDevMiddleware({
        entrypoint,
        projectRoot: root,
        config: createRunConfig("authenticated"),
      })).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to Vite middleware for authenticated source checkouts without a built UI", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-run-ui-"));
    try {
      const entrypoint = path.join(root, "server/src/index.ts");

      expect(shouldAutoEnableUiDevMiddleware({
        entrypoint,
        projectRoot: root,
        config: createRunConfig("authenticated"),
      })).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
