import type { PluginHttpClient, PluginLogger } from "@paperclipai/plugin-sdk";

export interface OpenBrainClientConfig {
  endpoint: string;
  apiKey?: string;
}

export interface OpenBrainClient {
  captureThought(content: string): Promise<void>;
}

export function createOpenBrainClient(
  http: PluginHttpClient,
  logger: PluginLogger,
  config: OpenBrainClientConfig,
): OpenBrainClient {
  const baseUrl = config.endpoint.replace(/\/+$/, "");

  return {
    async captureThought(content: string): Promise<void> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
      }

      const response = await http.fetch(`${baseUrl}/capture_thought`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        logger.error("open-brain capture failed", {
          status: response.status,
          body: text,
        });
        throw new Error(
          `open-brain capture_thought failed: ${response.status} ${text}`,
        );
      }

      logger.info("Thought captured to open-brain", {
        contentLength: content.length,
      });
    },
  };
}
