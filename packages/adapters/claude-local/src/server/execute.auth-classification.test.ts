import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseJson } from "@paperclipai/adapter-utils/server-utils";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";
import {
  detectClaudeLoginRequired,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";

type Event = Record<string, unknown>;

const SESSION = "00000000-0000-4000-8000-000000000001";
const jsonl = (...events: Event[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const init: Event = { type: "system", subtype: "init", session_id: SESSION, model: "claude-sonnet" };
const toolUse = (id: string, command: string): Event => ({
  type: "assistant",
  session_id: SESSION,
  message: { id: `msg_${id}`, content: [{ type: "tool_use", id: `toolu_${id}`, name: "Bash", input: { command } }] },
});
const toolResult = (id: string, content: string): Event => ({
  type: "user",
  session_id: SESSION,
  message: { content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content }] },
});
const assistantText = (id: string, text: string): Event => ({
  type: "assistant",
  session_id: SESSION,
  message: { id: `msg_${id}`, content: [{ type: "text", text }] },
});
const result = (fields: Event): Event => ({ type: "result", session_id: SESSION, ...fields });
const success = (text = "Done."): Event => result({ subtype: "success", is_error: false, result: text });
const failure = (text: string, status?: number): Event =>
  result({ subtype: "success", is_error: true, result: text, ...(status ? { api_error_status: status } : {}) });

const CLEANUP = {
  kind: "terminal_result_cleanup",
  stopped: true,
  stopReason: "unmanaged_background_task_stopped",
  reason: "unmanaged background task stopped; no durable live path",
  terminalResultSeen: true,
  signal: "SIGTERM",
  forceKilled: false,
};

const SKILL_TEXT = "The server rejects unknown or unauthorized recipients.";
const GH_TEXT = "You are not logged into any GitHub hosts. To log in, run: gh auth login";
const NOISY_TOOLS = [
  toolUse("n1", "cat skills/messaging/SKILL.md"),
  toolResult("n1", SKILL_TEXT),
  toolUse("n2", "curl -s https://api.example.test/v1/items"),
  toolResult("n2", "HTTP/1.1 401 Unauthorized\nauthentication required"),
  toolUse("n3", "gh auth status"),
  toolResult("n3", GH_TEXT),
];

const LONG_TOOL_LINE = JSON.stringify(
  toolResult("t1", "HTTP 401 Unauthorized from internal service; please log in again. " + "x".repeat(400)),
);
const headCut = (text: string) => text.slice(text.indexOf("Unauthorized") - 4);
const tailCut = (line: string) => line.slice(0, line.indexOf("Unauthorized") + 30);

const AUTH_401 =
  'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}';
const AUTH_EXPIRED =
  'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}';
const AUTH_REVOKED_403 =
  'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"OAuth token has been revoked"}}';

type Expect =
  | { code: string | null }
  | { notAuth: true };

interface Case {
  id: string;
  title: string;
  stdout: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: string | null;
  cleanup?: boolean;
  auth?: boolean;
  transient?: boolean;
  quota?: boolean;
  execute: Expect;
}

const cases: Case[] = [
  {
    id: "S1",
    title: "success, skill text 'unauthorized recipients' in tool output",
    stdout: jsonl(init, toolUse("a", "cat SKILL.md"), toolResult("a", SKILL_TEXT), success()),
    exitCode: 0,
    auth: false,
    execute: { code: null },
  },
  {
    id: "S2",
    title: "success, 'authentication required' and 401 Unauthorized in tool output",
    stdout: jsonl(init, toolUse("a", "curl"), toolResult("a", "HTTP/1.1 401 Unauthorized\nauthentication required"), success()),
    exitCode: 0,
    auth: false,
    execute: { code: null },
  },
  {
    id: "S3",
    title: "success, 'not logged into any GitHub hosts' in tool output",
    stdout: jsonl(init, toolUse("a", "gh auth status"), toolResult("a", GH_TEXT), success()),
    exitCode: 0,
    auth: false,
    execute: { code: null },
  },
  {
    id: "S4",
    title: "success, assistant prose 'Please log in'",
    stdout: jsonl(init, assistantText("a", "Please log in to the dashboard to see the report."), success()),
    exitCode: 0,
    auth: false,
    execute: { code: null },
  },
  {
    id: "S5",
    title: "success, final answer text quotes 'unauthorized'",
    stdout: jsonl(init, success("Fixed the 401 Unauthorized handler in the API client.")),
    exitCode: 0,
    auth: false,
    execute: { code: null },
  },
  {
    id: "S6",
    title: "success exit 0, stderr carries '401 Unauthorized' from a hook",
    stdout: jsonl(init, success()),
    stderr: "hook: upstream returned 401 Unauthorized",
    exitCode: 0,
    execute: { code: null },
  },
  {
    id: "A1",
    title: "failed result 'Not logged in · Please run /login'",
    stdout: jsonl(init, failure("Not logged in · Please run /login")),
    exitCode: 1,
    auth: true,
    transient: false,
    execute: { code: "claude_auth_required" },
  },
  {
    id: "A2",
    title: "failed result 401 authentication_error",
    stdout: jsonl(init, ...NOISY_TOOLS, failure(AUTH_401, 401)),
    exitCode: 1,
    auth: true,
    transient: false,
    execute: { code: "claude_auth_required" },
  },
  {
    id: "A3",
    title: "failed result 401 OAuth token has expired",
    stdout: jsonl(init, failure(AUTH_EXPIRED, 401)),
    exitCode: 1,
    auth: true,
    transient: false,
    execute: { code: "claude_auth_required" },
  },
  {
    id: "A4",
    title: "failed result 403 OAuth token has been revoked",
    stdout: jsonl(init, failure(AUTH_REVOKED_403, 403)),
    exitCode: 1,
    auth: true,
    transient: false,
    execute: { code: "claude_auth_required" },
  },
  {
    id: "A5",
    title: "no result, stderr 'Invalid API key · Please run /login'",
    stdout: "",
    stderr: "Invalid API key · Please run /login",
    exitCode: 1,
    auth: true,
    execute: { code: "claude_auth_required" },
  },
  {
    id: "A6",
    title: "no result, plain stdout 'Not logged in · Please run /login'",
    stdout: "Not logged in · Please run /login\n",
    exitCode: 1,
    auth: true,
    execute: { code: "claude_auth_required" },
  },
  {
    id: "A7",
    title: "failed generic result, stderr 'Not logged in · Please run /login'",
    stdout: jsonl(init, failure("Claude exited unexpectedly")),
    stderr: "Not logged in · Please run /login",
    exitCode: 1,
    auth: true,
    execute: { code: "claude_auth_required" },
  },
  {
    id: "M1",
    title: "success, truncated first stdout line cut inside tool text",
    stdout: headCut(LONG_TOOL_LINE + "\n" + jsonl(success())),
    exitCode: 0,
    auth: false,
    execute: { code: null },
  },
  {
    id: "M2",
    title: "failed non-auth result, truncated first stdout line cut inside tool text",
    stdout: headCut(LONG_TOOL_LINE + "\n" + jsonl(failure("API Error: 500 Internal server error"))),
    exitCode: 1,
    auth: false,
    execute: { notAuth: true },
  },
  {
    id: "M3",
    title: "no result, partial last line of a killed process (starts with '{')",
    stdout: jsonl(init, toolUse("a", "curl")) + tailCut(LONG_TOOL_LINE),
    exitCode: 1,
    signal: "SIGKILL",
    auth: false,
    execute: { notAuth: true },
  },
  {
    id: "M6",
    title: "no result, empty stdout and stderr, exit 1",
    stdout: "",
    exitCode: 1,
    auth: false,
    execute: { notAuth: true },
  },
  {
    id: "T1",
    title: "error_max_turns with auth words in tool output",
    stdout: jsonl(init, ...NOISY_TOOLS, result({ subtype: "error_max_turns", is_error: true })),
    exitCode: 1,
    auth: false,
    execute: { code: "max_turns_exhausted" },
  },
  {
    id: "T2",
    title: "error_max_turns whose result carries model prose 'please log in'",
    stdout: jsonl(init, result({ subtype: "error_max_turns", is_error: true, result: "Next step: please log in to the admin console." })),
    exitCode: 1,
    auth: false,
    execute: { code: "max_turns_exhausted" },
  },
  {
    id: "T3",
    title: "session limit with auth words in tool output",
    stdout: jsonl(init, ...NOISY_TOOLS, failure("You've hit your session limit · resets 5pm (UTC)")),
    exitCode: 1,
    auth: false,
    quota: true,
    execute: { code: "provider_quota" },
  },
  {
    id: "T4",
    title: "usage limit, no noise (control)",
    stdout: jsonl(init, failure("Claude usage limit reached. Your limit will reset at 5pm.")),
    exitCode: 1,
    auth: false,
    quota: true,
    execute: { code: "provider_quota" },
  },
  {
    id: "R1",
    title: "429 rate_limit_error with auth words in tool output",
    stdout: jsonl(init, ...NOISY_TOOLS, failure('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}', 429)),
    exitCode: 1,
    auth: false,
    transient: true,
    quota: false,
    execute: { code: "claude_transient_upstream" },
  },
  {
    id: "R2",
    title: "503 service unavailable with auth words in tool output",
    stdout: jsonl(init, ...NOISY_TOOLS, failure("API Error: 503 Service Unavailable", 503)),
    exitCode: 1,
    auth: false,
    transient: true,
    execute: { code: "claude_transient_upstream" },
  },
  {
    id: "R3",
    title: "529 overloaded_error with auth words in tool output",
    stdout: jsonl(init, ...NOISY_TOOLS, failure('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 529)),
    exitCode: 1,
    auth: false,
    transient: true,
    execute: { code: "claude_transient_upstream" },
  },
  {
    id: "R4",
    title: "529 overloaded, no noise (control)",
    stdout: jsonl(init, failure('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 529)),
    exitCode: 1,
    auth: false,
    transient: true,
    execute: { code: "claude_transient_upstream" },
  },
  {
    id: "C1",
    title: "SIGTERM cleanup after success, exit 143, auth words in tool output",
    stdout: jsonl(init, ...NOISY_TOOLS, success("Started a background monitor.")),
    exitCode: 143,
    cleanup: true,
    auth: false,
    execute: { code: null },
  },
  {
    id: "C2",
    title: "SIGTERM cleanup after success, signal only (exit null)",
    stdout: jsonl(init, ...NOISY_TOOLS, success("Started a background monitor.")),
    exitCode: null,
    signal: "SIGTERM",
    cleanup: true,
    auth: false,
    execute: { code: null },
  },
  {
    id: "C3",
    title: "SIGTERM cleanup after a non-auth failure, auth words in tool output",
    stdout: jsonl(init, ...NOISY_TOOLS, failure("API Error: 500 Internal server error")),
    exitCode: 143,
    cleanup: true,
    auth: false,
    execute: { notAuth: true },
  },
  {
    id: "C4",
    title: "SIGTERM cleanup after a genuine 401 failure is still auth",
    stdout: jsonl(init, failure(AUTH_401, 401)),
    exitCode: 143,
    cleanup: true,
    auth: true,
    execute: { code: "claude_auth_required" },
  },
  {
    id: "X3",
    title: "no result, plain 'Not logged in · Please run /login' with exit 0",
    stdout: "Not logged in · Please run /login\n",
    exitCode: 0,
    auth: true,
    execute: { code: "claude_auth_required" },
  },
];

function parsedFor(stdout: string): Record<string, unknown> | null {
  return parseClaudeStreamJson(stdout).resultJson ?? parseJson(stdout);
}

function detectorInput(c: Case) {
  return {
    parsed: parsedFor(c.stdout),
    stdout: c.stdout,
    stderr: c.stderr ?? "",
    ...(c.cleanup ? { terminalResultCleanup: CLEANUP } : {}),
  };
}

describe("claude_local auth classification detectors", () => {
  for (const c of cases) {
    if (c.auth !== undefined) {
      it(`${c.id} detectClaudeLoginRequired: ${c.title}`, () => {
        expect(detectClaudeLoginRequired(detectorInput(c) as never).requiresLogin).toBe(c.auth);
      });
    }
    if (c.transient !== undefined) {
      it(`${c.id} isClaudeTransientUpstreamError: ${c.title}`, () => {
        expect(isClaudeTransientUpstreamError(detectorInput(c) as never)).toBe(c.transient);
      });
    }
    if (c.quota !== undefined) {
      it(`${c.id} isClaudeProviderQuotaError: ${c.title}`, () => {
        expect(isClaudeProviderQuotaError(detectorInput(c) as never)).toBe(c.quota);
      });
    }
  }
});

function buildContext() {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local auth classification execute errorCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const c of cases) {
    it(`${c.id} execute: ${c.title}`, async () => {
      const proc = {
        exitCode: c.exitCode === undefined ? 1 : c.exitCode,
        signal: c.signal ?? null,
        timedOut: false,
        stdout: c.stdout,
        stderr: c.stderr ?? "",
        pid: 321,
        startedAt: new Date().toISOString(),
        terminalResultCleanup: c.cleanup ? CLEANUP : null,
      };
      runAdapterExecutionTargetProcess.mockImplementation(
        async (_runId: string, _target: unknown, _command: string, args: string[]) =>
          args.includes("--version") ? { ...proc, exitCode: 0, stdout: "2.1.284 (Claude Code)", stderr: "" } : proc,
      );

      const outcome = await execute(buildContext() as never);

      if ("code" in c.execute) {
        expect(outcome.errorCode ?? null).toBe(c.execute.code);
      } else {
        expect(outcome.errorCode ?? null).not.toBe("claude_auth_required");
      }
    });
  }
});
