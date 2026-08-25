import fs from "node:fs";
import path from "node:path";
import { applyUiBranding } from "./ui-branding.js";
import type { HostFeaturesSnapshotV1 } from "@paperclipai/shared";
import { injectRuntimeFeaturesHtml } from "./runtime-features-html.js";

export function readBrandedStaticIndexHtml(
  uiDist: string,
  runtimeFeatures?: HostFeaturesSnapshotV1,
): string {
  const branded = applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
  return runtimeFeatures ? injectRuntimeFeaturesHtml(branded, runtimeFeatures) : branded;
}
