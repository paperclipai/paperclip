import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
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
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function executeFailure(
  title: string,
  category = "limit",
  mode = "oneshot",
  createRuntime?: AcpxEngineExecutorOptions["createRuntime"],
  extraEnv: Record<string, string> = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-acp-quota-"));
  roots.push(root);
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
        PAPERCLIP_ACPX_TYPED_FAILURE_CANARY: title,
        PAPERCLIP_ACPX_TYPED_FAILURE_CATEGORY: category,
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
  const title = "HTTP 529: overloaded_error";
  const details = `${"provider context\n".repeat(300)}request_id=req_service_123\nCredential echoed: ${secret}\n    at prompt (agent.js:42:7)`;
  const { result, logs } = await executeFailure(
    title, "service", mode, version === "0.13.1" ? runnerAcpx.createAcpRuntime : undefined,
    { PAPERCLIP_ACPX_TYPED_FAILURE_DETAILS: details, PROVIDER_API_KEY: secret },
  );
  expect(result).toMatchObject({
    exitCode: 1,
    errorCode: "acpx_turn_failed",
    resultJson: {
      terminalSessionFailure: {
        category: "service",
        title,
        details: details.replace(secret, "***REDACTED***"),
      },
    },
  });
  expect(result.errorMessage).toContain("request_id=req_service_123");
  expect(result.errorMessage).toContain("at prompt (agent.js:42:7)");
  expect(result.summary).not.toContain(title);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(logs).not.toContain(secret);
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

it("does not infer quota from the historical generic terminal-limit error", () => {
  expect(classifyClaudeTerminalSessionFailure({
    category: "limit",
    title: "ACP agent reported a terminal limit failure.",
  }, now)).toBeNull();
});
