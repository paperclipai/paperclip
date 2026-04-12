import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { resolveCabinetConfig } from "./cabinet.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "");

  if (!command) {
    checks.push({
      code: "hermes_command_missing",
      level: "error",
      message: "Hermes adapter requires a command.",
      hint: "Set adapterConfig.command to the hermes CLI executable.",
    });
  } else {
    checks.push({
      code: "hermes_command_present",
      level: "info",
      message: `Configured command: ${command}`,
    });
  }

  const workspace = asString(config.workspace, "");
  if (workspace) {
    checks.push({
      code: "hermes_workspace_configured",
      level: "info",
      message: `Hermes workspace: ${workspace}`,
    });
  }

  // Check Cabinet connectivity
  const cabinetConfig = resolveCabinetConfig(config);
  if (cabinetConfig.memorySync !== "off") {
    if (!cabinetConfig.slug) {
      checks.push({
        code: "hermes_cabinet_slug_missing",
        level: "warn",
        message: "Cabinet memory sync is enabled but no cabinetSlug is configured.",
        hint: "Set cabinetSlug to the memory namespace for this agent.",
      });
    } else {
      checks.push({
        code: "hermes_cabinet_slug_configured",
        level: "info",
        message: `Cabinet slug: ${cabinetConfig.slug}, sync: ${cabinetConfig.memorySync}`,
      });

      // Probe Cabinet endpoint
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(
          `${cabinetConfig.endpoint}/api/memory/${encodeURIComponent(cabinetConfig.slug)}`,
          { method: "GET", signal: controller.signal },
        );
        clearTimeout(timeout);

        if (res.ok) {
          checks.push({
            code: "hermes_cabinet_reachable",
            level: "info",
            message: "Cabinet Memory API is reachable.",
          });
        } else {
          checks.push({
            code: "hermes_cabinet_unreachable_status",
            level: "warn",
            message: `Cabinet Memory API returned HTTP ${res.status}.`,
            hint: "Verify Cabinet is running and the slug exists.",
          });
        }
      } catch (err) {
        checks.push({
          code: "hermes_cabinet_unreachable",
          level: "warn",
          message: "Could not reach Cabinet Memory API.",
          hint: `Verify Cabinet is running at ${cabinetConfig.endpoint}. Error: ${err instanceof Error ? err.message : "unknown"}`,
        });
      }
    }
  } else {
    checks.push({
      code: "hermes_cabinet_disabled",
      level: "info",
      message: "Cabinet memory sync is disabled.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
