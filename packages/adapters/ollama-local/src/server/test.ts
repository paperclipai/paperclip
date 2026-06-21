import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult, AdapterEnvironmentCheck, AdapterEnvironmentTestStatus } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const host = asString(ctx.config.host, "http://localhost:11434");
  const checks: AdapterEnvironmentCheck[] = [];
  let status: AdapterEnvironmentTestStatus = "pass";

  try {
    const response = await fetch(`${host}/api/tags`);
    if (response.ok) {
      checks.push({
        code: "ollama_api_reachable",
        level: "info",
        message: "Ollama API is reachable",
      });
    } else {
      status = "fail";
      checks.push({
        code: "ollama_api_error",
        level: "error",
        message: "Ollama API returned error",
        detail: `Status: ${response.status} ${response.statusText}`,
      });
    }
  } catch (err) {
    status = "fail";
    checks.push({
      code: "ollama_api_unreachable",
      level: "error",
      message: "Ollama API is unreachable",
      detail: err instanceof Error ? err.message : String(err),
      hint: "Ensure Ollama is running and the host URL is correct",
    });
  }

  return {
    adapterType: "ollama_local",
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
