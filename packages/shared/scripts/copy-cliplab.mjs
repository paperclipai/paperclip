import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

const distCliplab = path.join(packageRoot, "dist", "cliplab");
fs.mkdirSync(distCliplab, { recursive: true });

fs.copyFileSync(
  path.join(packageRoot, "src", "cliplab", "LICENSE"),
  path.join(distCliplab, "LICENSE")
);
fs.copyFileSync(
  path.join(packageRoot, "src", "cliplab", "PROVENANCE.md"),
  path.join(distCliplab, "PROVENANCE.md")
);
