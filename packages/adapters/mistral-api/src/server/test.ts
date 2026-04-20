import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";

export async function testMistralEnvironment(
  ctx: AdapterEnvironmentTestContext
): Promise<AdapterEnvironmentTestResult> {
  const config = ctx.config as {
    apiKey?: string;
  };
  const apiKey = config.apiKey;

  if (!apiKey) {
    return {
      adapterType: "mistral_api",
      status: "fail",
      checks: [
        {
          code: "mistral_api_key_missing",
          message: "Mistral API key is required for testing",
          level: "error",
          hint: "Set apiKey in the adapter configuration",
        }
      ],
      testedAt: new Date().toISOString(),
    };
  }

  try {
    const response = await fetch("https://api.mistral.ai/v1/models", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        adapterType: "mistral_api",
        status: "fail",
        checks: [
          {
            code: "mistral_api_error",
            message: `Mistral API error: ${response.status} ${response.statusText}`,
            level: "error",
            hint: errorData.message || "Check your API key and network connection",
          }
        ],
        testedAt: new Date().toISOString(),
      };
    }

    const models = await response.json();
    return {
      adapterType: "mistral_api",
      status: "pass",
      checks: [
        {
          code: "mistral_api_accessible",
          message: `Mistral API is accessible (found ${models.data?.length || 0} models)`,
          level: "info",
        }
      ],
      testedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      adapterType: "mistral_api",
      status: "fail",
      checks: [
        {
          code: "mistral_api_unreachable",
          message: `Failed to connect to Mistral API: ${String(error)}`,
          level: "error",
          hint: "Check your network connection and API key validity",
        }
      ],
      testedAt: new Date().toISOString(),
    };
  }
}