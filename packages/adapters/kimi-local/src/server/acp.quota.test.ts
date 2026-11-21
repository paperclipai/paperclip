import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { classifyKimiTerminalSessionFailure } from "./acp.js";
import { execute } from "./execute.js";

const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const fixture = path.join(repoRoot, "scripts/mcp-fixtures/servers/acp-echo-agent.mjs");
const roots: string[] = [];
const KIMI_FIVE_HOUR_LIMIT =
  "provider.auth_error: 403 You've reached your 5-hour usage limit. " +
  "Your quota will reset when the current 5-hour window ends.";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

// Runs through the adapter's default engine (no `engine` set, so ACP).
async function executeFailure(title: string, category: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kimi-acp-quota-"));
  roots.push(root);
  const logs: string[] = [];
  const result = await execute({
    runId: "typed-quota",
    agent: { id: "quota-agent", companyId: "quota-company" },
    runtime: {},
    config: {
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixture.replaceAll("\\", "/"))}`,
      mode: "oneshot",
      warmHandleIdleMs: 0,
      cwd: repoRoot,
      stateDir: path.join(root, "state"),
      env: {
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

it.each(["access", "limit"])(
  "sends a typed Kimi usage-limit failure (%s) on the default engine to quota recovery",
  async (category) => {
    const { result } = await executeFailure(KIMI_FIVE_HOUR_LIMIT, category);
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
    });
    // Kimi prints no reset time; the recovery service applies its default backoff.
    expect(result.retryNotBefore).toBeUndefined();
  },
);

it.each([
  ["provider.auth_error: 403 Forbidden", "access"],
  ["Context window limit exceeded", "limit"],
  ["You've reached your context limit", "limit"],
  ["Rate limit exceeded; retry later", "limit"],
  [KIMI_FIVE_HOUR_LIMIT, "request"],
])("keeps a non-quota typed Kimi failure out of quota recovery: %s (%s)", async (title, category) => {
  const { result } = await executeFailure(title, category);
  expect(result).toMatchObject({ exitCode: 1, errorCode: "acpx_turn_failed" });
  expect(result.errorFamily).not.toBe("provider_quota");
});

it("does not infer quota from the generic terminal-limit message", () => {
  expect(classifyKimiTerminalSessionFailure({
    category: "limit",
    title: "ACP agent reported a terminal limit failure.",
  })).toBeNull();
});

it("reads the usage-limit wording from terminal details", () => {
  expect(classifyKimiTerminalSessionFailure({
    category: "access",
    title: "Kimi could not complete the turn",
    details: KIMI_FIVE_HOUR_LIMIT,
  })).toEqual({ errorCode: "provider_quota", errorFamily: "provider_quota" });
});
