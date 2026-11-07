import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import { evictStaleSessionRecord } from "./execute.js";

const fixture = fileURLToPath(new URL("../../../../scripts/mcp-fixtures/servers/acp-echo-agent.mjs", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acp-stale-record-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  return { root, cwd: await fs.realpath(cwd) };
}

const sessionKey = "stale-record";

function runner(store: ReturnType<typeof createRuntimeStore>, cwd: string) {
  return async (resumeSessionId?: string): Promise<string> => {
    const runtime = createAcpRuntime({
      cwd,
      sessionStore: store,
      agentRegistry: createAgentRegistry({ overrides: { custom: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixture.replaceAll("\\", "/"))}` } }),
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      inheritProcessEnv: false,
    });
    const handle = await runtime.ensureSession({
      sessionKey, agent: "custom", mode: "persistent", cwd, resumeSessionId, sessionOptions: { env: {} },
    });
    await runtime.close({ handle, reason: "done" });
    return handle.backendSessionId!;
  };
}

describe("ACPX stale session record", () => {
  it("reuses a saved session until the record is evicted, and keeps a valid resume", async () => {
    const { root, cwd } = await workspace();
    const store = createRuntimeStore({ stateDir: path.join(root, "state") });
    const run = runner(store, cwd);

    const first = await run();
    expect(await run()).toBe(first);
    expect(await run(first)).toBe(first);

    await evictStaleSessionRecord(store, sessionKey);
    const fresh = await run();
    expect(fresh).not.toBe(first);
    expect(await run(fresh)).toBe(fresh);
  });

  it("returns the old session on a fresh retry after a failed resume unless the record is evicted", async () => {
    const { root, cwd } = await workspace();
    const store = createRuntimeStore({ stateDir: path.join(root, "state") });
    const run = runner(store, cwd);

    const first = await run();
    await expect(run("missing-session")).rejects.toThrow(/cannot resume session/);
    expect(await run()).toBe(first);

    await expect(run("missing-session")).rejects.toThrow(/cannot resume session/);
    await evictStaleSessionRecord(store, sessionKey);
    expect(await run()).not.toBe(first);
  });
});
