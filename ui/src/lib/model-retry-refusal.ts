import type { ToastInput } from "../context/ToastContext";
import { agentUrl } from "./utils";

export const MODEL_STILL_UNAVAILABLE_CODE = "native_provider_model_still_unavailable";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function modelStillUnavailableToast(
  error: unknown,
  agent: { id: string; name?: string | null; urlKey?: string | null } | undefined,
): ToastInput | null {
  const details = record(record(record(error).body).details);
  if (details.code !== MODEL_STILL_UNAVAILABLE_CODE) return null;
  const body = error instanceof Error && error.message ? error.message : "The selected model is still unavailable.";
  const agentSetting = details.setting !== "task_model_override";
  return {
    title: "Model still unavailable",
    body,
    tone: "error",
    ttlMs: 15_000,
    dedupeKey: `model-still-unavailable:${String(details.agentId ?? agent?.id ?? "")}`,
    ...(agentSetting && agent
      ? { action: { label: `Open ${agent.name ?? "agent"} model settings`, href: `${agentUrl(agent)}/runtime` } }
      : {}),
  };
}
