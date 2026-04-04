import * as https from "node:https";
import { URL } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";

interface DashScopeMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// OpenAI 兼容响应格式
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      reasoning_content?: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function callDashScopeAPI(
  apiKey: string,
  model: string,
  messages: DashScopeMessage[],
  options: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    timeoutSec?: number;
  },
): Promise<{ response: OpenAIResponse; latencyMs: number }> {
  // 百炼 Coding Plan 端点（OpenAI 兼容）
  const url = new URL("https://coding.dashscope.aliyuncs.com/v1/chat/completions");
  
  const requestBody = {
    model,
    messages,
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...(options.topP !== undefined && { top_p: options.topP }),
    ...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
  };

  const body = JSON.stringify(requestBody);
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: (options.timeoutSec ?? 120) * 1000,
    }, (res) => {
      let responseData = "";
      res.on("data", (chunk) => { responseData += chunk; });
      res.on("end", () => {
        const latencyMs = Date.now() - startTime;
        if (res.statusCode !== 200) {
          reject(new Error(`DashScope API error: ${res.statusCode} ${res.statusMessage}\n${responseData}`));
          return;
        }
        try {
          const response: OpenAIResponse = JSON.parse(responseData);
          resolve({ response, latencyMs });
        } catch (e) {
          reject(new Error(`Failed to parse DashScope response: ${e}\n${responseData}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`DashScope API timeout after ${options.timeoutSec ?? 120}s`));
    });

    req.write(body);
    req.end();
  });
}

interface DashScopeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

function buildDashScopeRuntimeConfig(input: DashScopeExecutionInput) {
  const { config, context } = input;
  
  const workspaceContext = parseObject(context.paperclipWorkspace ?? {});
  const cwd = asString(workspaceContext.cwd, "") || asString(config.cwd, "") || process.cwd();
  
  const envConfig = parseObject(config.env ?? {});
  const env: Record<string, string> = { ...buildPaperclipEnv(input.agent) };
  env.PAPERCLIP_RUN_ID = input.runId;
  
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  
  if (input.authToken && !env.DASHSCOPE_API_KEY) {
    env.DASHSCOPE_API_KEY = input.authToken;
  }

  // Fallback to container environment variable if not set in config or authToken
  if (!env.DASHSCOPE_API_KEY) {
    env.DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || "";
  }

  return { cwd, env };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, authToken } = ctx;

  const model = asString(config.model, "");
  const temperature = asNumber(config.temperature, 0.7);
  const topP = asNumber(config.topP, 0.8);
  const maxTokens = asNumber(config.maxTokens, 0);
  const timeoutSec = asNumber(config.timeoutSec, 120);
  
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([sessionHandoffNote, renderedPrompt]);

  const runtimeConfig = buildDashScopeRuntimeConfig({ runId, agent, config, context, authToken });
  const apiKey = runtimeConfig.env.DASHSCOPE_API_KEY;

  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "DashScope API key not found. Set DASHSCOPE_API_KEY in config.env or provide authToken.",
      errorCode: "auth_required",
      errorMeta: { missingEnv: "DASHSCOPE_API_KEY" },
    };
  }

  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Model not specified. Set config.model to a valid DashScope model (e.g., qwen3.5-plus, qwen-coder-plus).",
      errorCode: "invalid_config",
    };
  }

  await onLog("stdout", `[paperclip] Calling DashScope API with model: ${model}\n`);

  const messages: DashScopeMessage[] = [
    { role: "system", content: "You are a helpful AI assistant integrated with Paperclip." },
    { role: "user", content: prompt },
  ];

  try {
    const { response, latencyMs } = await callDashScopeAPI(apiKey, model, messages, {
      temperature,
      topP,
      maxTokens: maxTokens > 0 ? maxTokens : undefined,
      timeoutSec,
    });

    await onLog("stdout", `[paperclip] DashScope response in ${latencyMs}ms\n`);
    await onLog("stdout", `[paperclip] Tokens: prompt=${response.usage.prompt_tokens}, completion=${response.usage.completion_tokens}\n`);

    // OpenAI 兼容响应格式解析
    const outputText = response.choices[0]?.message?.content ?? "";
    const finishReason = response.choices[0]?.finish_reason ?? "stop";

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      errorCode: null,
      usage: {
        inputTokens: response.usage.prompt_tokens,
        cachedInputTokens: 0,
        outputTokens: response.usage.completion_tokens,
      },
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      provider: "dashscope",
      biller: "dashscope",
      model,
      billingType: "api",
      costUsd: 0,
      resultJson: {
        choices: response.choices,
        usage: response.usage,
        id: response.id,
        latency_ms: latencyMs,
      },
      summary: outputText,
      clearSession: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await onLog("stderr", `[paperclip] DashScope error: ${errorMessage}\n`);
    
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage,
      errorCode: "api_error",
      errorMeta: { model, provider: "dashscope" },
    };
  }
}

export { type AdapterSessionCodec } from "@paperclipai/adapter-utils";
export const sessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : typeof record.session_id === "string" ? record.session_id : null;
    if (!sessionId) return null;
    const cwd = typeof record.cwd === "string" ? record.cwd : typeof record.workdir === "string" ? record.workdir : undefined;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : typeof params.session_id === "string" ? params.session_id : null;
    if (!sessionId) return null;
    const cwd = typeof params.cwd === "string" ? params.cwd : typeof params.workdir === "string" ? params.workdir : undefined;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return typeof params.sessionId === "string" ? params.sessionId : typeof params.session_id === "string" ? params.session_id : null;
  },
};
