import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentTestStatus,
} from "@paperclipai/adapter-utils";
import { cookbookListSkills, fetchCornerstoneContext } from "./client.js";

function now(): string {
  return new Date().toISOString();
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const cornerstoneKey =
    process.env.CORNERSTONE_API_KEY ?? process.env.MEMORY_API_KEY ?? null;
  const cookbookKey =
    process.env.COOKBOOK_ACCESS_TOKEN ??
    process.env.COOKBOOK_API_KEY ??
    process.env.MEMORY_API_KEY ??
    null;

  if (!anthropicKey) {
    checks.push({
      code: "anthropic_key_missing",
      level: "error",
      message: "ANTHROPIC_API_KEY is not set on the Paperclip server",
      hint: "Export ANTHROPIC_API_KEY with managed-agents beta access",
    });
  } else {
    try {
      const res = await fetch("https://api.anthropic.com/v1/agents?limit=1", {
        method: "GET",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "managed-agents-2026-04-01",
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        checks.push({
          code: "anthropic_api_failed",
          level: "error",
          message: `Managed Agents /v1/agents probe failed: HTTP ${res.status}`,
          detail: body.slice(0, 200),
        });
      } else {
        checks.push({
          code: "anthropic_api_ok",
          level: "info",
          message: "Managed Agents API reachable with the configured key",
        });
      }
    } catch (err) {
      checks.push({
        code: "anthropic_api_error",
        level: "error",
        message: "Managed Agents API probe threw",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!cornerstoneKey) {
    checks.push({
      code: "cornerstone_key_missing",
      level: "warn",
      message: "CORNERSTONE_API_KEY is not set — Cornerstone context will be skipped",
    });
  } else {
    try {
      await fetchCornerstoneContext(cornerstoneKey, {
        query: "ping",
        detailLevel: "minimal",
        maxTokens: 50,
      });
      checks.push({ code: "cornerstone_ok", level: "info", message: "Cornerstone /context reachable" });
    } catch (err) {
      checks.push({
        code: "cornerstone_failed",
        level: "warn",
        message: "Cornerstone /context probe failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!cookbookKey) {
    checks.push({
      code: "cookbook_key_missing",
      level: "warn",
      message: "COOKBOOK_API_KEY is not set — Cookbook skills will be skipped",
    });
  } else {
    try {
      const skills = await cookbookListSkills(cookbookKey);
      checks.push({
        code: "cookbook_ok",
        level: "info",
        message: `Cookbook MCP reachable (${skills.length} skills)`,
      });
    } catch (err) {
      checks.push({
        code: "cookbook_failed",
        level: "warn",
        message: "Cookbook MCP probe failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const errors = checks.filter((c) => c.level === "error");
  const warns = checks.filter((c) => c.level === "warn");
  const status: AdapterEnvironmentTestStatus =
    errors.length > 0 ? "fail" : warns.length > 0 ? "warn" : "pass";

  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: now(),
  };
}
