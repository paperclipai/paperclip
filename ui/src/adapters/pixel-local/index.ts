import type { UIAdapterModule } from "../types";
import { parsePixelStdoutLine } from "@paperclipai/adapter-pixel-local/ui";
import { PixelLocalConfigFields } from "./config-fields";
import { buildPixelLocalConfig } from "@paperclipai/adapter-pixel-local/ui";

export const pixelLocalUIAdapter: UIAdapterModule = {
  type: "pixel_local",
  label: "Pixel (local)",
  parseStdoutLine: parsePixelStdoutLine,
  ConfigFields: PixelLocalConfigFields,
  buildAdapterConfig: buildPixelLocalConfig,
};
