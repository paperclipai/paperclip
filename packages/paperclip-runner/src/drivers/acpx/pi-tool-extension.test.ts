import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { startRunnerToolBridge, type RunnerToolBridge } from "../runner-tool-bridge.js";
import { PRP_COMPLETION_TOOL_NAME } from "../../contracts/completion-result.js";
import { PI_RUNNER_TOOL_EXTENSION } from "./pi-tool-extension.js";

const directories: string[] = [];
const bridges: RunnerToolBridge[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function loadExtension(bridge?: RunnerToolBridge) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-tools-"));
  directories.push(root);
  const agentDir = join(root, "private-pi");
  const cwd = join(root, "workspace");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "paperclip-runner-tools.js"), PI_RUNNER_TOOL_EXTENSION);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
  await writeFile(join(cwd, ".pi", "extensions", "untrusted.js"), 'export default function() { throw new Error("PROJECT_EXTENSION_LOADED"); }');
  vi.stubEnv("PAPERCLIP_PI_TOOL_BRIDGE_URL", bridge?.url);
  vi.stubEnv("PAPERCLIP_PI_TOOL_BRIDGE_TOKEN", bridge?.secret);
  const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload({ resolveProjectTrust: async () => false });
  return loader.getExtensions();
}

const definition = {
  name: "read_cached_file",
  description: "Read a cached file",
  inputSchema: {
    type: "object", properties: { path: { type: "string" } },
    required: ["path"], additionalProperties: false,
  },
};

describe("Pi runner tool extension", () => {
  it("loads through the pinned Pi runtime, preserves schemas and uses the authenticated bridge", async () => {
    const handler = vi.fn(async () => ({ bytes: "saved-content" }));
    const bridge = await startRunnerToolBridge({
      tools: [definition],
      privateTools: [{ ...definition, name: "private_control" }],
      handler,
    });
    bridges.push(bridge);
    const loaded = await loadExtension(bridge);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const tools = loaded.extensions[0]!.tools;
    expect(tools.has("private_control")).toBe(false);
    expect([...tools.keys()]).toContain(PRP_COMPLETION_TOOL_NAME);
    const tool = tools.get(definition.name)!.definition;
    expect(tool.parameters).toEqual(definition.inputSchema);
    const execute = (id: string, args: unknown) => tool.execute(id, args, undefined, undefined, {} as never);
    expect(await execute("same-call", { path: "file.txt" })).toMatchObject({
      content: [{ type: "text", text: '{"bytes":"saved-content"}' }],
    });
    await execute("same-call", { path: "file.txt" });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(execute("same-call", { path: "different.txt" })).rejects.toThrow("Duplicate call identity conflict");
    await expect(execute("invalid-input", { path: 123 })).rejects.toThrow("Invalid tool input");
    expect(handler).toHaveBeenCalledTimes(1);
    await bridge.close();
    await expect(execute("closed-bridge", { path: "file.txt" })).rejects.toThrow();
  });

  it("cancels the admitted server operation when Pi aborts the tool", async () => {
    let started!: () => void;
    const admitted = new Promise<void>(resolve => { started = resolve; });
    let serverSignal: AbortSignal | undefined;
    const bridge = await startRunnerToolBridge({ tools: [definition], handler: async ({ signal }) => {
      serverSignal = signal;
      started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    } });
    bridges.push(bridge);
    const loaded = await loadExtension(bridge);
    expect(loaded.errors).toEqual([]);
    const tool = loaded.extensions[0]!.tools.get(definition.name)!.definition;
    const controller = new AbortController();
    const call = tool.execute("cancel-me", { path: "file.txt" }, controller.signal, undefined, {} as never);
    const rejected = expect(call).rejects.toThrow();
    await admitted;
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(serverSignal?.aborted).toBe(true));
  });

  it("rejects oversized requests and responses with bounded reads", async () => {
    const handler = vi.fn(async () => ({ data: "x".repeat(4 * 1024 * 1024) }));
    const bridge = await startRunnerToolBridge({ tools: [definition], handler });
    bridges.push(bridge);
    const loaded = await loadExtension(bridge);
    expect(loaded.errors).toEqual([]);
    const tool = loaded.extensions[0]!.tools.get(definition.name)!.definition;
    await expect(tool.execute("large-request", { path: "x".repeat(1024 * 1024) }, undefined, undefined, {} as never))
      .rejects.toThrow("request is too large");
    expect(handler).not.toHaveBeenCalled();
    await expect(tool.execute("large-response", { path: "file.txt" }, undefined, undefined, {} as never))
      .rejects.toThrow("response is too large");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("fails loading with invalid credentials without exposing the credential", async () => {
    const bridge = await startRunnerToolBridge({ tools: [definition], handler: async () => ({}) });
    bridges.push(bridge);
    const loaded = await loadExtension({ ...bridge, secret: "invalid-secret" });
    expect(loaded.extensions).toHaveLength(0);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]!.error).toContain("HTTP 401");
    expect(loaded.errors[0]!.error).not.toContain("invalid-secret");
  });

  it("registers nothing without a run-owned bridge", async () => {
    const loaded = await loadExtension();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions[0]!.tools.size).toBe(0);
  });
});
