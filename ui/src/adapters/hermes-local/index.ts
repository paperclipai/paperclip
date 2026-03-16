import type { UIAdapterModule } from "../types";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { parseHermesStdoutLine, buildHermesConfig as upstreamBuildHermesConfig } from "hermes-paperclip-adapter/ui";
import { HermesLocalConfigFields } from "./config-fields";

/**
 * Override the upstream buildHermesConfig to support "hermes default" model behavior.
 * When model is empty/falsy, we intentionally omit it from the config so the
 * server-side adapter can skip passing -m to hermes (letting hermes use its
 * own ~/.hermes/config.yaml default).
 *
 * NOTE: This requires the hermes-paperclip-adapter server-side execute logic
 * to skip the -m flag when config.model is undefined. Until that package is
 * updated, empty model will fall back to the adapter's hardcoded DEFAULT_MODEL.
 */
function buildHermesConfig(values: CreateConfigValues): Record<string, unknown> {
  const config = upstreamBuildHermesConfig(values);
  // If model was empty in the UI form, the upstream set it to its DEFAULT_MODEL.
  // We detect this and remove it so the server adapter knows to skip -m flag.
  const modelWasExplicitlySet = values.model && values.model.trim().length > 0;
  if (!modelWasExplicitlySet) {
    delete config.model;
  }
  // Handle provider from `args` field (CreateConfigValues convention)
  if (values.args && values.args.trim().length > 0) {
    config.provider = values.args.trim();
  }
  return config;
}

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent",
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
