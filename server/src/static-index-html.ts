import fs from "node:fs";
import path from "node:path";
import { injectCloudUiSnippet } from "./cloud-ui-snippet.js";
import { applyUiBranding } from "./ui-branding.js";

export function readBrandedStaticIndexHtml(uiDist: string): string {
  return injectCloudUiSnippet(applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8")));
}
