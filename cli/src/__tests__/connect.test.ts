import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prompts from "@clack/prompts";
import { registerConnectCommand } from "../commands/client/connect.js";
import { loginBoardCli } from "../client/board-auth.js";

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  text: vi.fn(),
  select: vi.fn(),
}));

vi.mock("../client/board-auth.js", () => ({
  loginBoardCli: vi.fn(),
}));

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const API_BASE = "http://127.0.0.1:3197";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerConnectCommand(program);
  return program;
}

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

function createTempContextPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-connect-test-")), "context.json");
}

function readContext(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    currentProfile: string;
    profiles: Record<string, Record<string, unknown>>;
  };
}

describe("connect command", () => {
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;

  beforeEach(() => {
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    vi.restoreAllMocks();
    vi.mocked(loginBoardCli).mockResolvedValue({
      token: "board-login-token",
      approvalUrl: `${API_BASE}/cli-auth/challenge-1`,
      userId: "user-1",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it("drives the interactive board profile flow through prompts and context writes", async () => {
    const contextPath = createTempContextPath();
    vi.mocked(prompts.text).mockResolvedValue(API_BASE);
    vi.mocked(prompts.select).mockResolvedValue(COMPANY_ID);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/api/companies") {
        return jsonResponse([{ id: COMPANY_ID, name: "Connect Co" }]);
      }
      if (url.pathname === "/api/board-api-keys" && init?.method === "POST") {
        return jsonResponse({
          id: "board-key-1",
          name: "connect-board-token",
          token: "pcp_board_created",
          createdAt: "2026-05-24T12:00:00.000Z",
          expiresAt: null,
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method ?? "GET"} ${url.pathname}` }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createProgram().parseAsync([
      "connect",
      "--persona",
      "board",
      "--profile",
      "cli-board",
      "--token-name",
      "connect-board-token",
      "--context",
      contextPath,
      "--api-base",
      API_BASE,
      "--json",
    ], { from: "user" });

    expect(loginBoardCli).toHaveBeenCalledWith(expect.objectContaining({
      apiBase: API_BASE,
      requestedAccess: "board",
      command: "paperclipai connect",
    }));
    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", new URL(String(call[0])).pathname])).toEqual([
      ["GET", "/api/health"],
      ["GET", "/api/companies"],
      ["POST", "/api/board-api-keys"],
    ]);
    expect(readContext(contextPath)).toMatchObject({
      currentProfile: "cli-board",
      profiles: {
        "cli-board": {
          apiBase: API_BASE,
          companyId: COMPANY_ID,
          persona: "board",
          tokenId: "board-key-1",
          tokenName: "connect-board-token",
        },
      },
    });
  });

  it("drives the interactive agent profile flow through prompts and context writes", async () => {
    const contextPath = createTempContextPath();
    vi.mocked(prompts.text).mockResolvedValue(API_BASE);
    vi.mocked(prompts.select).mockResolvedValue(AGENT_ID);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/api/companies") {
        return jsonResponse([{ id: COMPANY_ID, name: "Connect Co" }]);
      }
      if (url.pathname === `/api/companies/${COMPANY_ID}/agents`) {
        return jsonResponse([{ id: AGENT_ID, name: "Connect Agent", role: "Operator" }]);
      }
      if (url.pathname === `/api/agents/${AGENT_ID}/keys` && init?.method === "POST") {
        return jsonResponse({
          id: "agent-key-1",
          name: "connect-agent-token",
          token: "pcp_agent_created",
          createdAt: "2026-05-24T12:00:00.000Z",
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method ?? "GET"} ${url.pathname}` }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createProgram().parseAsync([
      "connect",
      "--persona",
      "agent",
      "--profile",
      "cli-agent",
      "--token-name",
      "connect-agent-token",
      "--context",
      contextPath,
      "--api-base",
      API_BASE,
      "--json",
    ], { from: "user" });

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", new URL(String(call[0])).pathname])).toEqual([
      ["GET", "/api/health"],
      ["GET", "/api/companies"],
      ["GET", `/api/companies/${COMPANY_ID}/agents`],
      ["POST", `/api/agents/${AGENT_ID}/keys`],
    ]);
    expect(readContext(contextPath)).toMatchObject({
      currentProfile: "cli-agent",
      profiles: {
        "cli-agent": {
          apiBase: API_BASE,
          companyId: COMPANY_ID,
          persona: "agent",
          agentId: AGENT_ID,
          agentName: "Connect Agent",
          tokenId: "agent-key-1",
          tokenName: "connect-agent-token",
        },
      },
    });
  });
});
