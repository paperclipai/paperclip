import type { UIAdapterModule } from "../types";
import { parseProcessStdoutLine } from "../process/parse-stdout";
import { HermesGatewayConfigFields } from "./config-fields";

function buildHermesGatewayConfig(values: import("@paperclipai/adapter-utils").CreateConfigValues): Record<string, unknown> {
  const schemaValues = values.adapterSchemaValues ?? {};
  const config: Record<string, unknown> = {};

  const url = typeof schemaValues.url === "string" ? schemaValues.url.trim() : values.url?.trim();
  const model = typeof schemaValues.model === "string" ? schemaValues.model.trim() : values.model?.trim();
  const timeoutSec = schemaValues.timeoutSec;
  const apiKey = schemaValues.apiKey;

  if (url) config.url = url;
  if (model) config.model = model;
  if (typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0) {
    config.timeoutSec = timeoutSec;
  }
  if (apiKey !== undefined && apiKey !== null && apiKey !== "") {
    config.apiKey = apiKey;
  }

  return config;
}

export const hermesGatewayUIAdapter: UIAdapterModule = {
  type: "hermes_gateway",
  label: "Hermes Gateway",
  parseStdoutLine: parseProcessStdoutLine,
  ConfigFields: HermesGatewayConfigFields,
  buildAdapterConfig: buildHermesGatewayConfig,
};
