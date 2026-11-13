import { beforeEach, describe, expect, it, vi } from "vitest";

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

// A representative CDN challenge page. The cookie and script values are
// markers: the run result must never persist them.
const COOKIE_MARKER = "CFBMCOOKIEMARKERvalue0123456789";
const CHALLENGE_HTML = [
  "<!DOCTYPE html>",
  '<html lang="en-US"><head><title>Attention Required! | Cloudflare</title>',
  `<script>window._cf_chl_opt={cvId:'3',cRay:'8f2a1b3c4d5e6f70'};document.cookie="__cf_bm=${COOKIE_MARKER}"</script>`,
  '</head><body><h1>Sorry, you have been blocked</h1>',
  '<span class="cf-footer-item">Cloudflare Ray ID: <strong class="font-semibold">8f2a1b3c4d5e6f70</strong></span>',
  "</body></html>",
].join("");

function buildProcResult(resultEvent: Record<string, unknown> | null, options: { exitCode?: number; stderr?: string; assistantText?: string } = {}) {
  return {
    exitCode: options.exitCode ?? 1,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      ...(options.assistantText
        ? [JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: options.assistantText }] } })]
        : []),
      ...(resultEvent ? [JSON.stringify({ type: "result", session_id: "claude-session-1", ...resultEvent })] : []),
    ].join("\n"),
    stderr: options.stderr ?? "",
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

function mockExecutionResult(result: ReturnType<typeof buildProcResult>) {
  runAdapterExecutionTargetProcess.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) =>
    args.includes("--version") ? { ...result, exitCode: 0, stdout: "2.1.284 (Claude Code)" } : result,
  );
}

function buildContext() {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

// The Claude CLI's terminal shape for an API failure during authentication.
const authFailure = (status: number, result: string) => ({
  subtype: "success", is_error: true, api_error_status: status, error: "authentication_failed", result,
});

describe("claude_local edge rejections are not credential failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies a Cloudflare HTML 403 as a transient edge rejection and keeps only sanitised evidence", async () => {
    mockExecutionResult(buildProcResult(authFailure(403, `Failed to authenticate. API Error: 403 ${CHALLENGE_HTML}`)));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_edge_rejected");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.resultJson?.edgeFailure).toEqual({
      status: 403,
      contentType: "text/html",
      challenge: true,
      requestId: "8f2a1b3c4d5e6f70",
      excerpt: "Attention Required! | Cloudflare",
    });
    const persisted = JSON.stringify(result);
    expect(persisted).not.toContain("<!DOCTYPE");
    expect(persisted).not.toContain("<script");
    expect(persisted).not.toContain(COOKIE_MARKER);
    expect(result.errorMessage).toMatch(/not invalid credentials/);
  });

  it("does not treat Cloudflare text wrapped in \"Failed to authenticate\" as an auth failure", async () => {
    mockExecutionResult(buildProcResult(authFailure(403, "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare")));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_edge_rejected");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.resultJson?.edgeFailure).toMatchObject({ status: 403, contentType: null, challenge: true });
  });

  it("classifies an unstructured 403 without a credential body as an edge rejection", async () => {
    mockExecutionResult(buildProcResult(authFailure(403, "Failed to authenticate. API Error: 403 Forbidden")));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_edge_rejected");
    expect(result.resultJson?.edgeFailure).toMatchObject({ status: 403, contentType: null, challenge: false });
  });

  it("classifies a non-authentication JSON 403 as an edge rejection", async () => {
    mockExecutionResult(buildProcResult(authFailure(403,
      'Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Request not allowed"}}')));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_edge_rejected");
  });

  it("keeps a genuine 401 authentication_error a credential failure", async () => {
    mockExecutionResult(buildProcResult(authFailure(401,
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}')));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.resultJson?.edgeFailure).toBeUndefined();
  });

  it("keeps a 403 with a structured authentication_error body a credential failure", async () => {
    mockExecutionResult(buildProcResult(authFailure(403,
      'Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked."}}')));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });

  it("keeps a structured authentication_error a credential failure when an edge header is also present", async () => {
    mockExecutionResult(buildProcResult(authFailure(403,
      'Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked."}}'),
      { stderr: "cf-ray: 8f2a1b3c4d5e6f70-LHR" }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.resultJson?.edgeFailure).toBeUndefined();
  });

  it("keeps a rate limit on the rate-limit lane", async () => {
    mockExecutionResult(buildProcResult({ subtype: "success", is_error: true, api_error_status: 429,
      result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}' }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_transient_upstream");
    expect(result.resultJson?.edgeFailure).toBeUndefined();
  });

  it("honours a provider Retry-After hint on an edge rejection", async () => {
    const before = Date.now();
    mockExecutionResult(buildProcResult(authFailure(403, "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare"),
      { stderr: "retry-after: 120" }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_edge_rejected");
    const retryAt = Date.parse(String(result.retryNotBefore));
    expect(retryAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(result.resultJson?.retryNotBefore).toBe(result.retryNotBefore);
  });

  it("honours a Retry-After HTTP date on an edge rejection", async () => {
    const at = new Date(Math.ceil((Date.now() + 10 * 60_000) / 1000) * 1000);
    mockExecutionResult(buildProcResult(authFailure(403, "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare"),
      { stderr: `Retry-After: ${at.toUTCString()}` }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_edge_rejected");
    expect(result.retryNotBefore).toBe(at.toISOString());
  });

  it("classifies an unparsed HTML edge page on stderr without persisting the raw output", async () => {
    mockExecutionResult(buildProcResult(null, {
      stderr: `API Error: 403 ${CHALLENGE_HTML}`,
    }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_edge_rejected");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.resultJson?.stderr).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(COOKIE_MARKER);
  });

  it("does not read login words in a successful run's transcript as an auth failure", async () => {
    // A tool printed an application's own sign-in message. The run succeeded.
    mockExecutionResult(buildProcResult({ subtype: "success", is_error: false, result: "Done." },
      { exitCode: 0, assistantText: 'app.py:309: return "Usage meters need a login. Please log in once. 401 Unauthorized"' }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBeNull();
  });

  it("does not read login words in the transcript of a run killed after its result as an auth failure", async () => {
    mockExecutionResult(buildProcResult({ subtype: "success", is_error: false, result: "Done." },
      { exitCode: 143, assistantText: "The server rejects unknown or unauthorized recipients." }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).not.toBe("claude_auth_required");
  });
});
