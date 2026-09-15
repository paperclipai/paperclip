import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { runnerMatrix } from "./catalog.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import {
  buildRunnerCampaign,
  canonicalExecutionId,
  upgradeRunnerResult,
} from "./history.js";
import type {
  RunnerE2ECampaign,
  RunnerE2EHistoryIndex,
  RunnerE2EResult,
} from "./types.js";

interface PublishedResult extends RunnerE2EResult {
  evidenceValid?: boolean;
  evidenceErrors?: string[];
}

interface PublishedCampaign {
  schema?: string;
  campaignId?: string;
  generatedAt: string;
  expected: string[];
  results: PublishedResult[];
}

async function relativeFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(
    () => [],
  );
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory())
      files.push(...(await relativeFiles(root, absolute)));
    if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  return files;
}

async function readOptionalHistory(file: string) {
  return readFile(file, "utf8")
    .then((value) => JSON.parse(value) as RunnerE2EHistoryIndex)
    .then((value) =>
      value.schema === "paperclip.runner-e2e.history/v1" ? value : undefined,
    )
    .catch(() => undefined);
}

export async function regenerateRunnerDashboard(input: {
  bundle: string;
  historyFile?: string | null;
  outputDirectory?: string;
  evidenceHrefPrefix?: string;
  publicSummaryImageHref?: string;
}) {
  const bundle = path.resolve(input.bundle);
  const outputDirectory = path.resolve(input.outputDirectory ?? bundle);
  const evidenceHrefPrefix = input.evidenceHrefPrefix?.replace(
    /^\/+|\/+$/g,
    "",
  );
  if (
    evidenceHrefPrefix &&
    (evidenceHrefPrefix.includes("\\") ||
      evidenceHrefPrefix
        .split("/")
        .some((segment) => !segment || segment === "." || segment === ".."))
  ) {
    throw new Error("evidenceHrefPrefix must be a safe relative URL path");
  }
  const normalized = JSON.parse(
    await readFile(path.join(bundle, "normalized-results.json"), "utf8"),
  ) as PublishedCampaign;
  if (
    !Array.isArray(normalized.expected) ||
    !Array.isArray(normalized.results) ||
    typeof normalized.generatedAt !== "string"
  ) {
    throw new Error("Published bundle has an invalid normalized-results.json");
  }

  const results = normalized.results.map(upgradeRunnerResult);
  const expected = normalized.expected.map(canonicalExecutionId);
  const campaign: RunnerE2ECampaign = buildRunnerCampaign({
    campaignId:
      normalized.campaignId ??
      `legacy-${normalized.generatedAt.replace(/[:.]/g, "-")}`,
    generatedAt: normalized.generatedAt,
    expected,
    results,
  });
  const history =
    input.historyFile === null
      ? undefined
      : await readOptionalHistory(
          input.historyFile ?? path.join(bundle, "history.json"),
        );
  const entries = await Promise.all(
    normalized.results.map(async (publishedResult, index) => {
      const result = results[index]!;
      const originalExecutionId = publishedResult.executionId;
      const evidenceIds = [
        originalExecutionId,
        ...(originalExecutionId.startsWith("core-compatibility.")
          ? [originalExecutionId.slice("core-compatibility.".length)]
          : []),
      ];
      let evidenceBaseHref = "";
      let evidenceFiles: string[] = [];
      for (const evidenceId of evidenceIds) {
        const candidate = [
          "evidence",
          evidenceId,
          `attempt-${result.attempt}`,
        ].join("/");
        const files = await relativeFiles(
          path.join(bundle, ...candidate.split("/")),
        );
        if (files.length === 0) continue;
        evidenceBaseHref = [evidenceHrefPrefix, candidate]
          .filter(Boolean)
          .join("/");
        evidenceFiles = files;
        break;
      }
      return {
        result,
        valid:
          publishedResult.evidenceValid ??
          (result.status === "passed" && result.cleanup === "passed"),
        errors: publishedResult.evidenceErrors ?? [],
        evidenceBaseHref,
        evidenceFiles,
      };
    }),
  );
  const dashboard = renderRunnerE2EDashboard({
    title: "Runner Full-Stack E2E",
    generatedAt: normalized.generatedAt,
    expected,
    catalog: runnerMatrix,
    entries,
    campaign,
    history,
    publicSummaryImageHref: input.publicSummaryImageHref,
  });
  const upgraded = {
    ...campaign,
    results: campaign.results.map((result, index) => ({
      ...result,
      evidenceValid:
        normalized.results[index]?.evidenceValid ??
        (result.status === "passed" && result.cleanup === "passed"),
      evidenceErrors: normalized.results[index]?.evidenceErrors ?? [],
    })),
  };
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, "index.html"), dashboard, "utf8"),
    writeFile(path.join(outputDirectory, "dashboard.html"), dashboard, "utf8"),
    writeFile(
      path.join(outputDirectory, "normalized-results.json"),
      `${JSON.stringify(upgraded, null, 2)}\n`,
      "utf8",
    ),
  ]);
  console.log(
    `Regenerated dashboard from ${normalized.results.length} retained result(s) in ${outputDirectory}`,
  );
}

async function main() {
  const arguments_ = process.argv
    .slice(2)
    .filter((argument) => argument !== "--");
  const bundleArgument = arguments_.find(
    (argument) => !argument.startsWith("--"),
  );
  if (!bundleArgument) {
    throw new Error(
      "Usage: pnpm test:e2e:runner:dashboard -- <published-bundle-directory> [--history <history.json>]",
    );
  }
  const historyIndex = arguments_.indexOf("--history");
  const historyFile =
    historyIndex >= 0 ? arguments_[historyIndex + 1] : undefined;
  if (historyIndex >= 0 && !historyFile)
    throw new Error("--history requires a path");
  await regenerateRunnerDashboard({ bundle: bundleArgument, historyFile });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
