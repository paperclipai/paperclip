import type {
  HireApprovedPayload,
  HireApprovedHookResult,
} from "@paperclipai/adapter-utils";
import { createAgent, createEnvironment } from "./client.js";

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

// Called when a new agent is approved in Paperclip (join_request or hire_agent).
// Creates the backing Managed Agents + Environments objects and returns their
// ids in `detail`. The caller (registry / execute()) is responsible for
// persisting these ids into adapterConfig (or sessionParams on first run).
export async function onHireApproved(
  payload: HireApprovedPayload,
  adapterConfig: Record<string, unknown>,
): Promise<HireApprovedHookResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "ANTHROPIC_API_KEY not set on server" };
  }

  try {
    const model = readString(adapterConfig.model) ?? "claude-haiku-4-5-20251001";
    const role = readString(adapterConfig.role) ?? payload.agentName;

    const [agent, environment] = await Promise.all([
      createAgent(apiKey, {
        name: `paperclip-${payload.companyId.slice(0, 8)}-${payload.agentId.slice(0, 8)}`,
        model,
        system: `You are ${role}. Bootstrap system prompt; rewritten at first run.`,
      }),
      createEnvironment(apiKey, `paperclip-${payload.agentId.slice(0, 8)}`),
    ]);

    return {
      ok: true,
      detail: {
        agentId: agent.id,
        agentVersion: agent.version,
        environmentId: environment.id,
        message: payload.message,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
