import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piVersionSupportsMcp, preparePiMcpConfig, preparePiRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function readModelsJson(agentConfigDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(agentConfigDir, "models.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("preparePiRuntimeConfig", () => {
  it("attributes OpenRouter aliases and model overrides while preserving routing and other providers", async () => {
    const other = { baseUrl: "https://other.example/v1", headers: { "X-Title": "Other" } };
    const prepared = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify({
      router: {
        baseUrl: "https://openrouter.ai/api/v1", apiKey: "fixture-key",
        headers: { "http-referer": "https://pi.example", "X-Route": "selected" },
        modelOverrides: { model: { headers: { "x-title": "Pi" } } },
      }, other, openrouter: other,
    }) } });
    cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);
    const { providers } = await readModelsJson(prepared.env.PI_CODING_AGENT_DIR) as { providers: Record<string, any> };
    expect(providers.router).toMatchObject({ apiKey: "fixture-key", headers: { "HTTP-Referer": "https://paperclip.ing", "X-Route": "selected" } });
    expect(providers.router.headers).not.toHaveProperty("http-referer");
    expect(providers.router.modelOverrides.model.headers["X-Title"]).toBe("Paperclip");
    expect(providers.router.modelOverrides.model.headers).not.toHaveProperty("x-title");
    expect(providers.other).toEqual(other);
    expect(providers.openrouter).toEqual(other);
    await prepared.cleanup();
  });

  it("is a no-op when PAPERCLIP_PI_PROVIDERS is unset", async () => {
    const prepared = await preparePiRuntimeConfig({ env: { FOO: "bar" } });

    expect(prepared.env).toEqual({ FOO: "bar" });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("writes the providers JSON verbatim to a managed models.json and points PI_CODING_AGENT_DIR at it", async () => {
    const providers = {
      tensorix: {
        baseUrl: "http://gateway.example.svc.cluster.local:8080/anthropic",
        apiKey: "sk-literal",
        api: "anthropic-messages",
        models: [
          {
            id: "deepseek/deepseek-chat-v3.1",
            name: "DeepSeek v3.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    };

    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    expect(agentConfigDir).toBeTruthy();
    cleanupPaths.add(agentConfigDir);

    expect(await readModelsJson(agentConfigDir)).toEqual({ providers });
    expect(prepared.notes.some((n) => n.includes("tensorix"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(agentConfigDir);
    await expect(fs.access(agentConfigDir)).rejects.toThrow();
  });

  it("reads PAPERCLIP_PI_PROVIDERS from process.env when absent from the run env", async () => {
    const providers = { tensorix: { baseUrl: "http://gw/anthropic", api: "anthropic-messages", models: [] } };
    process.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await preparePiRuntimeConfig({ env: {} });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      expect(agentConfigDir).toBeTruthy();
      cleanupPaths.add(agentConfigDir);
      expect(await readModelsJson(agentConfigDir)).toEqual({ providers });
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_PI_PROVIDERS;
    }
  });

  it("expands {env:VAR} placeholders from the run env (bakes the literal key)", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:ANTHROPIC_API_KEY}", api: "anthropic-messages", models: [] },
    };
    const prepared = await preparePiRuntimeConfig({
      env: {
        PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers),
        ANTHROPIC_API_KEY: "sk-bf-REALVK",
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: { tensorix: { apiKey: string } };
    };
    expect(modelsJson.providers.tensorix.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("expands {env:VAR} placeholders from process.env when absent from the run env", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:PAPERCLIP_PI_TEST_KEY}", api: "anthropic-messages", models: [] },
    };
    process.env.PAPERCLIP_PI_TEST_KEY = "sk-from-process-env";
    try {
      const prepared = await preparePiRuntimeConfig({
        env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
      });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      cleanupPaths.add(agentConfigDir);
      const modelsJson = (await readModelsJson(agentConfigDir)) as {
        providers: { tensorix: { apiKey: string } };
      };
      expect(modelsJson.providers.tensorix.apiKey).toBe("sk-from-process-env");
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_PI_TEST_KEY;
    }
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}", api: "anthropic-messages", models: [] },
    };
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: { tensorix: { apiKey: string } };
    };
    expect(modelsJson.providers.tensorix.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_PI_PROVIDERS without writing a config", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("ignores provider entries that are not objects and names them in the note", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify({ tensorix: "nope" }) },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.agentConfigDir).toBeNull();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces skipped non-object entries while keeping the usable ones", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: {
        PAPERCLIP_PI_PROVIDERS: JSON.stringify({
          bad: "http://gw/v1",
          tensorix: { baseUrl: "http://gw/anthropic", apiKey: "k", api: "anthropic-messages", models: [] },
        }),
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    expect(prepared.agentConfigDir).toBe(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: Record<string, unknown>;
    };
    expect(modelsJson.providers.tensorix).toBeDefined();
    expect(modelsJson.providers.bad).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: bad.",
      "Injected 1 custom Pi provider(s) from PAPERCLIP_PI_PROVIDERS into a managed models.json: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_PI_PROVIDERS contains invalid JSON", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "{not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_PI_PROVIDERS is not a JSON object", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "[1,2]" },
    });
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces the skipped entries when no provider objects remain", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: '{"a": 1}' },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: a.",
    ]);
    await prepared.cleanup();
  });

  it("stays silent when PAPERCLIP_PI_PROVIDERS is an empty object", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "{}" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });
});

describe("preparePiMcpConfig", () => {
  const servers = [
    { name: "Cloudflare for the organization", url: "https://paperclip.example/mcp/gateways/gw1", token: "run-token-1", connectionId: "0127c7b8-aaaa" },
    { name: "Cloudflare_for the organization", url: "https://paperclip.example/mcp/gateways/gw2", token: "run-token-2", connectionId: "c2e8faa7-bbbb" },
  ];

  async function tempDir(prefix: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupPaths.add(dir);
    return dir;
  }

  async function readMcp(dir: string) {
    return JSON.parse(await fs.readFile(path.join(dir, "mcp.json"), "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
  }

  it("does nothing without runtime MCP servers", async () => {
    const prepared = await preparePiMcpConfig({ servers: [], env: {}, managedAgentConfigDir: null, cwd: "/" });
    expect(prepared.agentConfigDir).toBeNull();
    expect(prepared.notes).toEqual([]);
  });

  it("writes mcp.json into a managed agent-config dir", async () => {
    const managed = await tempDir("pi-managed-");
    const prepared = await preparePiMcpConfig({ servers, env: {}, managedAgentConfigDir: managed, cwd: "/" });
    expect(prepared.agentConfigDir).toBe(managed);
    const { mcpServers } = await readMcp(managed);
    expect(Object.keys(mcpServers)).toEqual(["cloudflare-for-the-organization", "cloudflare_for-the-organization-c2e8faa7"]);
    expect(mcpServers["cloudflare-for-the-organization"]).toMatchObject({
      url: "https://paperclip.example/mcp/gateways/gw1",
      headers: { Authorization: "Bearer run-token-1" },
    });
    expect((await fs.stat(path.join(managed, "mcp.json"))).mode & 0o777).toBe(0o600);
  });

  it("overlays the agent dir from HOME without touching it", async () => {
    const home = await tempDir("pi-home-");
    const agentDir = path.join(home, ".pi", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "auth.json"), "{}");
    const userMcp = { mcpServers: { docs: { url: "https://docs.example/mcp" }, "cloudflare-for-the-organization": { url: "https://stale.example" } } };
    await fs.writeFile(path.join(agentDir, "mcp.json"), JSON.stringify(userMcp));

    const prepared = await preparePiMcpConfig({ servers: servers.slice(0, 1), env: { HOME: home }, managedAgentConfigDir: null, cwd: "/" });
    const overlay = prepared.agentConfigDir!;
    expect(overlay).not.toBe(agentDir);
    expect(await fs.readlink(path.join(overlay, "auth.json"))).toBe(path.join(agentDir, "auth.json"));
    const { mcpServers } = await readMcp(overlay);
    expect(mcpServers.docs).toEqual({ url: "https://docs.example/mcp" });
    expect(mcpServers["cloudflare-for-the-organization"]?.url).toBe("https://paperclip.example/mcp/gateways/gw1");
    expect(JSON.parse(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8"))).toEqual(userMcp);

    await prepared.cleanup();
    await expect(fs.stat(overlay)).rejects.toThrow();
    await expect(fs.stat(path.join(agentDir, "auth.json"))).resolves.toBeTruthy();
  });

  it("prefers PI_CODING_AGENT_DIR over HOME", async () => {
    const agentDir = await tempDir("pi-agent-");
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}");
    const prepared = await preparePiMcpConfig({ servers: servers.slice(0, 1), env: { PI_CODING_AGENT_DIR: agentDir, HOME: "/nonexistent" }, managedAgentConfigDir: null, cwd: "/" });
    cleanupPaths.add(prepared.agentConfigDir!);
    expect(await fs.readlink(path.join(prepared.agentConfigDir!, "settings.json"))).toBe(path.join(agentDir, "settings.json"));
  });

  it("resolves a relative PI_CODING_AGENT_DIR against the run cwd", async () => {
    const cwd = await tempDir("pi-cwd-");
    await fs.mkdir(path.join(cwd, ".pi", "agent"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".pi", "agent", "auth.json"), "{}");
    const prepared = await preparePiMcpConfig({ servers: servers.slice(0, 1), env: { PI_CODING_AGENT_DIR: ".pi/agent" }, managedAgentConfigDir: null, cwd });
    cleanupPaths.add(prepared.agentConfigDir!);
    expect(await fs.readlink(path.join(prepared.agentConfigDir!, "auth.json"))).toBe(path.join(cwd, ".pi", "agent", "auth.json"));
    expect(await fs.readFile(path.join(prepared.agentConfigDir!, "auth.json"), "utf8")).toBe("{}");
  });

  it("expands a ~ PI_CODING_AGENT_DIR with HOME", async () => {
    const home = await tempDir("pi-home-");
    await fs.mkdir(path.join(home, "pi-agent"), { recursive: true });
    await fs.writeFile(path.join(home, "pi-agent", "settings.json"), "{}");
    const prepared = await preparePiMcpConfig({ servers: servers.slice(0, 1), env: { PI_CODING_AGENT_DIR: "~/pi-agent", HOME: home }, managedAgentConfigDir: null, cwd: "/" });
    cleanupPaths.add(prepared.agentConfigDir!);
    expect(await fs.readlink(path.join(prepared.agentConfigDir!, "settings.json"))).toBe(path.join(home, "pi-agent", "settings.json"));
  });
});

describe("piVersionSupportsMcp", () => {
  it("requires Pi 0.99.0 or later", () => {
    expect(piVersionSupportsMcp("0.74.0")).toBe(false);
    expect(piVersionSupportsMcp("0.98.9")).toBe(false);
    expect(piVersionSupportsMcp("0.99.0")).toBe(true);
    expect(piVersionSupportsMcp("pi 1.4.0")).toBe(true);
    expect(piVersionSupportsMcp("")).toBeNull();
  });
});
