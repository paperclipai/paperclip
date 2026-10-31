import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Db } from "@paperclipai/db";
import { CURSOR_CLOUD_DEFAULT_TIMEOUT_MS, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { createCapabilityRunnerdProviderEnvironment } from "@paperclipai/paperclip-runner/live";
import { prepareCursorCloudRuntime, resolveCursorCloudPublicOrigin } from "./cursor-cloud-runtime.js";
import { forwardRemoteMcpRequest } from "./remote-mcp-relay.js";

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const runningDb = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "running", runtimeMode: "native" }] }) }) }) } as unknown as Db;

function execution(runId: string): NativeExecutionInput {
  return { binding: { companyId: "company", agentId: "agent", issueId: "issue", runId, executionWorkspaceId: "workspace" },
    provider: { kind: "cursor_cloud", model: "explicit-model", cursorCloud: { schema: "paperclip.cursor-cloud.config.v1", repos: [{ url: "https://github.com/acme/fixture" }] } },
    session: { normalizedSessionId: "same-cloud-session", lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
  } as NativeExecutionInput;
}

async function prepare(root: string, current: NativeExecutionInput, authorityCurrent = () => true) {
  const runtime = prepareCursorCloudRuntime({ root, execution: current, db: runningDb, publicOrigin: "https://relay.example.test",
    environment: { CURSOR_API_KEY: "selected-key", OPENAI_API_KEY: "other-secret" }, authorityCurrent });
  disposers.push(runtime.unregister);
  const socketPath = runtime.environment.PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH;
  disposers.push(() => rm(dirname(socketPath), { recursive: true, force: true }));
  return runtime;
}

async function directory(): Promise<string> {
  const root = await mkdtemp("/tmp/pc-cloud-runtime-");
  disposers.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

const invoke = (runId: string, token: string) => forwardRemoteMcpRequest({ runId, authorization: `Bearer ${token}`,
  body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });

describe("Cursor Cloud controller runtime capability", () => {
  it("retains an exact recovery capability and rotates a later run without sharing either route", async () => {
    const root = await directory();
    const first = execution("first-run");
    let authority = true;
    const initial = await prepare(root, first, () => authority);
    const before = initial.environment;
    let calls = 0;
    const server = createServer((req, res) => {
      calls += 1;
      expect(req.headers.authorization).toMatch(/^Bearer [a-zA-Z0-9_-]{43}$/);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(before.PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH, resolve); });
    disposers.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    expect((await invoke(first.binding.runId, before.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN)).status).toBe(401);
    initial.register();
    expect((await invoke(first.binding.runId, before.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN)).status).toBe(200);
    authority = false;
    expect((await invoke(first.binding.runId, before.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN)).status).toBe(403);
    initial.unregister();
    const exact = await prepare(root, first);
    expect(exact.environment.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN).toBe(before.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN);
    exact.register(); exact.unregister();
    const next = execution("next-run");
    const subsequent = await prepare(root, next);
    const after = subsequent.environment;
    expect(after.PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH).toBe(before.PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH);
    expect(after.PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH).toBe(before.PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH);
    expect(after.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN).not.toBe(before.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN);
    expect(after.PAPERCLIP_CURSOR_CLOUD_RELAY_URL).toBe("https://relay.example.test/mcp/native-runs/next-run");
    subsequent.register();
    expect((await invoke(next.binding.runId, before.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN)).status).toBe(401);
    expect((await invoke(first.binding.runId, before.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN)).status).toBe(401);
    expect((await invoke(next.binding.runId, after.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN)).status).toBe(200);
    expect(calls).toBe(2);
    const projected = createCapabilityRunnerdProviderEnvironment({ provider: "cursor_cloud", options: { environment: after } as never,
      identity: { runnerInstanceId: "controller", environmentLeaseId: "workspace", runId: next.binding.runId,
        normalizedSessionId: next.session.normalizedSessionId!, turnId: "turn", itemId: "item" },
      codexHome: "/unused", runtimeContextPath: "/unused", hasRuntimeContext: false });
    expect(projected.PAPERCLIP_RUN_ID).toBe("next-run");
    expect(projected.PAPERCLIP_NORMALIZED_SESSION_ID).toBe("same-cloud-session");
    expect(projected.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN).toBe(after.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN);
    expect(projected).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("uses the full default deadline and preserves expired identity for cleanup while denying ordinary admission", async () => {
    const root = await directory();
    const current = execution("expiry-run");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const initial = await prepare(root, current);
    const capabilityPath = join(root, "cursor-cloud", "relay-capability.json");
    const capability = JSON.parse(await readFile(capabilityPath, "utf8"));
    expect(capability.expiresAt).toBe(now + CURSOR_CLOUD_DEFAULT_TIMEOUT_MS + 120_000);
    expect(initial.environment.PAPERCLIP_CURSOR_CLOUD_RELAY_EXPIRES_AT).toBe(String(capability.expiresAt));
    expect((await stat(capabilityPath)).mode & 0o077).toBe(0);
    expect(await readFile(initial.environment.PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH, "utf8")).not.toContain("selected-key");
    clock.mockReturnValue(capability.expiresAt + 1);
    const recovered = await prepare(root, current);
    expect(recovered.environment.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN).toBe(capability.token);
    expect(() => recovered.register()).toThrow("expired");
    recovered.register({ cleanupOnly: true });
    expect((await invoke(current.binding.runId, capability.token)).status).toBe(401);
  });

  it("derives the relay origin from normal auth public URL configuration", () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "https://normal-public-origin.example.test");
    expect(resolveCursorCloudPublicOrigin()).toBe("https://normal-public-origin.example.test");
  });
});
