import { FleetOSClient } from "../shared/fleetos-client.js";

/**
 * Detect the currently configured model by reading the hermes config.yaml
 * from inside the FleetOS container via the files API.
 *
 * TODO: Refine the config.yaml parsing once the hermes config schema is finalized.
 */
export async function detectModel(
  fleetosUrl: string,
  apiKey: string,
  containerId: string,
): Promise<{ model: string; provider: string; source: string } | null> {
  const client = new FleetOSClient(fleetosUrl, apiKey);

  // Common locations for hermes config
  const configPaths = [
    "/home/hermes/.hermes/config.yaml",
    "/etc/hermes/config.yaml",
    "/home/hermes/.config/hermes/config.yaml",
  ];

  for (const configPath of configPaths) {
    try {
      const file = await client.readFile(containerId, configPath);
      const content = file.content;

      // Simple YAML parsing for model field — avoids a YAML parser dependency.
      // TODO: Use a proper YAML parser if hermes config becomes more complex.
      const modelMatch = content.match(/^\s*model\s*:\s*["']?([^\s"'#]+)/m);
      const providerMatch = content.match(/^\s*provider\s*:\s*["']?([^\s"'#]+)/m);

      if (modelMatch) {
        return {
          model: modelMatch[1],
          provider: providerMatch ? providerMatch[1] : "unknown",
          source: `fleetos:${containerId}:${configPath}`,
        };
      }
    } catch (err: unknown) {
      // Config file not found at this path — try next
      const isNotFound =
        err instanceof Error &&
        (/404/.test(err.message) || /ENOENT/.test(err.message));
      if (!isNotFound) {
        console.warn(
          `[detect-model] Unexpected error reading ${configPath} in container ${containerId}:`,
          err instanceof Error ? err.message : err,
        );
      }
      continue;
    }
  }

  return null;
}
