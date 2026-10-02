import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { classifyCodexTerminalSessionFailure, createCodexAcpExecutor } from "./acp.js";
import type { AcpxEngineExecutorOptions } from "@paperclipai/adapter-utils/acpx-engine/execute";

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
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-acp-quota-"));
  roots.push(root);
  const logs: string[] = [];
  const execute = createCodexAcpExecutor({ now: () => now.getTime(), createRuntime });
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
        CODEX_HOME: path.join(root, "codex-home"),
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
])("waits for a typed Codex quota reset with ACPX %s in %s mode without exposing provider text", async (version, mode) => {
  const title = "You've hit your usage limit for GPT-5. Switch to another model now, or try again at 4:30 PM (America/Chicago).";
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
  expect(JSON.stringify(result)).not.toContain(title);
  expect(logs).not.toContain(title);
});

it("classifies quota without a reset time for the existing recovery backoff", async () => {
  const title = "You've hit your usage limit. Visit https://example.invalid/usage for account details.";
  const { result, logs } = await executeFailure(title);
  expect(result).toMatchObject({ errorCode: "provider_quota", errorFamily: "provider_quota" });
  expect(result.retryNotBefore).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(title);
  expect(logs).not.toContain(title);
});

it.each([
  ["Context window limit exceeded", "limit"],
  ["Maximum number of turns reached", "limit"],
  ["Configured budget limit reached", "limit"],
  ["Rate limit exceeded; retry later", "limit"],
  ["You've hit your usage limit", "request"],
  ["Context window capacity limit reached", "limit"],
  ["Workspace storage capacity limit reached", "limit"],
  ["The account has available quota", "limit"],
  ["The worker connection closed", "connection"],
])("keeps a non-quota typed failure out of quota recovery: %s", async (title, category) => {
  const { result, logs } = await executeFailure(title, category);
  expect(result).toMatchObject({ exitCode: 1, errorCode: "acpx_turn_failed" });
  expect(result.errorFamily).not.toBe("provider_quota");
  expect(result.retryNotBefore).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(title);
  expect(logs).not.toContain(title);
});

it("does not infer quota from the historical generic terminal-limit error", () => {
  expect(classifyCodexTerminalSessionFailure({
    category: "limit",
    title: "ACP agent reported a terminal limit failure.",
  }, now)).toBeNull();
});

it("reads usage exhaustion and its reset clock from terminal details", () => {
  expect(classifyCodexTerminalSessionFailure({
    category: "limit",
    title: "Codex could not complete the turn",
    details: "You've hit your usage limit for GPT-5. Switch to another model now, or try again at 4:30 PM (America/Chicago).",
  }, now)).toEqual({
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    retryNotBefore: "2026-07-15T21:30:00.000Z",
  });
});

it.each(["Usage limit reached", "Usage limit exceeded", "You’ve hit your usage limit"])(
  "classifies explicit usage exhaustion without a reset clock: %s", (title) => {
    expect(classifyCodexTerminalSessionFailure({ category: "limit", title }, now))
      .toEqual({ errorCode: "provider_quota", errorFamily: "provider_quota" });
  },
);
