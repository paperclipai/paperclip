import { createRequire } from "node:module";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export function canonicalGeneratedReportAsset(relative: string): string | undefined {
  if (relative === "normalized/assets/InterVariable.woff2") return path.join(repositoryRoot, "ui/public/fonts/InterVariable.woff2");
  if (!relative.startsWith("html/trace/")) return;
  const parts = relative.slice("html/trace/".length).split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part))) return;
  if (parts.length === 1) {
    if (parts[0]!.endsWith(".map") || parts[0]!.includes("watch") || parts[0]!.includes("assets")) return;
  } else if (parts.length !== 2 || parts[0] !== "assets" || parts[1]!.endsWith(".map") || parts[1]!.includes("xtermModule")) return;
  const test = require.resolve("@playwright/test/package.json");
  const playwright = require.resolve("playwright/package.json", { paths: [path.dirname(test)] });
  const core = require.resolve("playwright-core/package.json", { paths: [path.dirname(playwright)] });
  return path.join(path.dirname(core), "lib/vite/traceViewer", ...parts);
}
export async function isTrustedGeneratedReportAsset(relative: string, bytes: Buffer): Promise<boolean> {
  const source = canonicalGeneratedReportAsset(relative);
  if (!source) return false;
  const metadata = await lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  return !!metadata && metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === bytes.length && bytes.equals(await readFile(source));
}
