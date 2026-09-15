import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import { buildHermesConfig } from "../../ui/build-config.js";
import {
  DEFAULT_GOOGLE_VERTEX_MODEL,
  DEFAULT_GOOGLE_VERTEX_REGION,
  GOOGLE_VERTEX_PROVIDER,
} from "../shared/constants.js";

export function buildGoogleVertexConfig(values: CreateConfigValues): Record<string, unknown> {
  return {
    ...buildHermesConfig({
      ...values,
      model: values.model.trim() || DEFAULT_GOOGLE_VERTEX_MODEL,
    }),
    ...(values.adapterSchemaValues ?? {}),
    provider: GOOGLE_VERTEX_PROVIDER,
    region:
      typeof values.adapterSchemaValues?.region === "string" && values.adapterSchemaValues.region.trim()
        ? values.adapterSchemaValues.region.trim()
        : DEFAULT_GOOGLE_VERTEX_REGION,
  };
}
