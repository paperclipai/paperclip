import fs from "node:fs";
import path from "node:path";
import { applyUiBranding } from "./ui-branding.js";

export function readBrandedStaticIndexHtml(uiDist: string): string {
  return applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
}
