import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prompts from "@clack/prompts";
import { registerConnectCommand } from "../commands/client/connect.js";
import { registerAgentCommands } from "../commands/client/agent.js";
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
const OLD_INSTANCE = "http://127.0.0.1:3100";
const NEW_INSTANCE = "http://127.0.0.1:3197";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function createProgram(register: (program: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  register(program);
  return program;
}

function printedExports(log: ReturnType<typeof vi.spyOn>): string {
  for (const call of log.mock.calls) {
    try {
      const parsed = JSON.parse(String(call[0])) as { exports?: unknown };
      if (typeof parsed.exports === "string") return parsed.exports;
    } catch {
      continue;
    }
  }
  throw new Error("command printed no exports");
}

// Applies the printed exports in a real shell that still carries the old
// instance's runtime URL, and returns the URL the next CLI command resolves.
function runtimeUrlAfterApplying(exportsText: string): string {
  const result = spawnSync("sh", ["-c", `${exportsText}\nprintf '%s' "$PAPERCLIP_RUNTIME_API_URL"`], {
    env: { PATH: process.env.PATH ?? "", PAPERCLIP_RUNTIME_API_URL: OLD_INSTANCE },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("connection exports when the shell already carries PAPERCLIP_RUNTIME_API_URL", () => {
  const originalRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
    vi.mocked(loginBoardCli).mockResolvedValue({
      token: "board-login-token",
      approvalUrl: `${NEW_INSTANCE}/cli-auth/challenge-1`,
      userId: "user-1",
    });
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalRuntimeApiUrl === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
    else process.env.PAPERCLIP_RUNTIME_API_URL = originalRuntimeApiUrl;
  });

  it("connect exports move the runtime URL to the newly selected instance", async () => {
    const contextPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-connect-exports-")), "context.json");
    vi.mocked(prompts.text).mockResolvedValue(NEW_INSTANCE);
    vi.mocked(prompts.select).mockResolvedValue(AGENT_ID);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/health") return jsonResponse({ status: "ok" });
      if (url.pathname === "/api/companies") return jsonResponse([{ id: COMPANY_ID, name: "Connect Co" }]);
      if (url.pathname === `/api/companies/${COMPANY_ID}/agents`) {
        return jsonResponse([{ id: AGENT_ID, name: "Connect Agent", role: "Operator" }]);
      }
      return jsonResponse({ id: "agent-key-1", name: "connect-agent-token", token: "pcp_agent_created", createdAt: "2026-05-24T12:00:00.000Z" });
    }));

    await createProgram(registerConnectCommand).parseAsync([
      "connect", "--persona", "agent", "--profile", "cli-agent", "--token-name", "connect-agent-token",
      "--context", contextPath, "--api-base", NEW_INSTANCE, "--json",
    ], { from: "user" });

    expect(runtimeUrlAfterApplying(printedExports(log))).toBe(NEW_INSTANCE);
    fs.rmSync(path.dirname(contextPath), { recursive: true, force: true });
  });

  it("agent local-cli exports move the runtime URL to the selected instance", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `/api/agents/${AGENT_ID}`) {
        return jsonResponse({ id: AGENT_ID, name: "Local Agent", urlKey: "local-agent", companyId: COMPANY_ID });
      }
      return jsonResponse({ id: "agent-key-2", name: "local-cli", token: "pcp_local_created", createdAt: "2026-05-24T12:00:00.000Z" });
    }));

    await createProgram(registerAgentCommands).parseAsync([
      "agent", "local-cli", AGENT_ID, "-C", COMPANY_ID, "--no-install-skills", "--api-base", NEW_INSTANCE,
      "--api-key", "pcp_board_fixture", "--json",
    ], { from: "user" });

    expect(runtimeUrlAfterApplying(printedExports(log))).toBe(NEW_INSTANCE);
  });
});
