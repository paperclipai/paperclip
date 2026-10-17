import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => ({
  ...await importOriginal<object>(), runAdapterExecutionTargetProcess: vi.fn(),
}));
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { prepareManagedModelImageInput } from "./model-input.js";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const run = vi.mocked(runAdapterExecutionTargetProcess);
const catalog = { data: [{ id: "team/alias", capabilities: { vision: true } }] };
function environment(baseUrl = "http://localhost:9999/v1") {
  return {
    PAPERCLIP_AI_PROVIDER_URL: baseUrl, PAPERCLIP_AI_PROVIDER_KEY: "selected-key",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { paperclip: {
      options: { baseURL: baseUrl, apiKey: "selected-key" }, models: { "team/alias": { name: "team/alias" } },
    } } }),
  };
}
function input(env: Record<string, string> = environment()) {
  return { runId: "run", target: null, cwd: process.cwd(), env, model: "paperclip/team/alias", managed: true };
}
afterEach(() => vi.resetAllMocks());

describe("managed OpenCode model input", () => {
  it.each([
    ["disk", true], ["disk", false], ["providers", true], ["providers", false],
    ["disk-with-permissions", true], ["disk-with-permissions", false],
    ["inline", true], ["inline", false],
  ] as const)("keeps explicit %s modalities when the catalog disagrees (image=%s)", async (source, imageInput) => {
    let catalogRequests = 0;
    const server = createServer((_req, res) => {
      catalogRequests++;
      res.writeHead(200).end(JSON.stringify({ data: [{ id: "team/alias", capabilities: { vision: !imageInput } }] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-explicit-modalities-"));
    const modalities = { input: imageInput ? ["text", "image"] : ["text"], output: ["text"] };
    const provider = { paperclip: { models: { "team/alias": { modalities } } } };
    const env: Record<string, string> = { ...environment(`http://127.0.0.1:${address.port}/v1`), XDG_CONFIG_HOME: home };
    await fs.mkdir(path.join(home, "opencode"));
    const configPath = path.join(home, "opencode", "opencode.json");
    const diskProvider = source === "inline" || source === "providers" ? { paperclip: { models: { "team/alias": {
      modalities: { input: imageInput ? ["text"] : ["text", "image"], output: ["text"] },
    } } } } : provider;
    await fs.writeFile(configPath, JSON.stringify({ provider: diskProvider }));
    if (source === "providers") env.PAPERCLIP_OPENCODE_PROVIDERS = JSON.stringify(provider);
    if (source === "inline") {
      const inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      inline.provider.paperclip.models["team/alias"].modalities = modalities;
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(inline);
    }
    const prepared = await prepareOpenCodeRuntimeConfig({ env,
      config: { model: "paperclip/team/alias", dangerouslySkipPermissions: source !== "disk-with-permissions" } });
    try {
      await prepareManagedModelImageInput(input(prepared.env));
      const disk = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"));
      const inline = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT);
      const effective = { ...disk.provider.paperclip.models["team/alias"], ...inline.provider.paperclip.models["team/alias"] };
      expect(effective.modalities).toEqual(modalities);
      expect(catalogRequests).toBe(0);
    } finally {
      await prepared.cleanup();
      await fs.rm(home, { recursive: true, force: true });
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  });

  it.each(["ssh", "sandbox"])("queries a %s target without a control-plane fetch or secrets in argv", async transport => {
    const env = environment();
    const target = { kind: "remote", transport, remoteCwd: "/agent/work" } as never;
    run.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify(catalog) + "\n200" } as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await prepareManagedModelImageInput({ ...input(env), target });
      expect(fetchSpy).not.toHaveBeenCalled();
      const [runId, actualTarget, command, args, options] = run.mock.calls[0]!;
      expect([runId, actualTarget, command]).toEqual(["run", target, "curl"]);
      expect(JSON.stringify(args)).not.toContain("selected-key");
      expect(options.stdin).toContain('url = "http://localhost:9999/v1/models"');
      expect(options.stdin).toContain("Authorization: Bearer selected-key");
      expect(options.timeoutSec).toBe(5);
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider.paperclip).toMatchObject({
        options: { baseURL: env.PAPERCLIP_AI_PROVIDER_URL, apiKey: "selected-key" },
        models: { "team/alias": { modalities: { input: ["text", "image"], output: ["text"] } } },
      });
    } finally { fetchSpy.mockRestore(); }
  });

  it("discovers at the local execution site and preserves the selected route", async () => {
    const requests: Array<{ path?: string; auth?: string }> = [];
    const server = createServer((req, res) => {
      requests.push({ path: req.url, auth: req.headers.authorization });
      res.writeHead(200).end(JSON.stringify(catalog));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    try {
      const env = environment(`http://127.0.0.1:${address.port}/v1`);
      await prepareManagedModelImageInput(input(env));
      expect(requests).toEqual([{ path: "/v1/models", auth: "Bearer selected-key" }]);
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider.paperclip.models["team/alias"].modalities.input).toContain("image");
      expect(run).not.toHaveBeenCalled();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.each([
    { exitCode: 1, timedOut: false, stdout: "" },
    { exitCode: 0, timedOut: true, stdout: "" },
    { exitCode: 0, timedOut: false, stdout: "invalid\n200" },
    { exitCode: 0, timedOut: false, stdout: JSON.stringify(catalog) + "\n302" },
    { exitCode: 0, timedOut: false, stdout: JSON.stringify({ data: [] }) + "\n200" },
  ])("preserves unknown capability when discovery fails: %j", async result => {
    const env = environment();
    const before = env.OPENCODE_CONFIG_CONTENT;
    run.mockResolvedValue(result as never);
    await prepareManagedModelImageInput({ ...input(env), target: { kind: "remote", transport: "ssh" } as never });
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(before);
  });

  it("does not query unmanaged or explicitly configured models", async () => {
    const env = environment();
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    config.provider.paperclip.models["team/alias"].modalities = { input: ["text", "image"], output: ["text"] };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
    await prepareManagedModelImageInput(input(env));
    await prepareManagedModelImageInput({ ...input(), managed: false });
    expect(run).not.toHaveBeenCalled();
  });
});
