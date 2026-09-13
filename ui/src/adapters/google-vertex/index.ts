import type { UIAdapterModule } from "../types";
import {
  buildGoogleVertexConfig,
  parseGoogleVertexStdoutLine,
} from "@paperclipai/hermes-paperclip-adapter/vertex/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const googleVertexUIAdapter: UIAdapterModule = {
  type: "google_vertex",
  label: "Google Vertex AI",
  parseStdoutLine: parseGoogleVertexStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildGoogleVertexConfig,
};
