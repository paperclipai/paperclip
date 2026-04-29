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
  const apiMode = typeof schemaValues.apiMode === "string" ? schemaValues.apiMode.trim() : "";
  const sessionKeyStrategy =
    typeof schemaValues.sessionKeyStrategy === "string" ? schemaValues.sessionKeyStrategy.trim() : "";
  const sessionKey = typeof schemaValues.sessionKey === "string" ? schemaValues.sessionKey.trim() : "";
  const storeResponses = schemaValues.storeResponses;

  if (url) config.url = url;
  if (model) config.model = model;
  if (typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0) {
    config.timeoutSec = timeoutSec;
  }
  if (apiMode) config.apiMode = apiMode;
  if (sessionKeyStrategy) config.sessionKeyStrategy = sessionKeyStrategy;
  if (sessionKey) config.sessionKey = sessionKey;
  if (typeof storeResponses === "boolean") config.storeResponses = storeResponses;
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
