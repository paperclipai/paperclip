import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startActiveObservation, type LangfuseSpan } from "@langfuse/tracing";
import type { AdapterExecutionResult } from "./adapters/types.js";
import { logger } from "./middleware/logger.js";
import { serverVersion } from "./version.js";

const DEFAULT_LANGFUSE_BASE_URL = "https://us.cloud.langfuse.com";

let sdk: NodeSDK | null = null;
let started = false;

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function readBooleanEnv(name: string): boolean | null {
  const value = readEnv(name)?.toLowerCase();
  if (!value) return null;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

export function getLangfuseRuntimeStatus() {
  const publicKey = readEnv("LANGFUSE_PUBLIC_KEY");
  const secretKey = readEnv("LANGFUSE_SECRET_KEY");
  const disabled = readBooleanEnv("LANGFUSE_ENABLED") === false;
  const configured = !disabled && Boolean(publicKey && secretKey);

  return {
    configured,
    started,
    public_key: Boolean(publicKey),
    secret_key: Boolean(secretKey),
    base_url: readEnv("LANGFUSE_BASE_URL") ?? readEnv("LANGFUSE_HOST") ?? DEFAULT_LANGFUSE_BASE_URL,
    record_io: shouldRecordLangfuseIo(),
  };
}

export function isLangfuseConfigured(): boolean {
  return getLangfuseRuntimeStatus().configured;
}

export function shouldRecordLangfuseIo(): boolean {
  return readBooleanEnv("LANGFUSE_RECORD_IO") ?? readBooleanEnv("AI_SDK_TELEMETRY_RECORD_IO") ?? false;
}

function maskLangfuseData(params: { data: unknown }) {
  return maskValue(params.data);
}

function maskValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "***REDACTED***")
      .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, "$1=***REDACTED***");
  }
  if (Array.isArray(value)) return value.map(maskValue);
  if (!value || typeof value !== "object") return value;

  const masked: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/api[_-]?key|token|secret|password|authorization/i.test(key)) {
      masked[key] = "***REDACTED***";
    } else {
      masked[key] = maskValue(entry);
    }
  }
  return masked;
}

export function initLangfuseObservability(): NodeSDK | null {
  if (sdk || started) return sdk;
  if (!isLangfuseConfigured()) return null;

  sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        baseUrl: getLangfuseRuntimeStatus().base_url,
        environment: readEnv("LANGFUSE_TRACING_ENVIRONMENT") ?? readEnv("NODE_ENV") ?? "development",
        release: readEnv("LANGFUSE_RELEASE") ?? serverVersion,
        mask: maskLangfuseData,
      }),
    ],
  });

  try {
    sdk.start();
    started = true;
    return sdk;
  } catch (error) {
    started = false;
    sdk = null;
    logger.warn({ err: error }, "failed to initialize Langfuse observability");
    return null;
  }
}

export async function shutdownLangfuseObservability() {
  if (!sdk || !started) return;
  const activeSdk = sdk;
  sdk = null;
  started = false;
  await activeSdk.shutdown().catch((error) => {
    logger.warn({ err: error }, "failed to shutdown Langfuse observability");
  });
}

type HeartbeatTraceInput = {
  runId: string;
  companyId: string;
  agentId: string;
  adapterType: string;
  issueId?: string | null;
  projectId?: string | null;
  invocationSource?: string | null;
};

function summarizeAdapterOutcome(result: AdapterExecutionResult) {
  const status =
    result.timedOut
      ? "timed_out"
      : (result.exitCode ?? 0) === 0 && !result.errorMessage
        ? "succeeded"
        : "failed";

  return {
    status,
    exit_code: result.exitCode ?? null,
    timed_out: result.timedOut,
    error_code: result.errorCode ?? null,
    provider: result.provider ?? null,
    model: result.model ?? null,
    biller: result.biller ?? null,
    billing_type: result.billingType ?? null,
    cost_usd: result.costUsd ?? null,
    input_tokens: result.usage?.inputTokens ?? null,
    cached_input_tokens: result.usage?.cachedInputTokens ?? null,
    output_tokens: result.usage?.outputTokens ?? null,
  };
}

export async function traceHeartbeatAdapterExecution<T extends AdapterExecutionResult>(
  input: HeartbeatTraceInput,
  execute: (span: LangfuseSpan | null) => Promise<T>,
): Promise<T> {
  if (!started) return execute(null);

  const metadata = {
    run_id: input.runId,
    company_id: input.companyId,
    agent_id: input.agentId,
    adapter_type: input.adapterType,
    issue_id: input.issueId ?? null,
    project_id: input.projectId ?? null,
    invocation_source: input.invocationSource ?? null,
    service: "paperclip",
  };

  return startActiveObservation(
    "paperclip.heartbeat.adapter_execute",
    async (span) => {
      span.update({
        metadata,
        level: "DEFAULT",
        statusMessage: "running",
      });

      try {
        const result = await execute(span);
        const outcome = summarizeAdapterOutcome(result);
        span.update({
          metadata: {
            ...metadata,
            ...outcome,
          },
          level: outcome.status === "succeeded" ? "DEFAULT" : "ERROR",
          statusMessage: outcome.status,
        });
        return result;
      } catch (error) {
        span.update({
          metadata: {
            ...metadata,
            thrown: true,
            error_name: error instanceof Error ? error.name : "Error",
          },
          level: "ERROR",
          statusMessage: error instanceof Error ? error.message : "Adapter execution failed",
        });
        throw error;
      }
    },
  );
}
