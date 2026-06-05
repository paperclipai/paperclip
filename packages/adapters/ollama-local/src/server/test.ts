import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OLLAMA_ENDPOINT, DEFAULT_OLLAMA_MODEL } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function normalizeEndpoint(raw: unknown): string {
  const value = asString(raw, DEFAULT_OLLAMA_ENDPOINT).trim();
  const candidate = value.length > 0 ? value : DEFAULT_OLLAMA_ENDPOINT;
  return candidate.replace(/\/+$/, "");
}

interface OllamaTag {
  name?: string;
  model?: string;
}

interface OllamaTagsResponse {
  models?: OllamaTag[];
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const endpoint = normalizeEndpoint(config.endpoint);
  const model = asString(config.model, DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const timeoutMs = Math.max(1000, Math.floor(asNumber(config.testTimeoutMs, 5000)));

  if (ctx.executionTarget && ctx.executionTarget.kind === "remote") {
    checks.push({
      code: "ollama_local_remote_unsupported",
      level: "warn",
      message:
        "ollama_local probes the Paperclip host directly; remote execution targets are not yet supported by testEnvironment.",
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${endpoint}/api/tags`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      checks.push({
        code: "ollama_tags_http_error",
        level: "error",
        message: `Ollama /api/tags returned HTTP ${res.status} at ${endpoint}`,
        hint: "Confirm `ollama serve` is running and the endpoint is reachable.",
      });
      return { adapterType: "ollama_local", status: "fail", checks, testedAt: new Date().toISOString() };
    }
    const payload = (await res.json()) as OllamaTagsResponse;
    const tags = Array.isArray(payload.models) ? payload.models : [];
    const availableIds = tags
      .map((t) => (typeof t?.name === "string" && t.name) || (typeof t?.model === "string" && t.model) || "")
      .filter(Boolean);
    checks.push({
      code: "ollama_reachable",
      level: "info",
      message: `Ollama reachable at ${endpoint} (${availableIds.length} models pulled).`,
    });
    const hasModel = availableIds.some((id) => id === model || id.startsWith(`${model}:`) || id.startsWith(model));
    if (!hasModel) {
      checks.push({
        code: "ollama_model_missing",
        level: "warn",
        message: `Configured model "${model}" is not pulled.`,
        hint: `Run: ollama pull ${model}`,
        detail: availableIds.length > 0 ? `Available: ${availableIds.slice(0, 10).join(", ")}` : null,
      });
    } else {
      checks.push({
        code: "ollama_model_present",
        level: "info",
        message: `Configured model "${model}" is available locally.`,
      });
    }
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      code: aborted ? "ollama_tags_timeout" : "ollama_tags_unreachable",
      level: "error",
      message: aborted
        ? `Ollama /api/tags timed out after ${timeoutMs}ms (${endpoint}).`
        : `Could not reach Ollama at ${endpoint}: ${message}`,
      hint: "Install Ollama from https://ollama.com and run `ollama serve`.",
    });
  } finally {
    clearTimeout(timer);
  }

  return {
    adapterType: "ollama_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
