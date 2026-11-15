/**
 * CLI execution for company memory upgrade filter subcommand (TECH-8572).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatFilterTextReport,
  runFilter,
  type FilterDependencies,
} from "../server/src/services/company-memory-upgrade/filter.js";
import { sanitizeCliErrorMessage } from "./memory-upgrade.js";
import { parseFilterArgs } from "./memory-upgrade-filter-args.js";
import {
  ALLOWED_FILTER_FLAGS,
  BOOLEAN_FILTER_FLAGS,
} from "./memory-upgrade-filter-flags.js";

export { ALLOWED_FILTER_FLAGS, BOOLEAN_FILTER_FLAGS };

export interface RunFilterCliDependencies extends FilterDependencies {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export async function runFilterCli(
  argv: string[],
  deps: RunFilterCliDependencies = {},
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const repoRoot = deps.repoRoot ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));

    const parsed = parseFilterArgs(argv, env, repoRoot);
    if ("exitCode" in parsed) {
      return parsed.exitCode;
    }

    const report = await runFilter(
      {
        manifestPath: parsed.manifestPath,
        jsonlPath: parsed.jsonlPath,
        outputDir: parsed.outputDir,
        companyId: parsed.companyId,
        agentId: parsed.agentId,
        upgradeId: parsed.upgradeId,
        openaiKeyFile: parsed.openaiKeyFile,
        model: parsed.model,
        maxCostUsd: parsed.maxCostUsd,
        isDryRun: parsed.isDryRun,
        confirm: parsed.confirm,
        keepImportKeysPath: parsed.keepImportKeysPath,
        controlPlaneDatabaseUrl: parsed.controlPlaneUrl,
        format: parsed.format,
        allowProd: parsed.allowProd,
        concurrency: parsed.concurrency,
        chatRpm: parsed.chatRpm,
        chatTpm: parsed.chatTpm,
      },
      deps,
    );

    if (parsed.format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatFilterTextReport(report));
    }

    return 0;
  } catch (error) {
    const message = sanitizeCliErrorMessage(error);
    console.error(`Error: ${message}`);
    return 1;
  }
}
