import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export async function stageDashboardBrandAssets(output: string) {
  const assets = path.join(output, "assets");
  await mkdir(assets, { recursive: true });
  await Promise.all([
    copyFile(
      path.join(repositoryRoot, "ui/public/favicon-32x32.png"),
      path.join(assets, "favicon-32x32.png"),
    ),
    copyFile(
      path.join(repositoryRoot, "ui/public/fonts/InterVariable.woff2"),
      path.join(assets, "InterVariable.woff2"),
    ),
  ]);
}
