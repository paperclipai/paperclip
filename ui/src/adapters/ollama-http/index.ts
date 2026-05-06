import type { UIAdapterModule } from "../types";
import { parseHttpStdoutLine } from "../http/parse-stdout";
import { OllamaHttpConfigFields } from "./config-fields";
import { buildOllamaHttpConfig } from "./build-config";

export const ollamaHttpUIAdapter: UIAdapterModule = {
  type: "ollama_http",
  label: "Ollama HTTP",
  parseStdoutLine: parseHttpStdoutLine,
  ConfigFields: OllamaHttpConfigFields,
  buildAdapterConfig: buildOllamaHttpConfig,
};