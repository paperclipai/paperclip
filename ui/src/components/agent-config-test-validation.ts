function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateOpenClawGatewayConfig(adapterConfig: Record<string, unknown>): string | null {
  const configuredUrl = readNonEmptyString(adapterConfig.url);
  if (!configuredUrl) {
    return "OpenClaw Gateway test requires a Gateway URL. Use a WebSocket URL such as ws://host:port or wss://host/path.";
  }

  try {
    const parsed = new URL(configuredUrl);
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
      return null;
    }
  } catch {
    // Fall through to the shared error message below.
  }

  return "OpenClaw Gateway test requires a WebSocket Gateway URL. Use ws://host:port or wss://host/path.";
}

function validateOllamaHttpConfig(adapterConfig: Record<string, unknown>): string | null {
  const configuredUrl = readNonEmptyString(adapterConfig.baseUrl) ?? readNonEmptyString(adapterConfig.url);
  if (!configuredUrl) {
    return "Ollama HTTP test requires a base URL. Use an HTTP endpoint such as https://host or http://host:port.";
  }

  try {
    const parsed = new URL(configuredUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return null;
    }
  } catch {
    // Fall through to the shared error message below.
  }

  return "Ollama HTTP test requires an HTTP base URL. Use http://host:port or https://host/path.";
}

function validateHttpBaseUrl(
  adapterName: string,
  configuredUrl: string | null,
  missingMessage: string,
  invalidMessage: string,
): string | null {
  if (!configuredUrl) {
    return missingMessage;
  }

  try {
    const parsed = new URL(configuredUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return null;
    }
  } catch {
    // Fall through to the shared error message below.
  }

  return invalidMessage || `${adapterName} test requires an HTTP URL.`;
}

export function validateAdapterEnvironmentTestInput(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
): string | null {
  switch (adapterType) {
    case "openclaw_gateway":
      return validateOpenClawGatewayConfig(adapterConfig);
    case "ollama_http":
      return validateOllamaHttpConfig(adapterConfig);
    case "custom_llm_local":
      return validateHttpBaseUrl(
        "Custom LLM",
        readNonEmptyString(adapterConfig.baseUrl) ?? readNonEmptyString(adapterConfig.url),
        "Custom LLM test requires a base URL. Use an HTTP endpoint such as https://host or http://host:port.",
        "Custom LLM test requires an HTTP base URL. Use http://host:port or https://host/path.",
      );
    case "ollama_local":
      return validateHttpBaseUrl(
        "Ollama",
        readNonEmptyString(adapterConfig.baseUrl),
        "Ollama test requires a base URL. Use an HTTP endpoint such as https://host or http://host:port.",
        "Ollama test requires an HTTP base URL. Use http://host:port or https://host/path.",
      );
    case "agent_zero_bridge":
      return validateHttpBaseUrl(
        "Agent Zero Bridge",
        readNonEmptyString(adapterConfig.url),
        "Agent Zero Bridge test requires an invoke URL. Use an HTTP endpoint such as http://host:port/invoke.",
        "Agent Zero Bridge test requires an HTTP invoke URL. Use http://host:port/invoke or https://host/path/invoke.",
      );
    default:
      return null;
  }
}