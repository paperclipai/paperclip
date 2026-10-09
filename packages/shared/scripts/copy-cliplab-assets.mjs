import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(packageRoot, "dist", "cliplab");

await mkdir(destination, { recursive: true });
await Promise.all(
  ["LICENSE", "PROVENANCE.md"].map((file) =>
    copyFile(
      join(packageRoot, "src", "cliplab", file),
      join(destination, file),
    ),
  ),
);
