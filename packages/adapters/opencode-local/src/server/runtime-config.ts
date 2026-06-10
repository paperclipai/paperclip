import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ── Protocol translation helpers ──────────────────────────────────────────────
//
// opencode uses @ai-sdk/openai-compatible which speaks OpenAI /v1/chat/completions.
// Ollama only honours `think:false` on its native /api/chat endpoint, NOT on /v1.
// The proxy intercepts gemma4 requests and translates them to /api/chat.

export function convertMessageToOllama(msg: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: msg.role,
    content: msg.content ?? "",
  };

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    result.tool_calls = msg.tool_calls.map((tc: unknown) => {
      if (!isPlainObject(tc) || !isPlainObject(tc.function)) return tc;
      let args: unknown = tc.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          // leave as string if unparseable
        }
      }
      return { function: { name: tc.function.name, arguments: args } };
    });
  }

  return result;
}

export function buildOllamaRequest(openAIBody: Record<string, unknown>): Record<string, unknown> {
  const options: Record<string, number> = {};
  if (typeof openAIBody.max_tokens === "number") options.num_predict = openAIBody.max_tokens;
  if (typeof openAIBody.temperature === "number") options.temperature = openAIBody.temperature;
  if (typeof openAIBody.top_p === "number") options.top_p = openAIBody.top_p;
  if (typeof openAIBody.seed === "number") options.seed = openAIBody.seed;

  const messages = Array.isArray(openAIBody.messages)
    ? openAIBody.messages.filter(isPlainObject).map(convertMessageToOllama)
    : [];

  const result: Record<string, unknown> = {
    model: openAIBody.model,
    messages,
    stream: false, // always collect the full response; we emit SSE to streaming clients
    think: false,
  };

  if (openAIBody.tools) result.tools = openAIBody.tools;
  if (Object.keys(options).length > 0) result.options = options;

  return result;
}

let _completionSeq = 0;
function nextCompletionId(): string {
  return String((_completionSeq = (_completionSeq + 1) % 0x100000));
}

export function buildOpenAIResponse(
  ollamaBody: Record<string, unknown>,
  completionId: string,
): Record<string, unknown> {
  const message: Record<string, unknown> = isPlainObject(ollamaBody.message)
    ? { ...(ollamaBody.message as Record<string, unknown>) }
    : { role: "assistant", content: "" };

  // tool_calls: Ollama returns arguments as an object; OpenAI expects a JSON string + id + type
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls = (message.tool_calls as unknown[]).map((tc: unknown, idx: number) => {
      if (!isPlainObject(tc) || !isPlainObject(tc.function)) return tc;
      let args: unknown = tc.function.arguments;
      if (typeof args === "object" && args !== null) {
        args = JSON.stringify(args);
      }
      return {
        id: `call_${completionId}_${idx}`,
        type: "function",
        function: { name: tc.function.name, arguments: args },
      };
    });
  }

  const doneReason = String(ollamaBody.done_reason ?? "stop");
  const finishReason =
    doneReason === "tool_calls" ? "tool_calls" : doneReason === "length" ? "length" : "stop";

  const promptTokens =
    typeof ollamaBody.prompt_eval_count === "number" ? ollamaBody.prompt_eval_count : 0;
  const completionTokens =
    typeof ollamaBody.eval_count === "number" ? ollamaBody.eval_count : 0;

  return {
    id: `chatcmpl-${completionId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: ollamaBody.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// Emit the OpenAI response as Server-Sent Events (for streaming clients).
// We always fetch a complete response from Ollama then stream it back as SSE
// rather than doing line-by-line NDJSON → SSE translation, which avoids
// complex partial-state accumulation for tool calls.
export function buildSSEBuffer(openAIResponse: Record<string, unknown>): Buffer {
  const choices = Array.isArray(openAIResponse.choices) ? openAIResponse.choices : [];
  const parts: string[] = [];

  for (const choice of choices) {
    if (!isPlainObject(choice)) continue;
    const msg = isPlainObject(choice.message) ? (choice.message as Record<string, unknown>) : {};
    const finishReason = choice.finish_reason as string | null;

    // Opening chunk: role + full content (or tool_calls).
    // OpenAI streaming wire format requires each tool_calls[] entry to carry
    // a per-call `index` so the AI SDK stream parser can assemble them correctly.
    const delta: Record<string, unknown> = { role: "assistant", content: msg.content ?? "" };
    if (Array.isArray(msg.tool_calls)) {
      delta.tool_calls = (msg.tool_calls as unknown[]).map((tc, i) => {
        if (!isPlainObject(tc)) return tc;
        return { ...tc, index: i };
      });
    }

    parts.push(
      `data: ${JSON.stringify({
        id: openAIResponse.id,
        object: "chat.completion.chunk",
        created: openAIResponse.created,
        model: openAIResponse.model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );

    // Closing chunk: finish_reason + usage
    parts.push(
      `data: ${JSON.stringify({
        id: openAIResponse.id,
        object: "chat.completion.chunk",
        created: openAIResponse.created,
        model: openAIResponse.model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: openAIResponse.usage,
      })}\n\n`,
    );
  }

  parts.push("data: [DONE]\n\n");
  return Buffer.from(parts.join(""), "utf8");
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

type ProxyHandle = { proxyUrl: string; close: () => Promise<void> };

// Starts a local HTTP proxy that intercepts POST /chat/completions for gemma4
// models and translates them to native Ollama /api/chat with think:false.
// Non-gemma4 requests are forwarded unchanged to the original targetBaseUrl.
//
// Background: Ollama's /v1/chat/completions (OpenAI-compat) silently ignores
// think:false — only the native /api/chat endpoint honours it. Protocol
// translation is therefore required at the request/response boundary.
export function startGemma4ThinkProxy(targetBaseUrl: string): Promise<ProxyHandle> {
  return new Promise((resolve, reject) => {
    let targetOrigin: string;
    let targetPathname: string;
    let nativeOrigin: string;

    try {
      const parsed = new URL(targetBaseUrl);
      targetOrigin = parsed.origin;
      targetPathname = parsed.pathname === "/" ? "" : parsed.pathname;
      nativeOrigin = parsed.origin; // same host, different path (/api/chat)
    } catch {
      reject(new Error(`Invalid Ollama baseURL: ${targetBaseUrl}`));
      return;
    }

    const server = http.createServer((clientReq, clientRes) => {
      const reqChunks: Buffer[] = [];
      clientReq.on("data", (chunk: Buffer) => reqChunks.push(chunk));
      clientReq.on("end", () => {
        const rawBody = Buffer.concat(reqChunks);

        let parsed: Record<string, unknown> | null = null;
        if (clientReq.method === "POST" && rawBody.length > 0) {
          try {
            parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
          } catch {
            // non-JSON POST — fall through to pass-through
          }
        }

        const model = typeof parsed?.model === "string" ? parsed.model : "";
        const isGemma4 = /gemma4/i.test(model);

        if (!isGemma4 || !parsed) {
          // Pass through unchanged to original /v1 endpoint
          forwardToTarget(clientReq, clientRes, rawBody, targetOrigin, targetPathname);
          return;
        }

        // Gemma4: translate to native /api/chat
        const clientWantsStreaming = parsed.stream === true;
        console.log(`[gemma4-proxy] model=${model} clientWantsStreaming=${clientWantsStreaming}`);
        const ollamaBody = Buffer.from(JSON.stringify(buildOllamaRequest(parsed)), "utf8");

        const nativeParsed = new URL(nativeOrigin);
        const ollamaReq = http.request(
          {
            hostname: nativeParsed.hostname,
            port: nativeParsed.port ? Number(nativeParsed.port) : 80,
            path: "/api/chat",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": String(ollamaBody.length),
            },
          },
          (ollamaRes) => {
            const resChunks: Buffer[] = [];
            ollamaRes.on("data", (c: Buffer) => resChunks.push(c));
            ollamaRes.on("end", () => {
              let ollamaJson: Record<string, unknown> = {};
              try {
                ollamaJson = JSON.parse(
                  Buffer.concat(resChunks).toString("utf8"),
                ) as Record<string, unknown>;
              } catch {
                // unexpected non-JSON — return 502
                if (!clientRes.headersSent) clientRes.writeHead(502);
                clientRes.end();
                return;
              }

              const completionId = nextCompletionId();
              const openAIResp = buildOpenAIResponse(ollamaJson, completionId);

              if (clientWantsStreaming) {
                const sseBody = buildSSEBuffer(openAIResp);
                clientRes.writeHead(200, {
                  "content-type": "text/event-stream",
                  "cache-control": "no-cache",
                  "x-accel-buffering": "no",
                });
                clientRes.end(sseBody);
              } else {
                const respBody = Buffer.from(JSON.stringify(openAIResp), "utf8");
                clientRes.writeHead(200, {
                  "content-type": "application/json",
                  "content-length": String(respBody.length),
                });
                clientRes.end(respBody);
              }
            });
          },
        );

        ollamaReq.on("error", () => {
          if (!clientRes.headersSent) clientRes.writeHead(502);
          clientRes.end();
        });

        ollamaReq.write(ollamaBody);
        ollamaReq.end();
      });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const proxyUrl = `http://127.0.0.1:${port}${targetPathname}`;
      resolve({
        proxyUrl,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function forwardToTarget(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  body: Buffer,
  targetOrigin: string,
  targetPathname: string,
): void {
  const parsed = new URL(targetOrigin);
  const forwardHeaders: http.OutgoingHttpHeaders = { ...clientReq.headers };
  const { hostname, port } = parsed;
  forwardHeaders["host"] = port ? `${hostname}:${port}` : hostname;
  if (body.length > 0) forwardHeaders["content-length"] = String(body.length);
  delete forwardHeaders["transfer-encoding"];

  const proxyReq = http.request(
    {
      hostname,
      port: port ? Number(port) : 80,
      path: clientReq.url ?? "/",
      method: clientReq.method,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(clientRes);
    },
  );

  proxyReq.on("error", () => {
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end();
  });

  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

// ── Extract baseURL from config ────────────────────────────────────────────────

function extractOllamaBaseUrl(config: Record<string, unknown>): string | null {
  if (!isPlainObject(config.provider)) return null;
  for (const providerData of Object.values(config.provider)) {
    if (!isPlainObject(providerData)) continue;
    if (!isPlainObject(providerData.options)) continue;
    const url = providerData.options.baseURL;
    if (typeof url === "string" && url.length > 0) return url;
  }
  return null;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  if (!skipPermissions) {
    return { env: input.env, notes: [], cleanup: async () => {} };
  }

  // For remote execution targets the host XDG_CONFIG_HOME path is meaningless
  // (and actively harmful — it leaks a macOS-only path into the remote Linux
  // env). Callers that need to ship a runtime opencode config to the remote
  // box do that via prepareAdapterExecutionTargetRuntime in execute.ts; this
  // host-fs helper is local-only.
  if (input.targetIsRemote) {
    return { env: input.env, notes: [], cleanup: async () => {} };
  }

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    await fs.cp(sourceConfigDir, runtimeConfigDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  const existingConfig = await readJsonObject(runtimeConfigPath);
  const existingPermission = isPlainObject(existingConfig.permission)
    ? existingConfig.permission
    : {};
  const nextConfig: Record<string, unknown> = {
    ...existingConfig,
    permission: {
      ...existingPermission,
      external_directory: "allow",
    },
  };

  const notes: string[] = [
    "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
  ];

  // Start the gemma4 think:false proxy if there is an Ollama provider with a baseURL.
  // The proxy intercepts /v1/chat/completions requests for gemma4 models and translates
  // them to native /api/chat with think:false — the only Ollama endpoint that honours it.
  const ollamaBaseUrl = extractOllamaBaseUrl(nextConfig);
  let proxyHandle: ProxyHandle | null = null;

  if (ollamaBaseUrl !== null) {
    try {
      proxyHandle = await startGemma4ThinkProxy(ollamaBaseUrl);

      // Rewrite baseURL in the config to route opencode through the proxy
      if (isPlainObject(nextConfig.provider)) {
        for (const providerData of Object.values(nextConfig.provider)) {
          if (!isPlainObject(providerData) || !isPlainObject(providerData.options)) continue;
          if (typeof providerData.options.baseURL === "string") {
            providerData.options.baseURL = proxyHandle.proxyUrl;
          }
        }
      }

      notes.push(
        `Started gemma4 think:false proxy at ${proxyHandle.proxyUrl} (intercepts /api/chat translation for gemma4 models; passes other models through to ${ollamaBaseUrl}).`,
      );
    } catch {
      // Proxy failed to start — proceed without it; gemma4 thinking tokens will be unsuppressed
      notes.push("Warning: failed to start gemma4 think:false proxy; harmony-channel tokens may appear.");
      proxyHandle = null;
    }
  }

  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes,
    cleanup: async () => {
      if (proxyHandle) await proxyHandle.close();
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}
