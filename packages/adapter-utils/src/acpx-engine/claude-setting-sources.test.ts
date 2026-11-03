import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

it("selects Claude user settings per session without sharing the opt-in across agents", async () => {
  vi.stubEnv("ACPX_CLAUDE_INCLUDE_USER_SETTINGS", "0");
  // Exercise the installed, patched ACPX serializer at its ACP request boundary.
  // The filename is pinned by acpx@0.12.0.patch, alongside this regression.
  const require = createRequire(import.meta.url);
  const moduleUrl = pathToFileURL(require.resolve("acpx/dist/live-checkpoint-ClPCSdrW.js")).href;
  const { k: AcpClient } = await import(moduleUrl);
  const requests: Record<string, unknown>[] = [];
  async function createSession(env: Record<string, string>) {
    const client = new AcpClient({
      cwd: process.cwd(), agentCommand: "claude-agent-acp",
      permissionMode: "approve-reads", nonInteractivePermissions: "deny",
      sessionOptions: { env },
    });
    client.getConnection = () => ({
      newSession: async (request: Record<string, unknown>) => {
        requests.push(request);
        return { sessionId: String(requests.length) };
      },
    });
    await client.createSession();
  }
  await Promise.all([
    createSession({ ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1" }),
    createSession({}),
  ]);
  expect(requests.map((request) => request._meta)).toEqual(expect.arrayContaining([
    { claudeCode: { options: { settingSources: ["user", "project", "local"] } } },
    { claudeCode: { options: { settingSources: ["project", "local"] } } },
  ]));
  expect(process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS).toBe("0");
});
