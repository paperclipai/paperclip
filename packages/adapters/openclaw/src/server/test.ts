import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { rpcCall } from "./rpc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

// ---------------------------------------------------------------------------
// testEnvironment()
// ---------------------------------------------------------------------------

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const gatewayUrl = asString(config.gatewayUrl, "").trim();
  const agentId = asString(config.agentId, "").trim();
  const authToken = asString(config.authToken, "").trim();

  // ---- Validate gatewayUrl ----
  if (!gatewayUrl) {
    checks.push({
      code: "openclaw_gateway_url_missing",
      level: "error",
      message: "OpenClaw adapter requires a gatewayUrl.",
      hint: "Set adapterConfig.gatewayUrl to your OpenClaw gateway WebSocket endpoint (e.g. ws://127.0.0.1:5555).",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(gatewayUrl);
  } catch {
    checks.push({
      code: "openclaw_gateway_url_invalid",
      level: "error",
      message: `Invalid gateway URL: ${gatewayUrl}`,
    });
  }

  if (parsedUrl && parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    checks.push({
      code: "openclaw_gateway_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${parsedUrl.protocol}`,
      hint: "Use a ws:// or wss:// endpoint.",
    });
  }

  if (parsedUrl) {
    checks.push({
      code: "openclaw_gateway_url_valid",
      level: "info",
      message: `Configured gateway: ${parsedUrl.toString()}`,
    });
  }

  // ---- Validate agentId ----
  if (!agentId) {
    checks.push({
      code: "openclaw_agent_id_missing",
      level: "error",
      message: "OpenClaw adapter requires an agentId.",
      hint: "Set adapterConfig.agentId to the OpenClaw agent identifier.",
    });
  } else {
    checks.push({
      code: "openclaw_agent_id_configured",
      level: "info",
      message: `Configured agentId: ${agentId}`,
    });
  }

  // ---- Probe: connect to gateway and call agents.list ----
  const canProbe =
    parsedUrl !== null &&
    (parsedUrl.protocol === "ws:" || parsedUrl.protocol === "wss:") &&
    checks.every(
      (c) =>
        c.code !== "openclaw_gateway_url_invalid" &&
        c.code !== "openclaw_gateway_url_protocol_invalid",
    );

  if (canProbe) {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers.authorization = `Bearer ${authToken}`;
    }

    try {
      const res = await rpcCall(gatewayUrl, "agents.list", {}, 8000, headers);

      if (!res.ok) {
        checks.push({
          code: "openclaw_agents_list_error",
          level: "warn",
          message: "agents.list RPC returned an error.",
          detail: JSON.stringify(res.payload).slice(0, 240),
        });
      } else {
        checks.push({
          code: "openclaw_gateway_reachable",
          level: "info",
          message: "Successfully connected to gateway and called agents.list.",
        });

        // Verify agentId exists in the returned agents
        const agents = Array.isArray(res.payload.agents)
          ? res.payload.agents
          : [];
        const defaultId =
          typeof res.payload.defaultId === "string"
            ? res.payload.defaultId
            : null;

        if (agentId) {
          const found = agents.some(
            (a: unknown) =>
              typeof a === "object" &&
              a !== null &&
              (a as Record<string, unknown>).id === agentId,
          );

          if (found) {
            checks.push({
              code: "openclaw_agent_found",
              level: "info",
              message: `Agent "${agentId}" exists on the gateway.`,
            });
          } else if (agentId === defaultId) {
            checks.push({
              code: "openclaw_agent_is_default",
              level: "info",
              message: `Agent "${agentId}" matches the gateway default agent.`,
            });
          } else {
            const agentIds = agents
              .map((a: unknown) =>
                typeof a === "object" && a !== null
                  ? (a as Record<string, unknown>).id
                  : null,
              )
              .filter((id: unknown): id is string => typeof id === "string");
            checks.push({
              code: "openclaw_agent_not_found",
              level: "warn",
              message: `Agent "${agentId}" was not found in the gateway's agent list.`,
              detail:
                agentIds.length > 0
                  ? `Available agents: ${agentIds.join(", ")}`
                  : "No agents returned by gateway.",
              hint: "Verify the agentId in your adapter config matches an agent registered in the OpenClaw gateway.",
            });
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      checks.push({
        code: "openclaw_gateway_probe_failed",
        level: "warn",
        message: `Gateway probe failed: ${errMsg}`,
        hint: "Verify the gateway is running and reachable at the configured URL.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
