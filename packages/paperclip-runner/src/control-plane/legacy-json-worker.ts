import { parentPort } from "node:worker_threads";
import type { LegacyJsonCursor } from "./legacy-json-scanner.js";
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const { scanLegacyJsonPage } = await import(new URL(`./legacy-json-scanner.${extension}`, import.meta.url).href) as typeof import("./legacy-json-scanner.js");
parentPort!.on("message", (input: { path: string; source: string | null; cursor: LegacyJsonCursor | null }) => {
  try { parentPort!.postMessage({ page: scanLegacyJsonPage(input.path, input.source, input.cursor) }); }
  catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : "legacy migration read failed" }); }
});
