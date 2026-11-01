import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { renderRunnerHistoryIndex } from "./history-index.js";
import { campaignHistoryRecord, mergeRunnerHistory } from "./history.js";
import { assertPublicCampaign, buildHistoryPointers } from "./history-publish.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import type { RunnerE2ECampaign, RunnerE2EHistoryIndex } from "./types.js";

/** Index-only refresh: no provider calls, campaign rewrites, or evidence uploads. */
export async function refreshHistoryIndex(input: {
  history: string; output: string; publicCampaign?: string; publicUrl?: string; preset?: string;
}) {
  let history = JSON.parse(await readFile(input.history, "utf8")) as RunnerE2EHistoryIndex;
  if (history.schema !== "paperclip.runner-e2e.history/v1" || !Array.isArray(history.campaigns)) throw new Error("Invalid E2E history");
  if (input.publicCampaign) {
    const url = new URL(input.publicUrl ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("A public HTTPS campaign URL is required");
    if (input.preset && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.preset)) throw new Error("Invalid run preset");
    const campaign = JSON.parse(await readFile(input.publicCampaign, "utf8")) as RunnerE2ECampaign;
    if (campaign.schema !== "paperclip.runner-e2e.campaign/v2" || !Array.isArray(campaign.results)) throw new Error("A reviewed public campaign is required");
    assertPublicCampaign(campaign);
    for (const result of campaign.results) validateRetainedRunnerResult(result);
    const record = { ...campaignHistoryRecord(campaign, url.origin), publicUrl: url.href,
      ...(input.preset ? { preset: input.preset } : {}) };
    if (history.campaigns.some(existing => existing.campaignId === record.campaignId)) {
      throw new Error("Campaign already exists in history; existing measurements are never replaced by an index refresh");
    }
    history = mergeRunnerHistory(history, record);
  } else if (input.publicUrl || input.preset) throw new Error("Campaign metadata requires a reviewed public campaign");
  const html = renderRunnerHistoryIndex(history);
  const pointers = buildHistoryPointers(history);
  await mkdir(input.output, { recursive: true });
  await Promise.all([
    writeFile(path.join(input.output, "index.html"), html),
    writeFile(path.join(input.output, "history.json"), JSON.stringify(history, null, 2) + "\n"),
    writeFile(path.join(input.output, "latest.json"), JSON.stringify(pointers.latest, null, 2) + "\n"),
    writeFile(path.join(input.output, "latest-green.json"), JSON.stringify(pointers.latestGreen, null, 2) + "\n"),
  ]);
  return history;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: { history: { type: "string" }, output: { type: "string" },
    "public-campaign": { type: "string" }, "public-url": { type: "string" }, preset: { type: "string" } } });
  if (!values.history || !values.output) throw new Error("--history and --output are required");
  const history = await refreshHistoryIndex({ history: values.history, output: values.output,
    publicCampaign: values["public-campaign"], publicUrl: values["public-url"], preset: values.preset });
  console.log(`Rendered E2E history with ${history.campaigns.length} retained campaigns; no provider calls.`);
}
