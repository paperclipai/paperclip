import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { fetchInfo } from "../shared/client.js";
import { asStringHeaderMap } from "./gateway-execute.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const baseUrl = asString(config.baseUrl, "").trim();
  const headers = asStringHeaderMap(config.headers);
  const timeoutMs = asNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS);

  if (!baseUrl) {
    checks.push({
      code: "eve_gateway_base_url_missing",
      level: "error",
      message: "baseUrl is required.",
      hint: "Set the root URL of the running Eve agent, e.g. https://my-agent.vercel.app or http://127.0.0.1:3000.",
    });
  } else if (!/^https?:\/\//i.test(baseUrl)) {
    checks.push({
      code: "eve_gateway_base_url_invalid",
      level: "error",
      message: "baseUrl must be an http(s) URL.",
      detail: baseUrl,
    });
  } else {
    try {
      const info = await fetchInfo({ baseUrl, headers, timeoutMs });
      const model = readString(info.model);
      const name = readString(info.name);
      const detailParts = [
        ...(name ? [`name: ${name}`] : []),
        ...(model ? [`model: ${model}`] : []),
      ];
      checks.push({
        code: "eve_gateway_reachable",
        level: "info",
        message: "Eve agent reachable",
        detail: detailParts.length > 0 ? detailParts.join(", ") : null,
      });
    } catch (err) {
      checks.push({
        code: "eve_gateway_unreachable",
        level: "error",
        message: err instanceof Error ? err.message : "Failed to reach the Eve agent info endpoint.",
        hint: "Verify the Eve agent is running and any required auth headers are configured.",
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
