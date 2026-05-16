import type { UIAdapterModule } from "../types";
import { parseHermesObservableStdoutLine } from "@paperclipai/adapter-hermes-observable/ui";
import { buildHermesObservableConfig } from "@paperclipai/adapter-hermes-observable/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const hermesObservableUIAdapter: UIAdapterModule = {
  type: "hermes_observable",
  label: "Hermes Observable",
  parseStdoutLine: parseHermesObservableStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildHermesObservableConfig,
};
