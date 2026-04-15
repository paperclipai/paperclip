import * as http from "node:http";
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

interface DashScopeUsage {
  input_tokens: number;
  output_tokens: number;
}

interface DashScopeResponse {
  output?: {
    text: string;
    finish_reason?: string;
  };
  choices?: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
  }>;
  usage: DashScopeUsage;
  request_id: string;
}

interface CallDashScopeOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeoutSec?: number;
  baseUrl: string;
}

/**
 * Call DashScope Coding Plan API
 * Uses OpenAI compatible format: https://coding.dashscope.aliyuncs.com/v1/chat/completions
 */
async function callDashScopeAPI(
  apiKey: string,
  model: string,
  messages: DashScopeMessage[],
  options: CallDashScopeOptions,
): Promise<{ response: DashScopeResponse; latencyMs: number }> {
  // Coding Plan endpoint (OpenAI compatible format)
  const url = new URL(`${options.baseUrl}/chat/completions`);
  
  // Build request body in OpenAI compatible format
  const requestBody = {
    model,
    messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    top_p: options.topP,
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
          reject(new Error(`DashScope Coding Plan API error: ${res.statusCode} ${res.statusMessage}\n${responseData}`));
          return;
        }
        try {
          const response: DashScopeResponse = JSON.parse(responseData);
          resolve({ response, latencyMs });
        } catch (e) {
          reject(new Error(`Failed to parse DashScope response: ${e}\n${responseData}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`DashScope Coding Plan API timeout after ${options.timeoutSec ?? 120}s`));
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

  // Fallback to container environment variable
  if (!env.DASHSCOPE_API_KEY) {
    env.DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || "";
  }

  return { cwd, env };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, authToken } = ctx;

  const model = asString(config.model, "");
  const baseUrl = asString(config.baseUrl, "https://coding.dashscope.aliyuncs.com/v1"); // Default to Coding Plan endpoint
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
      errorMessage: "Model not specified. Set config.model to a valid DashScope model (e.g., qwen3.5-plus, qwen3-max).",
      errorCode: "invalid_config",
    };
  }

  // Log configuration
  await onLog("stdout", `[paperclip] Using DashScope Coding Plan endpoint\n`);
  await onLog("stdout", `[paperclip] Endpoint: ${baseUrl}/chat/completions\n`);
  await onLog("stdout", `[paperclip] Model: ${model}\n`);

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
      baseUrl,
    });

    await onLog("stdout", `[paperclip] DashScope response in ${latencyMs}ms\n`);
    await onLog("stdout", `[paperclip] Tokens: input=${response.usage.input_tokens}, output=${response.usage.output_tokens}\n`);

    // Extract output from OpenAI compatible format
    let outputText = "";
    let finishReason = "stop";
    
    if (response.choices?.[0]?.message?.content !== undefined) {
      outputText = response.choices[0].message.content;
      finishReason = response.choices[0].finish_reason ?? "stop";
    } else if (response.output?.text !== undefined) {
      // Fallback for alternative format
      outputText = response.output.text;
      finishReason = response.output.finish_reason ?? "stop";
    } else {
      // Fallback for unexpected response format
      outputText = JSON.stringify(response);
    }

    // Output the actual response content to transcript
    if (outputText) {
      await onLog("stdout", `${outputText}\n`);
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      errorCode: null,
      usage: {
        inputTokens: response.usage.input_tokens,
        cachedInputTokens: 0,
        outputTokens: response.usage.output_tokens,
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
        output: response.output || response.choices?.[0],
        usage: response.usage,
        request_id: response.request_id,
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
