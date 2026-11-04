import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { evalBraintrustConfig } from "./braintrust.js";
import { buildBraintrustExperiment, importBraintrustExperiment } from "./braintrust-experiment.js";

const [campaignFile, originalPathsFile, outputFile, mode] = process.argv.slice(2);
if (!campaignFile || !originalPathsFile || !outputFile || ![undefined, "--dry-run"].includes(mode)) {
  throw new Error("Usage: braintrust-experiment-import.ts <normalized-results.json> <original-result-paths.json> <receipt.json> [--dry-run]");
}
let totalBytes = 0;
const readJson = async (file: string) => {
  const bytes = await readFile(file);
  totalBytes += bytes.length;
  if (bytes.length > 8 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024) throw new Error("Experiment input exceeds its file or campaign size limit");
  return JSON.parse(bytes.toString("utf8"));
};
const paths = await readJson(originalPathsFile);
if (!Array.isArray(paths) || paths.length === 0 || paths.length > 10_000
    || paths.some(file => typeof file !== "string" || !path.isAbsolute(file))) throw new Error("Expected explicit absolute original result paths");
if ([campaignFile, originalPathsFile, ...paths].some(file => path.resolve(file) === path.resolve(outputFile))) {
  throw new Error("Experiment output must not replace input evidence");
}
const campaign = await readJson(campaignFile), originals = [];
for (const file of paths) originals.push(await readJson(file));
const projectId = process.env.PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID ?? "";
const plan = buildBraintrustExperiment(projectId, campaign, originals);
const persist = async (value: unknown) => {
  const temporary = `${outputFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, outputFile);
};
if (mode === "--dry-run") {
  await persist(plan);
  console.log(`Prepared ${plan.events.length} retained rows; no network requests made.`);
} else {
  const config = evalBraintrustConfig(process.env);
  if (!config) throw new Error("Braintrust project and ingestion credential required");
  const previous = await readJson(outputFile).catch(error => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  const receipt = await importBraintrustExperiment(config, campaign, originals, persist, fetch, previous);
  console.log(`Braintrust accepted ${receipt.acceptedRows} retained rows in experiment ${receipt.experimentId}; indexed verification remains required.`);
}
