import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

it("selects Claude user settings per session without sharing the opt-in across agents", async () => {
  vi.stubEnv("ACPX_CLAUDE_INCLUDE_USER_SETTINGS", "0");
  // Exercise the installed, patched ACPX serializer at its ACP request boundary.
  // The filename is pinned by acpx@0.22.0.patch, alongside this regression.
  const require = createRequire(import.meta.url);
  const moduleUrl = pathToFileURL(require.resolve("acpx/dist/queue-owner-runtime-ucHvXJ33.js")).href;
  const { J: AcpClient } = await import(moduleUrl);
  function sessionMeta(env: Record<string, string>) {
    const client = new AcpClient({
      cwd: process.cwd(), agentCommand: "claude-agent-acp", agentArgv: ["claude-agent-acp"],
      permissionMode: "approve-reads", nonInteractivePermissions: "deny",
      sessionOptions: { env },
    });
    // sessionMeta() is the `_meta` that createSession sends with session/new.
    return client.sessionMeta();
  }
  expect([
    sessionMeta({ ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1" }),
    sessionMeta({}),
  ]).toEqual([
    { claudeCode: { options: { settingSources: ["user", "project", "local"] } } },
    { claudeCode: { options: { settingSources: ["project", "local"] } } },
  ]);
  expect(process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS).toBe("0");
});
