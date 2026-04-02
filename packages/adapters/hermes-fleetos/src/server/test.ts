import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { FleetOSClient, FleetOSClientError } from "../shared/fleetos-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

// ---------------------------------------------------------------------------
// Environment test
// ---------------------------------------------------------------------------

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const fleetosUrl = asString(config.fleetosUrl, "").trim();
  const apiKey = asString(config.apiKey, "").trim();
  const containerId = asString(config.containerId, "").trim();

  // ---- Validate required config fields ----
  if (!fleetosUrl) {
    checks.push({
      code: "fleetos_url_missing",
      level: "error",
      message: "FleetOS adapter requires a fleetosUrl in adapter config.",
      hint: "Set adapterConfig.fleetosUrl to the FleetOS API base URL (e.g. https://fleet.raava.io).",
    });
  } else {
    try {
      new URL(fleetosUrl);
      checks.push({
        code: "fleetos_url_valid",
        level: "info",
        message: `FleetOS URL configured: ${fleetosUrl}`,
      });
    } catch {
      checks.push({
        code: "fleetos_url_invalid",
        level: "error",
        message: `Invalid FleetOS URL: ${fleetosUrl}`,
        hint: "Provide a valid URL including the protocol (https://).",
      });
    }
  }

  if (!apiKey) {
    checks.push({
      code: "fleetos_api_key_missing",
      level: "error",
      message: "FleetOS adapter requires an apiKey in adapter config.",
      hint: "Set adapterConfig.apiKey to your FleetOS API key.",
    });
  } else {
    checks.push({
      code: "fleetos_api_key_present",
      level: "info",
      message: "FleetOS API key is configured.",
    });
  }

  if (!containerId) {
    checks.push({
      code: "fleetos_container_id_missing",
      level: "error",
      message: "FleetOS adapter requires a containerId in adapter config.",
      hint: "Set adapterConfig.containerId to the target LXD container ID.",
    });
  } else {
    checks.push({
      code: "fleetos_container_id_present",
      level: "info",
      message: `Target container ID: ${containerId}`,
    });
  }

  // If any required fields are missing, short-circuit before probing
  if (!fleetosUrl || !apiKey || !containerId) {
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const client = new FleetOSClient(fleetosUrl, apiKey);

  // ---- Test 1: FleetOS API reachable ----
  try {
    const reachable = await client.ping();
    if (reachable) {
      checks.push({
        code: "fleetos_api_reachable",
        level: "info",
        message: "FleetOS API is reachable and authenticated.",
      });
    } else {
      checks.push({
        code: "fleetos_api_unreachable",
        level: "error",
        message: "FleetOS API health check failed.",
        hint: "Verify the fleetosUrl and apiKey, and check that the FleetOS API is running.",
      });
      return {
        adapterType: ctx.adapterType,
        status: summarizeStatus(checks),
        checks,
        testedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "fleetos_api_error",
      level: "error",
      message: "FleetOS API connectivity check failed.",
      detail,
      hint: "Verify network connectivity and that the FleetOS API is running at the configured URL.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // ---- Test 2: Container exists and running ----
  try {
    const container = await client.getContainer(containerId);
    if (container.status === "running") {
      checks.push({
        code: "fleetos_container_running",
        level: "info",
        message: `Container ${containerId} is running.`,
      });
    } else {
      checks.push({
        code: "fleetos_container_not_running",
        level: "warn",
        message: `Container ${containerId} exists but is ${container.status}.`,
        hint: "The adapter will attempt to start the container before execution, but pre-starting is recommended.",
      });
    }
  } catch (err) {
    const isClientError = err instanceof FleetOSClientError;
    const statusCode = isClientError ? err.statusCode : 0;
    checks.push({
      code: "fleetos_container_not_found",
      level: "error",
      message:
        statusCode === 404
          ? `Container ${containerId} not found in FleetOS.`
          : `Failed to query container ${containerId}: ${err instanceof Error ? err.message : String(err)}`,
      hint:
        statusCode === 404
          ? "Verify the containerId in adapter config matches an existing FleetOS container."
          : "Check FleetOS API logs for details.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // ---- Test 3: Hermes CLI available in container ----
  try {
    const hermesCommand = asString(config.hermesCommand, "hermes");
    const probeResult = await client.exec(containerId, [hermesCommand, "--version"], 10_000);
    if (probeResult.exit_code === 0) {
      const version = probeResult.stdout.trim().split(/\r?\n/)[0] ?? "unknown";
      checks.push({
        code: "fleetos_hermes_available",
        level: "info",
        message: `Hermes CLI is available in container: ${version}`,
      });
    } else {
      checks.push({
        code: "fleetos_hermes_not_found",
        level: "error",
        message: `Hermes CLI (${hermesCommand}) is not available or failed in container.`,
        detail: probeResult.stderr.trim().split(/\r?\n/)[0] ?? null,
        hint: `Ensure '${hermesCommand}' is installed and on PATH inside the container.`,
      });
    }
  } catch (err) {
    checks.push({
      code: "fleetos_hermes_probe_error",
      level: "warn",
      message: `Could not probe hermes CLI: ${err instanceof Error ? err.message : String(err)}`,
      hint: "The container may not be running or exec is not available. This can be retried after the container is started.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
