import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const { config } = ctx;

  const url = asString(config.url, "").replace(/\/+$/, "");
  const directory = asString(config.directory, "");

  // Check required fields
  if (!url) {
    checks.push({
      code: "url_missing",
      level: "error",
      message: "url is required",
      hint: "Set the base URL of the OpenCode server (e.g. http://codev:5400)",
    });
  }

  if (!directory) {
    checks.push({
      code: "directory_missing",
      level: "error",
      message: "directory is required",
      hint: "Set the project directory on the OpenCode server (e.g. /home/coder/src)",
    });
  }

  // If we have required fields, try to reach the server
  if (url && directory) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(`${url}/project`, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const projects = (await res.json()) as Array<{ id: string; worktree: string }>;
        checks.push({
          code: "server_reachable",
          level: "info",
          message: `OpenCode server reachable at ${url} (${projects.length} projects)`,
        });

        // Verify the directory matches a known project
        const matchingProject = projects.find((p) => p.worktree === directory);
        if (matchingProject) {
          checks.push({
            code: "directory_valid",
            level: "info",
            message: `Directory "${directory}" matches project ${matchingProject.id.slice(0, 12)}`,
          });
        } else {
          checks.push({
            code: "directory_unknown",
            level: "warn",
            message: `Directory "${directory}" does not match any registered project`,
            hint: `Available project directories: ${projects.map((p) => p.worktree).join(", ")}`,
          });
        }
      } else {
        checks.push({
          code: "server_error",
          level: "error",
          message: `OpenCode server returned HTTP ${res.status}`,
          hint: "Verify the URL is correct and the server is running",
        });
      }
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        code: "server_unreachable",
        level: "error",
        message: `Cannot reach OpenCode server: ${msg}`,
        hint: "Verify the URL and network connectivity",
      });
    }
  }

  // Check model config
  const model = asString(config.model, "");
  if (model) {
    checks.push({
      code: "model_configured",
      level: "info",
      message: `Model: ${model}`,
    });
  }

  const providerID = asString(config.providerID, "");
  if (providerID) {
    checks.push({
      code: "provider_configured",
      level: "info",
      message: `Provider: ${providerID}`,
    });
  }

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");

  return {
    adapterType: "opencode_remote",
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
