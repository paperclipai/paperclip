#!/usr/bin/env node
// Re-render immutable recorded evidence; this command never invokes a model.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeProtocolEvalRuns } from "./runner-protocol-eval-campaign.mjs";
import { validatePublicProtocolEvalReport } from "./publish-runner-protocol-eval-history.mjs";

export async function refreshProtocolEvalReport({
  sourceRoot,
  evalsRoot,
  viewerRoot,
  outputRoot,
  revision,
  renderedAt = new Date().toISOString(),
}) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(revision ?? ""))
    throw new Error("A safe, unique --revision is required");
  if (await lstat(outputRoot).catch(() => null))
    throw new Error("Report refresh output must be a new directory");
  const campaign = JSON.parse(
    await readFile(join(sourceRoot, "campaign.json"), "utf8"),
  );
  if (!/^gha-[1-9][0-9]*-[1-9][0-9]*$/.test(campaign.campaignId ?? ""))
    throw new Error("Expected an original Actions campaign");
  const program = join(
    evalsRoot,
    "evals/paperclip-runner/tools/eval_program.py",
  );
  const rendererDigest = createHash("sha256")
    .update(await readFile(program))
    .digest("hex");
  await mkdir(outputRoot, { recursive: true });
  const runsRoot = join(outputRoot, "public-runs");
  const reportRoot = join(outputRoot, "report");
  await sanitizeProtocolEvalRuns({
    runsRoot: join(sourceRoot, "runs"),
    publicRunsRoot: runsRoot,
  });
  execFileSync(
    "python3",
    [
      program,
      "report",
      "--runs-root",
      runsRoot,
      "--output",
      reportRoot,
      "--viewer-root",
      viewerRoot,
      "--public-viewer",
      "--inventory",
      join(evalsRoot, "evals/paperclip-runner/inventory.json"),
      "--coverage-matrix",
      join(evalsRoot, "evals/paperclip-runner/coverage-matrix.json"),
    ],
    { stdio: "inherit" },
  );
  const refreshed = {
    ...campaign,
    campaignId: `${campaign.campaignId}-report-${revision}`,
    // A presentation refresh is not a new model measurement.
    generatedAt: campaign.generatedAt,
    reportRevision: {
      sourceCampaignId: campaign.campaignId,
      sourceGeneratedAt: campaign.generatedAt,
      renderedAt,
      rendererDigest,
      providerCalls: 0,
    },
  };
  await writeFile(
    join(reportRoot, "campaign.json"),
    `${JSON.stringify(refreshed, null, 2)}\n`,
  );
  await validatePublicProtocolEvalReport(reportRoot, { viewerRoot });
  return { reportRoot, campaignId: refreshed.campaignId, providerCalls: 0 };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1])
      throw new Error(`Missing ${name}`);
    return process.argv[index + 1];
  };
  console.log(
    await refreshProtocolEvalReport({
      sourceRoot: resolve(arg("--source")),
      evalsRoot: resolve(arg("--evals-root")),
      viewerRoot: resolve(arg("--viewer-root")),
      outputRoot: resolve(arg("--output")),
      revision: arg("--revision"),
    }),
  );
}
