import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  buildChatEndpoint,
  classifyOllamaFailure,
  classifyOllamaTransportFailure,
  readResponseBody,
  type OllamaApiMode,
} from "./client.js";

type JsonRecord = Record<string, unknown>;
type OllamaToolCall = { id: string; name: string; arguments: JsonRecord };
type OllamaTool = JsonRecord & { type: "function"; function: JsonRecord & { name: string; parameters: JsonRecord } };
type RuntimeMcpServer = { name: string; url: string; token: string; connectionId: string };
type RuntimeMcpTool = { name: string; description?: string; inputSchema: JsonRecord; server: RuntimeMcpServer };
let mcpRequestCounter = 0;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readToolCalls(message: JsonRecord): OllamaToolCall[] {
  return asArray(message.tool_calls).flatMap((raw, index) => {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (!fn) return [];
    const args = typeof fn.arguments === "string" ? parseJsonObject(fn.arguments) : asRecord(fn.arguments);
    return [{
      id: asString(call?.id, `ollama-tool-${index + 1}`),
      name: asString(fn.name, "tool"),
      arguments: args ?? {},
    }];
  });
}

function parseJsonObject(value: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function readMessage(body: JsonRecord): JsonRecord {
  const choice = asRecord(asArray(body.choices)[0]);
  const openAiMessage = asRecord(choice?.message);
  if (openAiMessage) return openAiMessage;
  return asRecord(body.message) ?? {};
}

function readUsage(body: JsonRecord) {
  const usage = asRecord(body.usage);
  return {
    inputTokens: asNumber(usage?.prompt_tokens ?? usage?.input_tokens, 0),
    outputTokens: asNumber(usage?.completion_tokens ?? usage?.output_tokens, 0),
    cachedInputTokens: asNumber(usage?.prompt_tokens_details && asRecord(usage.prompt_tokens_details)?.cached_tokens, 0),
  };
}

function readPrompt(ctx: AdapterExecutionContext): string {
  const direct = asString(ctx.config.prompt, "").trim();
  if (direct) return direct;
  const taskMarkdown = asString(ctx.context.paperclipTaskMarkdown, "").trim();
  if (taskMarkdown) return taskMarkdown;
  const taskBody = asString(ctx.context.taskBody, "").trim();
  if (taskBody) return taskBody;
  return "Continue the assigned task.";
}

function readToolResults(context: Record<string, unknown>): JsonRecord[] {
  return asArray(context.toolResults).map(asRecord).filter((value): value is JsonRecord => value !== null);
}

function readToolSchemas(value: unknown): OllamaTool[] {
  return asArray(value).flatMap((raw) => {
    const tool = asRecord(raw);
    if (!tool) return [];
    if (tool.type === "function") {
      const fn = asRecord(tool.function);
      const name = asString(fn?.name, "").trim();
      if (!name) return [];
      return [{
        ...tool,
        type: "function",
        function: {
          ...fn,
          name,
          parameters: asRecord(fn?.parameters) ?? { type: "object", properties: {} },
        },
      } as OllamaTool];
    }
    const name = asString(tool.name, "").trim();
    if (!name) return [];
    return [{
      type: "function",
      function: {
        name,
        ...(asString(tool.description, "") ? { description: asString(tool.description, "") } : {}),
        parameters: asRecord(tool.inputSchema ?? tool.parameters) ?? { type: "object", properties: {} },
      },
    } as OllamaTool];
  });
}

function readRuntimeMcpServers(ctx: AdapterExecutionContext): RuntimeMcpServer[] {
  return (ctx.runtimeMcp?.getServers() ?? []).flatMap((raw) => {
    const server = asRecord(raw);
    const name = asString(server?.name, "").trim();
    const url = asString(server?.url, "").trim();
    const token = asString(server?.token, "").trim();
    const connectionId = asString(server?.connectionId, "").trim();
    return name && url && token && connectionId ? [{ name, url, token, connectionId }] : [];
  });
}

function readManagedMcpServers(ctx: AdapterExecutionContext): RuntimeMcpServer[] {
  const managed = asRecord(ctx.context.paperclipManagedMcp);
  const configuredBase = asString(process.env.PAPERCLIP_API_URL, "").trim().replace(/\/+$/, "").replace(/\/api$/, "");
  return asArray(managed?.gateways).flatMap((raw) => {
    const gateway = asRecord(raw);
    const endpointPath = asString(gateway?.endpointPath, "").trim();
    const bearerToken = asString(gateway?.bearerToken, "").trim();
    const id = asString(gateway?.id, "").trim();
    const name = asString(gateway?.name, "Paperclip tools").trim() || "Paperclip tools";
    const url = endpointPath.startsWith("http")
      ? endpointPath
      : configuredBase && endpointPath
        ? `${configuredBase}${endpointPath.startsWith("/") ? "" : "/"}${endpointPath}`
        : "";
    return url && bearerToken && id ? [{ name, url, token: bearerToken, connectionId: id }] : [];
  });
}

function mcpHeaders(server: RuntimeMcpServer): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: "Bearer " + server.token,
  };
}

async function callMcp(server: RuntimeMcpServer, method: string, params: JsonRecord = {}): Promise<JsonRecord> {
  const requestId = `ollama-${Date.now()}-${mcpRequestCounter += 1}`;
  const response = await fetch(server.url, {
    method: "POST",
    headers: mcpHeaders(server),
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
  });
  const body = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) throw new Error(`Paperclip MCP gateway returned HTTP ${response.status}`);
  const error = asRecord(body.error);
  if (error) throw new Error(asString(error.message, "Paperclip MCP tool call failed"));
  return asRecord(body.result) ?? {};
}

async function discoverRuntimeMcpTools(servers: RuntimeMcpServer[]): Promise<RuntimeMcpTool[]> {
  const discovered: RuntimeMcpTool[] = [];
  for (const server of servers) {
    const response = await callMcp(server, "tools/list");
    for (const raw of asArray(response.tools)) {
      const tool = asRecord(raw);
      const name = asString(tool?.name, "").trim();
      const inputSchema = asRecord(tool?.inputSchema) ?? { type: "object", properties: {} };
      if (name) discovered.push({ name, description: asString(tool?.description, "") || undefined, inputSchema, server });
    }
  }
  return discovered;
}

function toolResultContent(result: JsonRecord): string {
  const content = asArray(result.content);
  const text = content
    .map((item) => asRecord(item))
    .map((item) => asString(item?.text, ""))
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  return result.structuredContent === undefined
    ? JSON.stringify(result)
    : JSON.stringify(result.structuredContent);
}

async function executeRuntimeMcpTool(tool: RuntimeMcpTool, call: OllamaToolCall): Promise<string> {
  const result = await callMcp(tool.server, "tools/call", {
    name: tool.name,
    arguments: call.arguments,
  });
  return toolResultContent(result);
}

function buildToolResultMessages(results: JsonRecord[], apiMode: OllamaApiMode): JsonRecord[] {
  return results.flatMap((result) => {
    const toolCallId = asString(result.toolCallId ?? result.tool_call_id ?? result.id, "");
    if (!toolCallId) return [];
    const content = result.content === undefined
      ? JSON.stringify(result.result ?? result.error ?? null)
      : typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    return [apiMode === "ollama"
      ? { role: "tool", content }
      : { role: "tool", tool_call_id: toolCallId, content }];
  });
}

function nativeResponseFormat(responseFormat: JsonRecord): unknown {
  if (responseFormat.type === "json_schema") {
    const schema = asRecord(responseFormat.json_schema);
    return schema?.schema ?? schema ?? responseFormat;
  }
  return responseFormat.type === "json_object" ? "json" : responseFormat.type ?? responseFormat;
}

function makeSessionParams(baseUrl: string, model: string) {
  return { baseUrl, model };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const baseUrl = asString(ctx.config.baseUrl ?? ctx.config.url, "http://127.0.0.1:11434");
  const apiMode = (asString(ctx.config.apiMode, "openai") || "openai") as OllamaApiMode;
  const model = asString(ctx.config.model, "").trim();
  if (!model) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: "ollama_local requires adapterConfig.model",
      errorCode: "model_refusal",
      errorFamily: "model_refusal",
    };
  }

  const endpoint = buildChatEndpoint(baseUrl, apiMode);
  const timeoutSec = asNumber(ctx.config.timeoutSec, 300);
  const stream = ctx.config.stream !== false;
  const maxToolRounds = Math.max(0, Math.min(8, Math.floor(asNumber(ctx.config.maxToolRounds, 4))));
  const runtimeMcpServers = [
    ...readRuntimeMcpServers(ctx),
    ...readManagedMcpServers(ctx),
  ].filter((server, index, servers) => servers.findIndex((candidate) => candidate.connectionId === server.connectionId) === index);
  let runtimeMcpTools: RuntimeMcpTool[] = [];
  try {
    runtimeMcpTools = await discoverRuntimeMcpTools(runtimeMcpServers);
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: error instanceof Error ? error.message : "Paperclip MCP discovery failed",
      errorCode: "tool_discovery_failed",
      errorFamily: "transient_upstream",
      model,
      provider: "ollama",
    };
  }
  const configuredTools = [
    ...readToolSchemas(ctx.config.tools),
    ...readToolSchemas(ctx.context.tools),
    ...readToolSchemas(ctx.context.toolSchemas),
    ...runtimeMcpTools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.inputSchema,
      },
    })),
  ].filter((tool, index, tools) => tools.findIndex((candidate) => candidate.function.name === tool.function.name) === index);
  ctx.config.tools = configuredTools;
  const runtimeToolsByName = new Map(runtimeMcpTools.map((tool) => [tool.name, tool]));
  const responseFormat = asRecord(ctx.config.responseFormat ?? ctx.config.structuredOutput);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = asString(ctx.config.apiKey ?? ctx.config.ollamaApiKey, "").trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const messages: JsonRecord[] = [];
  const systemPrompt = asString(ctx.config.systemPrompt, "").trim();
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: readPrompt(ctx) });

  let finalBody: JsonRecord = {};
  let allToolCalls: OllamaToolCall[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;
  let toolTurns = 0;
  const toolResultsForReceipt: JsonRecord[] = [];

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const payload: JsonRecord = {
      model,
      messages,
      stream,
      ...(configuredTools.length > 0 ? { tools: configuredTools } : {}),
      ...(responseFormat
        ? apiMode === "ollama"
          ? { format: nativeResponseFormat(responseFormat) }
          : { response_format: responseFormat }
        : {}),
      ...(ctx.config.options && asRecord(ctx.config.options) ? { options: ctx.config.options } : {}),
    };
    const controller = new AbortController();
    const timer = timeoutSec > 0 ? setTimeout(() => controller.abort(), timeoutSec * 1000) : null;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const failure = classifyOllamaFailure(response.status, detail);
        return {
          exitCode: null,
          signal: null,
          timedOut: failure.errorCode === "timeout",
          errorMessage: failure.message,
          errorCode: failure.errorCode,
          errorFamily: failure.errorFamily,
          model,
          provider: "ollama",
          sessionParams: makeSessionParams(baseUrl, model),
          sessionDisplayId: model,
        };
      }
      finalBody = await readResponseBody(response, {
        stream,
        onDelta: (text) => ctx.onLog("stdout", text),
      });
    } catch (error) {
      const failure = classifyOllamaTransportFailure(error);
      return {
        exitCode: null,
        signal: null,
        timedOut: failure.errorCode === "timeout",
        errorMessage: failure.message,
        errorCode: failure.errorCode,
        errorFamily: failure.errorFamily,
        model,
        provider: "ollama",
        sessionParams: makeSessionParams(baseUrl, model),
        sessionDisplayId: model,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const usage = readUsage(finalBody);
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
    totalCachedInputTokens += usage.cachedInputTokens;
    const message = readMessage(finalBody);
    const toolCalls = readToolCalls(message);
    if (toolCalls.length === 0) break;
    toolTurns += 1;
    allToolCalls.push(...toolCalls);
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    if (round >= maxToolRounds) break;
    const suppliedResults = readToolResults(ctx.context);
    const toolResults = (await Promise.all(toolCalls.map(async (toolCall, toolIndex) => {
      const supplied = suppliedResults.find((result) =>
        asString(result.toolCallId ?? result.tool_call_id ?? result.id, "") === toolCall.id
        || asString(result.name, "") === toolCall.name,
      ) ?? suppliedResults[toolIndex];
      let content: string;
      let error: string | undefined;
      await ctx.onEvent?.({
        eventType: "ollama.tool_call",
        stream: "stdout",
        level: "info",
        payload: { toolCallId: toolCall.id, name: toolCall.name, input: toolCall.arguments },
      });
      try {
        content = runtimeToolsByName.has(toolCall.name)
          ? await executeRuntimeMcpTool(runtimeToolsByName.get(toolCall.name)!, toolCall)
          : supplied
            ? (supplied.content === undefined ? JSON.stringify(supplied.result ?? supplied.error ?? null) : String(supplied.content))
            : "No executor is bound for this tool.";
      } catch (toolError) {
        content = toolError instanceof Error ? toolError.message : "Tool execution failed";
        error = "tool_execution_failed";
      }
      const receipt = { toolCallId: toolCall.id, name: toolCall.name, content, ...(error ? { error } : {}) };
      toolResultsForReceipt.push(receipt);
      await ctx.onEvent?.({
        eventType: "ollama.tool_result",
        stream: error ? "stderr" : "stdout",
        level: error ? "error" : "info",
        payload: receipt,
      });
      return receipt;
    }))).map((result) => result);
    if (toolResults.length === 0) break;
    messages.push(...buildToolResultMessages(toolResults, apiMode));
  }

  const message = readMessage(finalBody);
  const content = typeof message.content === "string" ? message.content : "";
  const structuredOutput = responseFormat && content ? parseJsonObject(content) : null;
  if (responseFormat && content && !structuredOutput) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: "Ollama returned invalid structured output",
      errorCode: "model_refusal",
      errorFamily: "model_refusal",
      model,
      provider: "ollama",
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedInputTokens: totalCachedInputTokens,
    },
    sessionParams: makeSessionParams(baseUrl, model),
    sessionDisplayId: model,
    provider: "ollama",
    biller: "ollama",
    model,
    billingType: "unknown",
    resultJson: {
      ...(content ? { response: content } : {}),
      ...(structuredOutput ? { structuredOutput } : {}),
      ...(allToolCalls.length > 0 ? { toolCalls: allToolCalls } : {}),
      ...(toolTurns > 0 ? { tool_turns: toolTurns, toolResults: toolResultsForReceipt } : {}),
      finishReason: asString(asRecord(asArray(finalBody.choices)[0])?.finish_reason ?? finalBody.done_reason, "stop"),
    },
    summary: content || (allToolCalls.length > 0 ? `Requested ${allToolCalls.length} tool call(s)` : "Ollama completed"),
  };
}
