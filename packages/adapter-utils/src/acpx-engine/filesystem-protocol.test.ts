import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";

const runnerRuntimePath = createRequire(new URL("../../../paperclip-runner/package.json", import.meta.url)).resolve("acpx/runtime");
const nativeRuntime = await import(runnerRuntimePath) as typeof import("acpx/runtime");
const runtimes = [
  { version: "0.12.0", api: { createAcpRuntime, createAgentRegistry, createRuntimeStore } },
  { version: "0.13.1", api: nativeRuntime },
];
const roots: string[] = [];
const fixture = fileURLToPath(new URL("../../../../scripts/mcp-fixtures/servers/acp-filesystem-agent.mjs", import.meta.url));
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acp-filesystem-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  return { root, cwd: await fs.realpath(cwd) };
}

async function drive(api: (typeof runtimes)[number]["api"], input: {
  cwd: string;
  root: string;
  permissionMode?: "approve-all" | "deny-all";
  operations: Array<{ method: string; path: string; content?: string }>;
}) {
  let stderr = "";
  const runtime = api.createAcpRuntime({
    cwd: input.cwd,
    sessionStore: api.createRuntimeStore({ stateDir: path.join(input.root, "state") }),
    agentRegistry: api.createAgentRegistry({ overrides: { custom: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixture.replaceAll("\\", "/"))}` } }),
    permissionMode: input.permissionMode ?? "approve-all",
    nonInteractivePermissions: "deny",
    inheritProcessEnv: false,
    onAgentStderr: (chunk: string) => { stderr += chunk; },
  });
  const handle = await runtime.ensureSession({
    sessionKey: "filesystem-protocol", agent: "custom", mode: "oneshot",
    cwd: input.cwd, sessionOptions: { env: {} },
  });
  try {
    for await (const _event of runtime.runTurn({
      handle, text: JSON.stringify({ operations: input.operations }),
      mode: "prompt", requestId: "filesystem-protocol", timeoutMs: 5_000,
    })) { /* Drain the real ACP turn. */ }
    return stderr.split("\n").filter((line) => line.startsWith("FS_RESULT "))
      .map((line) => JSON.parse(line.slice("FS_RESULT ".length)));
  } finally {
    await runtime.close({ handle, reason: "done" });
  }
}

describe.each(runtimes)("ACPX $version filesystem protocol", ({ api }) => {
  it("reports a missing file as an ACP resource error and then creates and reads it", async () => {
    const input = await workspace();
    const file = path.join(input.cwd, "new.json");
    const content = '{"proof":"synthetic"}\n';
    const receipts = await drive(api, { ...input, operations: [
      { method: "fs/read_text_file", path: file },
      { method: "fs/write_text_file", path: file, content },
      { method: "fs/read_text_file", path: file },
    ] });
    expect(receipts).toHaveLength(3);
    expect(receipts[0].error).toMatchObject({ code: -32002, message: expect.stringContaining("Resource not found") });
    expect(receipts[1].error).toBeUndefined();
    expect(receipts[2].result.content).toBe(content);
    expect(await fs.readFile(file, "utf8")).toBe(content);
  });

  it("keeps unrelated paths denied for both reads and writes", async () => {
    const input = await workspace();
    const outside = path.join(await fs.realpath(input.root), "outside.json");
    await fs.writeFile(outside, "unchanged");
    const receipts = await drive(api, { ...input, operations: [
      { method: "fs/read_text_file", path: outside },
      { method: "fs/write_text_file", path: outside, content: "changed" },
    ] });
    expect(receipts).toHaveLength(2);
    expect(receipts.every((receipt) => receipt.error && receipt.error.code !== -32002)).toBe(true);
    expect(await fs.readFile(outside, "utf8")).toBe("unchanged");
  });

  it("preserves deny-all permissions instead of converting denials into missing files", async () => {
    const input = await workspace();
    const file = path.join(input.cwd, "denied.json");
    const receipts = await drive(api, { ...input, permissionMode: "deny-all", operations: [
      { method: "fs/read_text_file", path: file },
      { method: "fs/write_text_file", path: file, content: "denied" },
    ] });
    expect(receipts).toHaveLength(2);
    expect(receipts.every((receipt) => receipt.error && receipt.error.code !== -32002)).toBe(true);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("keeps other filesystem failures distinct from missing files", async () => {
    const input = await workspace();
    const receipts = await drive(api, { ...input, operations: [{ method: "fs/read_text_file", path: input.cwd }] });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].error.code).not.toBe(-32002);
  });

});
