import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { classifyClaudeTerminalSessionFailure, createClaudeAcpExecutor } from "./acp.js";
import type { AcpxEngineExecutorOptions } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";

const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const fixture = path.join(repoRoot, "scripts/mcp-fixtures/servers/acp-echo-agent.mjs");
const roots: string[] = [];
const now = new Date("2026-07-15T20:00:00.000Z");
// Exercise both pinned dependency patches through the same real ACP child.
const runnerRequire = createRequire(path.join(repoRoot, "packages/paperclip-runner/package.json"));
const runnerAcpx = await import(runnerRequire.resolve("acpx/runtime"));

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function executeFailure(
  title: string,
  category = "limit",
  mode = "oneshot",
  createRuntime?: AcpxEngineExecutorOptions["createRuntime"],
  extraEnv: Record<string, string> = {},
  details?: string,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-acp-quota-"));
  roots.push(root);
  const failureFile = path.join(root, "failure.json");
  await fs.writeFile(failureFile, JSON.stringify({ title, category, details }));
  const logs: string[] = [];
  const execute = createClaudeAcpExecutor({ now: () => now.getTime(), createRuntime });
  const result = await execute({
    runId: "typed-quota",
    agent: { id: "quota-agent", companyId: "quota-company" },
    runtime: {},
    config: {
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixture.replaceAll("\\", "/"))}`,
      mode,
      warmHandleIdleMs: 0,
      cwd: repoRoot,
      stateDir: path.join(root, "state"),
      env: {
        ...extraEnv,
        PAPERCLIP_ACPX_TYPED_FAILURE_FILE: failureFile,
      },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);
  return { result, logs: logs.join("\n") };
}

it.each([
  ["0.12.0", "oneshot"],
  ["0.12.0", "persistent"],
  ["0.13.1", "oneshot"],
  ["0.13.1", "persistent"],
])("waits for a typed Claude quota reset with ACPX %s in %s mode with provider diagnostics", async (version, mode) => {
  const title = "You've hit your session limit · resets 4:30pm (America/Chicago)";
  const { result, logs } = await executeFailure(
    title, "limit", mode, version === "0.13.1" ? runnerAcpx.createAcpRuntime : undefined,
  );
  expect(result).toMatchObject({
    exitCode: 1,
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    retryNotBefore: "2026-07-15T21:30:00.000Z",
    resultJson: {
      errorFamily: "provider_quota",
      retryNotBefore: "2026-07-15T21:30:00.000Z",
      providerQuotaRetryNotBefore: "2026-07-15T21:30:00.000Z",
    },
  });
  expect(result.errorMessage).toContain(title);
  expect(result.resultJson?.terminalSessionFailure).toMatchObject({ title });
  expect(result.summary).not.toContain(title);
  expect(logs).toContain(title);
});

it.each([
  ["0.12.0", "oneshot"],
  ["0.12.0", "persistent"],
  ["0.13.1", "oneshot"],
  ["0.13.1", "persistent"],
])("retains redacted service diagnostics beyond 4 KiB with ACPX %s in %s mode", async (version, mode) => {
  const secret = "opaque-provider-credential-canary";
  const inheritedSecret = "opaque-inherited-proxy-canary";
  // HTTP_PROXY is inherited by the real ACP launch but has no secret-name hint.
  vi.stubEnv("HTTP_PROXY", inheritedSecret);
  const title = "HTTP 529: overloaded_error";
  const details = `${"provider context\n".repeat(300)}request_id=req_service_123\nCredential echoed: ${secret}\nInherited credential: ${inheritedSecret}\n    at prompt (agent.js:42:7)`;
  const { result, logs } = await executeFailure(
    title, "service", mode, version === "0.13.1" ? runnerAcpx.createAcpRuntime : undefined,
    { PROVIDER_SETTING: secret }, details,
  );
  expect(result).toMatchObject({
    exitCode: 1,
    errorCode: "acpx_turn_failed",
    resultJson: {
      terminalSessionFailure: {
        category: "service",
        title,
        details: details.replace(secret, "***REDACTED***").replace(inheritedSecret, "***REDACTED***"),
      },
    },
  });
  expect(result.errorMessage).toContain("request_id=req_service_123");
  expect(result.errorMessage).toContain("at prompt (agent.js:42:7)");
  expect(result.summary).not.toContain(title);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(logs).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(inheritedSecret);
  expect(logs).not.toContain(inheritedSecret);
  const transcript = logs.split("\n").flatMap((line) => parseAcpxStdoutLine(line, "2026-07-15T20:00:00Z"));
  expect(transcript).toContainEqual(expect.objectContaining({ kind: "stderr", text: result.errorMessage }));
  expect(transcript.some((entry) => entry.kind === "assistant")).toBe(false);
});

it("classifies quota without a reset time for the existing recovery backoff", async () => {
  const { result } = await executeFailure("You've hit your weekly limit");
  expect(result).toMatchObject({ errorCode: "provider_quota", errorFamily: "provider_quota" });
  expect(result.retryNotBefore).toBeUndefined();
});

it.each([
  ["0.12.0", "oneshot"],
  ["0.12.0", "persistent"],
  ["0.13.1", "oneshot"],
  ["0.13.1", "persistent"],
])("recognizes the Claude bridge quota fallback with ACPX %s in %s mode", async (version, mode) => {
  // @agentclientprotocol/claude-agent-acp's quota_exhausted fallback title.
  const title = "The Claude account has no available quota.";
  const { result, logs } = await executeFailure(
    title, "limit", mode, version === "0.13.1" ? runnerAcpx.createAcpRuntime : undefined,
  );
  expect(result).toMatchObject({
    exitCode: 1,
    errorMessage: `ACP agent reported a terminal limit failure.\n${title}`,
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    resultJson: { errorFamily: "provider_quota" },
  });
  expect(result.retryNotBefore).toBeUndefined();
  expect(result.errorMessage).toContain(title);
  expect(result.resultJson?.terminalSessionFailure).toMatchObject({ category: "limit", title });
  expect(result.summary).not.toContain(title);
  expect(logs).toContain(title);
});

it.each([
  ["Context window limit exceeded", "limit"],
  ["Maximum number of turns reached", "limit"],
  ["Configured budget limit reached", "limit"],
  ["Rate limit exceeded; retry later", "limit"],
  ["You've hit your session limit", "request"],
  ["The Claude account has no available quota.", "request"],
  ["The Claude account has available quota.", "limit"],
  ["The worker connection closed", "connection"],
])("keeps a non-quota typed failure out of quota recovery: %s", async (title, category) => {
  const { result, logs } = await executeFailure(title, category);
  expect(result).toMatchObject({ exitCode: 1, errorCode: "acpx_turn_failed" });
  expect(result.errorFamily).not.toBe("provider_quota");
  expect(result.retryNotBefore).toBeUndefined();
  expect(result.errorMessage).toContain(title);
  expect(result.resultJson?.terminalSessionFailure).toMatchObject({ category, title });
  expect(result.summary).not.toContain(title);
  expect(logs).toContain(title);
});

it("classifies a typed spend limit as quota without the weekly limit's reset time", () => {
  expect(classifyClaudeTerminalSessionFailure({
    category: "limit",
    title: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets Oct 7, 5am (America/Toronto)",
  }, now)).toEqual({ errorCode: "provider_quota", errorFamily: "provider_quota", providerQuotaResetUnknown: true });
});

it("marks a typed spend limit as having no reset time in the run result", async () => {
  const title = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 4:30pm (America/Chicago)";
  const { result } = await executeFailure(title);
  expect(result).toMatchObject({
    exitCode: 1,
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    resultJson: { errorFamily: "provider_quota", providerQuotaResetUnknown: true },
  });
  expect(result.retryNotBefore).toBeUndefined();
  expect(result.resultJson?.providerQuotaRetryNotBefore).toBeUndefined();
});

it("does not mark a typed session limit as having no reset time", async () => {
  const { result } = await executeFailure("You've hit your session limit · resets 4:30pm (America/Chicago)");
  expect(result.retryNotBefore).toBe("2026-07-15T21:30:00.000Z");
  expect(result.resultJson?.providerQuotaResetUnknown).toBeUndefined();
});

it("does not infer quota from the historical generic terminal-limit error", () => {
  expect(classifyClaudeTerminalSessionFailure({
    category: "limit",
    title: "ACP agent reported a terminal limit failure.",
  }, now)).toBeNull();
});

it.each([
  "Failed to authenticate. API Error: 401 Invalid bearer token",
  "OAuth token has expired. Please obtain a new token or refresh your existing token.",
  "Authentication required. Please run claude login.",
  "Sign in to continue using Claude.",
  "ACP agent reported a terminal access failure.",
])("routes a typed provider login rejection to sign-in recovery: %s", async (title) => {
  const { result } = await executeFailure(title, "access");
  expect(result).toMatchObject({ exitCode: 1, errorCode: "claude_auth_required" });
  if (title === "ACP agent reported a terminal access failure.") expect(result.errorMessage).toBe("Claude sign-in failed. Sign in again and try again.");
  expect(result.errorFamily).not.toBe("provider_quota");
});

it.each([
  "Permission denied while opening workspace file.",
  "Tool authorization denied.",
])("does not treat a tool or workspace request failure as a login rejection: %s", (title) => {
  expect(classifyClaudeTerminalSessionFailure({ category: "request", title }, now)).toBeNull();
});
