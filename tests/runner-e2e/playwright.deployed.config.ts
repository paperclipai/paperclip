import path from "node:path";
import { defineConfig } from "@playwright/test";
import { loadDeployedStack } from "./deployed-stack.js";

const stack = loadDeployedStack();
const output = process.env.PAPERCLIP_DEPLOYED_STACK_EVIDENCE;
if (!output || !path.isAbsolute(output)) throw new Error("PAPERCLIP_DEPLOYED_STACK_EVIDENCE must be an absolute output directory");

export default defineConfig({
  testDir: ".", testMatch: "deployed-work-folders.spec.ts",
  fullyParallel: true, workers: 2, retries: 0, timeout: 900_000,
  use: { baseURL: stack.baseURL, trace: "off", video: "off" },
  // No webServer: every operation reaches the deployed tenant and database.
  outputDir: path.join(output, "results"),
  reporter: [["list"], ["json", { outputFile: path.join(output, "results.json") }]],
});
