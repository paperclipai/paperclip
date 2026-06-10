import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOllamaRequest,
  buildOpenAIResponse,
  buildSSEBuffer,
  convertMessageToOllama,
  prepareOpenCodeRuntimeConfig,
  startGemma4ThinkProxy,
} from "./runtime-config.js";

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

// ── Unit tests for protocol translation helpers ────────────────────────────────

describe("convertMessageToOllama", () => {
  it("converts a plain user message", () => {
    const result = convertMessageToOllama({ role: "user", content: "Hello" });
    expect(result).toEqual({ role: "user", content: "Hello" });
  });

  it("parses tool_call arguments from JSON string to object", () => {
    const msg = {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "search", arguments: '{"query":"hello"}' },
        },
      ],
    };
    const result = convertMessageToOllama(msg);
    expect(result.tool_calls).toEqual([
      { function: { name: "search", arguments: { query: "hello" } } },
    ]);
  });

  it("keeps tool_call arguments as-is if already an object", () => {
    const msg = {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "fn", arguments: { key: "val" } } }],
    };
    const result = convertMessageToOllama(msg);
    const tc = (result.tool_calls as { function: { arguments: unknown } }[])[0];
    expect(tc.function.arguments).toEqual({ key: "val" });
  });
});

describe("buildOllamaRequest", () => {
  it("sets think:false and stream:false", () => {
    const result = buildOllamaRequest({
      model: "gemma4:26b-a4b-it-q4_K_M",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(result.think).toBe(false);
    expect(result.stream).toBe(false);
  });

  it("maps max_tokens to options.num_predict", () => {
    const result = buildOllamaRequest({
      model: "gemma4:26b-a4b-it-q4_K_M",
      messages: [],
      max_tokens: 200,
      temperature: 0.5,
      top_p: 0.9,
    });
    expect(result.options).toEqual({ num_predict: 200, temperature: 0.5, top_p: 0.9 });
  });

  it("omits options when no sampling params given", () => {
    const result = buildOllamaRequest({ model: "gemma4:26b", messages: [] });
    expect(result.options).toBeUndefined();
  });

  it("passes tools through unchanged", () => {
    const tools = [{ type: "function", function: { name: "foo" } }];
    const result = buildOllamaRequest({ model: "gemma4:26b", messages: [], tools });
    expect(result.tools).toBe(tools);
  });
});

describe("buildOpenAIResponse", () => {
  it("wraps a simple text response", () => {
    const ollamaResp = {
      model: "gemma4:26b",
      message: { role: "assistant", content: "4" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 10,
      eval_count: 2,
    };
    const result = buildOpenAIResponse(ollamaResp, "test-1");
    expect(result.choices).toHaveLength(1);
    const choice = (result.choices as { message: { content: string }; finish_reason: string }[])[0];
    expect(choice.message.content).toBe("4");
    expect(choice.finish_reason).toBe("stop");
    expect((result.usage as { prompt_tokens: number }).prompt_tokens).toBe(10);
    expect((result.usage as { completion_tokens: number }).completion_tokens).toBe(2);
  });

  it("converts tool_calls arguments from object to JSON string and adds id/type", () => {
    const ollamaResp = {
      model: "gemma4:26b",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "search", arguments: { query: "test" } } }],
      },
      done: true,
      done_reason: "tool_calls",
    };
    const result = buildOpenAIResponse(ollamaResp, "tc-1");
    const choice = (result.choices as { message: { tool_calls: unknown[] }; finish_reason: string }[])[0];
    expect(choice.finish_reason).toBe("tool_calls");
    const tc = choice.message.tool_calls[0] as {
      id: string;
      type: string;
      function: { name: string; arguments: string };
    };
    expect(tc.id).toBe("call_tc-1_0");
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("search");
    expect(JSON.parse(tc.function.arguments)).toEqual({ query: "test" });
  });

  it("maps done_reason=length to finish_reason=length", () => {
    const result = buildOpenAIResponse(
      { model: "m", message: { role: "assistant", content: "..." }, done: true, done_reason: "length" },
      "id-1",
    );
    const choice = (result.choices as { finish_reason: string }[])[0];
    expect(choice.finish_reason).toBe("length");
  });
});

describe("buildSSEBuffer", () => {
  it("includes content, finish_reason, and DONE marker", () => {
    const openAIResp = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 123,
      model: "gemma4:26b",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    };
    const buf = buildSSEBuffer(openAIResp);
    const text = buf.toString("utf8");
    expect(text).toContain("data: ");
    expect(text).toContain("Hello");
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
  });

  it("stamps index on each tool_call delta so the AI SDK stream parser can assemble them", () => {
    const openAIResp = {
      id: "chatcmpl-2",
      object: "chat.completion",
      created: 123,
      model: "gemma4:26b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_2_0", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
              { id: "call_2_1", type: "function", function: { name: "read", arguments: '{"path":"/"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };

    const buf = buildSSEBuffer(openAIResp);
    const text = buf.toString("utf8");

    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    expect(dataLines.length).toBeGreaterThanOrEqual(1);

    const firstChunk = JSON.parse(dataLines[0].slice(6)) as {
      choices: {
        delta: {
          tool_calls: { index: number; id: string; function: { name: string } }[];
        };
      }[];
    };
    const tcs = firstChunk.choices[0].delta.tool_calls;
    expect(tcs).toHaveLength(2);
    expect(tcs[0].index).toBe(0);
    expect(tcs[1].index).toBe(1);
    expect(tcs[0].id).toBe("call_2_0");
    expect(tcs[1].id).toBe("call_2_1");
  });
});

// ── Integration tests ──────────────────────────────────────────────────────────

describe("startGemma4ThinkProxy", () => {
  it("starts a proxy that translates gemma4 requests to /api/chat with think:false", async () => {
    // Spin up a fake Ollama server that records what it receives
    type ReceivedRequest = { path: string; body: Record<string, unknown> };
    const received: ReceivedRequest[] = [];

    const fakeOllama = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {}
          received.push({ path: req.url ?? "", body });
          const resp = {
            model: "gemma4:26b",
            message: { role: "assistant", content: "4" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 5,
            eval_count: 1,
          };
          const buf = Buffer.from(JSON.stringify(resp), "utf8");
          res.writeHead(200, { "content-type": "application/json", "content-length": String(buf.length) });
          res.end(buf);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    const ollamaPort = (fakeOllama.address() as { port: number }).port;
    const targetBaseUrl = `http://127.0.0.1:${ollamaPort}/v1`;

    const proxy = await startGemma4ThinkProxy(targetBaseUrl);

    try {
      // Send a gemma4 request through the proxy
      const proxyUrl = new URL(proxy.proxyUrl);
      const reqBody = Buffer.from(
        JSON.stringify({
          model: "gemma4:26b-a4b-it-q4_K_M",
          messages: [{ role: "user", content: "2+2?" }],
          stream: false,
          max_tokens: 5,
        }),
        "utf8",
      );

      const proxyResp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: proxyUrl.hostname,
            port: Number(proxyUrl.port),
            path: `${proxyUrl.pathname}/chat/completions`,
            method: "POST",
            headers: { "content-type": "application/json", "content-length": String(reqBody.length) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          },
        );
        req.on("error", reject);
        req.write(reqBody);
        req.end();
      });

      // Proxy returned OpenAI format
      expect(proxyResp.status).toBe(200);
      const parsed = JSON.parse(proxyResp.body) as {
        choices: { message: { content: string } }[];
      };
      expect(parsed.choices[0].message.content).toBe("4");

      // Fake Ollama received a /api/chat request with think:false
      expect(received).toHaveLength(1);
      expect(received[0].path).toBe("/api/chat");
      expect(received[0].body.think).toBe(false);
      expect(received[0].body.stream).toBe(false);
      expect(received[0].body.options).toMatchObject({ num_predict: 5 });
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => fakeOllama.close(() => resolve()));
    }
  });

  it("streams SSE with indexed tool_call deltas for gemma4 (live path)", async () => {
    // Verify the SSE branch (clientWantsStreaming===true) carries index on each
    // tool_call entry — the AI SDK stream parser requires index to assemble calls.
    const fakeOllama = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const resp = {
            model: "gemma4:26b",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { function: { name: "bash", arguments: { cmd: "ls" } } },
                { function: { name: "read", arguments: { path: "/" } } },
              ],
            },
            done: true,
            done_reason: "tool_calls",
            prompt_eval_count: 5,
            eval_count: 3,
          };
          const buf = Buffer.from(JSON.stringify(resp), "utf8");
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": String(buf.length),
          });
          res.end(buf);
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    const ollamaPort = (fakeOllama.address() as { port: number }).port;
    const proxy = await startGemma4ThinkProxy(`http://127.0.0.1:${ollamaPort}/v1`);

    try {
      const proxyUrl = new URL(proxy.proxyUrl);
      const reqBody = Buffer.from(
        JSON.stringify({
          model: "gemma4:26b-a4b-it-q4_K_M",
          messages: [{ role: "user", content: "list files" }],
          stream: true,
          tools: [
            { type: "function", function: { name: "bash", parameters: {} } },
            { type: "function", function: { name: "read", parameters: {} } },
          ],
        }),
        "utf8",
      );

      const proxyResp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: proxyUrl.hostname,
            port: Number(proxyUrl.port),
            path: `${proxyUrl.pathname}/chat/completions`,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": String(reqBody.length),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        req.on("error", reject);
        req.write(reqBody);
        req.end();
      });

      expect(proxyResp.status).toBe(200);

      // Parse SSE: each line starting with "data: " (skip [DONE])
      const dataLines = proxyResp.body
        .split("\n")
        .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
      expect(dataLines.length).toBeGreaterThanOrEqual(1);

      const firstChunk = JSON.parse(dataLines[0].slice(6)) as {
        choices: {
          delta: {
            tool_calls: { index: number; id: string; function: { name: string; arguments: string } }[];
          };
        }[];
      };
      const tcs = firstChunk.choices[0].delta.tool_calls;
      expect(tcs).toBeDefined();
      expect(tcs).toHaveLength(2);
      // index must be present for AI SDK stream parser
      expect(tcs[0].index).toBe(0);
      expect(tcs[1].index).toBe(1);
      // function names must survive the /api/chat → SSE round-trip
      expect(tcs[0].function.name).toBe("bash");
      expect(tcs[1].function.name).toBe("read");
      // arguments must be JSON strings (OpenAI wire format)
      expect(() => JSON.parse(tcs[0].function.arguments)).not.toThrow();
      expect(() => JSON.parse(tcs[1].function.arguments)).not.toThrow();
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => fakeOllama.close(() => resolve()));
    }
  });

  it("passes non-gemma4 requests through to the original /v1 endpoint", async () => {
    const received: string[] = [];

    const fakeOllama = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        received.push(req.url ?? "");
        const resp = {
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        };
        const buf = Buffer.from(JSON.stringify(resp), "utf8");
        res.writeHead(200, { "content-type": "application/json", "content-length": String(buf.length) });
        res.end(buf);
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    const ollamaPort = (fakeOllama.address() as { port: number }).port;
    const proxy = await startGemma4ThinkProxy(`http://127.0.0.1:${ollamaPort}/v1`);

    try {
      const proxyUrl = new URL(proxy.proxyUrl);
      const reqBody = Buffer.from(
        JSON.stringify({ model: "qwen3:30b-a3b", messages: [{ role: "user", content: "hi" }] }),
        "utf8",
      );

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: proxyUrl.hostname,
            port: Number(proxyUrl.port),
            path: `${proxyUrl.pathname}/chat/completions`,
            method: "POST",
            headers: { "content-type": "application/json", "content-length": String(reqBody.length) },
          },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        );
        req.on("error", reject);
        req.write(reqBody);
        req.end();
      });

      // Non-gemma4 was forwarded to /v1/chat/completions, not /api/chat
      expect(received).toHaveLength(1);
      expect(received[0]).toBe("/v1/chat/completions");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => fakeOllama.close(() => resolve()));
    }
  });
});

// ── prepareOpenCodeRuntimeConfig integration tests ────────────────────────────

describe("prepareOpenCodeRuntimeConfig", () => {
  it("injects an external_directory allow rule by default", async () => {
    const configHome = await makeConfigHome({
      permission: { read: "allow" },
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
      permission: { read: "allow", external_directory: "allow" },
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

  it("starts proxy and rewrites baseURL for ollama provider with gemma4 models", async () => {
    const configHome = await makeConfigHome({
      provider: {
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: {
            "gemma4:26b-a4b-it-q4_K_M": { name: "Gemma 4 26B", tools: true },
            "qwen3:30b-a3b": { name: "Qwen3 30B", tools: true },
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
    ) as {
      provider: {
        ollama: { options: { baseURL: string }; models: Record<string, unknown> };
      };
    };

    // baseURL should now point at the proxy, not the original Ollama /v1
    const newBaseUrl = runtimeConfig.provider.ollama.options.baseURL;
    expect(newBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(newBaseUrl).not.toBe("http://127.0.0.1:11434/v1");

    // The model config itself should NOT have options.think injected (proxy handles it)
    const gemmaModel = runtimeConfig.provider.ollama.models["gemma4:26b-a4b-it-q4_K_M"] as Record<string, unknown>;
    expect(gemmaModel.options).toBeUndefined();

    expect(prepared.notes.some((n) => n.includes("proxy"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("does not start proxy when no ollama baseURL is configured", async () => {
    const configHome = await makeConfigHome({ theme: "dark" });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    expect(prepared.notes.some((n) => n.includes("proxy"))).toBe(false);

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });
});
