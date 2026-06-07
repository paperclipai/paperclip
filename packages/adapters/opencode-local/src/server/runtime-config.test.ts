import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeConfigHome(initialConfig?: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-"));
  cleanupPaths.add(root);
  const configDir = path.join(root, "opencode");
  await fs.mkdir(configDir, { recursive: true });
  if (initialConfig) {
    await fs.writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

// Starts a minimal HTTP server that records the last POST body and returns a
// fixed JSON response. Returns port and teardown function.
function startFakeOllama(): Promise<{
  port: number;
  lastBody: () => Record<string, unknown> | null;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    let lastBody: Record<string, unknown> | null = null;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {
          lastBody = null;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: lastBody?.model, message: { role: "assistant", content: "ok" } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        lastBody: () => lastBody,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe("prepareOpenCodeRuntimeConfig", () => {
  it("injects an external_directory allow rule by default", async () => {
    const configHome = await makeConfigHome({
      permission: {
        read: "allow",
      },
      theme: "system",
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    expect(prepared.env.XDG_CONFIG_HOME).not.toBe(configHome);
    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({
      theme: "system",
      permission: {
        read: "allow",
        external_directory: "allow",
      },
    });

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("respects explicit opt-out", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
    });

    expect(prepared.env).toEqual({ XDG_CONFIG_HOME: configHome });
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("rewrites gemma4 provider baseURL to a local proxy", async () => {
    const fakeOllama = await startFakeOllama();
    try {
      const configHome = await makeConfigHome({
        provider: {
          ollama: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${fakeOllama.port}/v1` },
            models: {
              "gemma4:26b-a4b-it-q4_K_M": { name: "Gemma 4 26B", tools: true },
              "llama3.3:70b-instruct-q4_K_M": { name: "Llama 3.3 70B", tools: true },
            },
          },
        },
      });

      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

      const runtimeConfig = JSON.parse(
        await fs.readFile(
          path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;

      // The baseURL should point to a local proxy, not the original Ollama endpoint
      const ollamaOptions = (
        runtimeConfig as { provider: { ollama: { options: { baseURL: string } } } }
      ).provider.ollama.options;
      expect(ollamaOptions.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      expect(ollamaOptions.baseURL).not.toBe(`http://127.0.0.1:${fakeOllama.port}/v1`);
      expect(prepared.notes.some((n) => n.includes("think:false proxy"))).toBe(true);

      await prepared.cleanup();
      cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    } finally {
      await fakeOllama.close();
    }
  });

  it("proxy injects think:false for gemma4 POST requests", async () => {
    const fakeOllama = await startFakeOllama();
    try {
      const configHome = await makeConfigHome({
        provider: {
          ollama: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${fakeOllama.port}/v1` },
            models: {
              "gemma4:26b-a4b-it-q4_K_M": { name: "Gemma 4 26B", tools: true },
            },
          },
        },
      });

      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

      const runtimeConfig = JSON.parse(
        await fs.readFile(
          path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const proxyBaseUrl = (
        runtimeConfig as { provider: { ollama: { options: { baseURL: string } } } }
      ).provider.ollama.options.baseURL;

      // Send a gemma4 chat request through the proxy
      const resp = await fetch(`${proxyBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemma4:26b-a4b-it-q4_K_M",
          messages: [{ role: "user", content: "What is 2+2?" }],
          stream: false,
        }),
      });
      expect(resp.ok).toBe(true);

      // Fake Ollama should have received think:false injected into the body
      const body = fakeOllama.lastBody();
      expect(body?.think).toBe(false);
      expect(body?.model).toBe("gemma4:26b-a4b-it-q4_K_M");
      // Original fields must be preserved
      expect(body?.stream).toBe(false);

      await prepared.cleanup();
      cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    } finally {
      await fakeOllama.close();
    }
  });

  it("proxy does not inject think:false for non-gemma4 models", async () => {
    const fakeOllama = await startFakeOllama();
    try {
      const configHome = await makeConfigHome({
        provider: {
          ollama: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${fakeOllama.port}/v1` },
            models: {
              "gemma4:26b-a4b-it-q4_K_M": { name: "Gemma 4 26B", tools: true },
            },
          },
        },
      });

      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

      const runtimeConfig = JSON.parse(
        await fs.readFile(
          path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const proxyBaseUrl = (
        runtimeConfig as { provider: { ollama: { options: { baseURL: string } } } }
      ).provider.ollama.options.baseURL;

      // Send a non-gemma4 request through the proxy
      await fetch(`${proxyBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3:30b-a3b",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const body = fakeOllama.lastBody();
      expect(body?.think).toBeUndefined();
      expect(body?.model).toBe("qwen3:30b-a3b");

      await prepared.cleanup();
      cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    } finally {
      await fakeOllama.close();
    }
  });

  it("does not start a proxy when no gemma4 models are configured", async () => {
    const configHome = await makeConfigHome({
      provider: {
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: {
            "llama3.3:70b-instruct-q4_K_M": { name: "Llama 3.3 70B", tools: true },
          },
        },
      },
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const ollamaOptions = (
      runtimeConfig as { provider: { ollama: { options: { baseURL: string } } } }
    ).provider.ollama.options;

    // baseURL should be unchanged when no gemma4 models are present
    expect(ollamaOptions.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(prepared.notes.some((n) => n.includes("think:false proxy"))).toBe(false);

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });
});
