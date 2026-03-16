import * as p from "@clack/prompts";
import pc from "picocolors";
import type { PaperclipConfig } from "../config/schema.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import {
  agentJwtSecretCheck,
  configCheck,
  databaseCheck,
  deploymentAuthCheck,
  llmCheck,
  logCheck,
  portCheck,
  secretsCheck,
  storageCheck,
  type CheckResult,
} from "../checks/index.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import { loadPaperclipEnvFile } from "../config/env.js";
import { readRepoStartupProfile, readRecentLaunchHistory } from "../config/startup-profile.js";

const STATUS_ICON = {
  pass: pc.green("✓"),
  warn: pc.yellow("!"),
  fail: pc.red("✗"),
} as const;

export async function doctor(opts: {
  config?: string;
  repair?: boolean;
  yes?: boolean;
  launchHistory?: boolean;
}): Promise<{ passed: number; warned: number; failed: number }> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip doctor ")));

  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  const results: CheckResult[] = [];
  const startupProfile = readRepoStartupProfile();

  if (startupProfile) {
    p.note(
      [
        `profile: ${startupProfile.profilePath}`,
        `home: ${startupProfile.paperclipHome}`,
        `instance: ${startupProfile.instanceId}`,
        `config: ${startupProfile.configPath}`,
      ].join("\n"),
      "Repo Startup Profile",
    );
  }

  // 1. Config check (must pass before others)
  const cfgResult = configCheck(opts.config);
  results.push(cfgResult);
  printResult(cfgResult);

  if (cfgResult.status === "fail") {
    const summary = printSummary(results);
    if (opts.launchHistory) printLaunchHistory(startupProfile);
    return summary;
  }

  let config: PaperclipConfig;
  try {
    config = readConfig(opts.config)!;
  } catch (err) {
    const readResult: CheckResult = {
      name: "Config file",
      status: "fail",
      message: `Could not read config: ${err instanceof Error ? err.message : String(err)}`,
      canRepair: false,
      repairHint: "Run `paperclipai configure --section database` or `paperclipai onboard`",
    };
    results.push(readResult);
    printResult(readResult);
    const summary = printSummary(results);
    if (opts.launchHistory) printLaunchHistory(startupProfile);
    return summary;
  }

  // 2. Deployment/auth mode check
  const deploymentAuthResult = deploymentAuthCheck(config);
  results.push(deploymentAuthResult);
  printResult(deploymentAuthResult);

  // 3. Agent JWT check
  results.push(
    await runRepairableCheck({
      run: () => agentJwtSecretCheck(opts.config),
      configPath,
      opts,
    }),
  );

  // 4. Secrets adapter check
  results.push(
    await runRepairableCheck({
      run: () => secretsCheck(config, configPath),
      configPath,
      opts,
    }),
  );

  // 5. Storage check
  results.push(
    await runRepairableCheck({
      run: () => storageCheck(config, configPath),
      configPath,
      opts,
    }),
  );

  // 6. Database check
  results.push(
    await runRepairableCheck({
      run: () => databaseCheck(config, configPath),
      configPath,
      opts,
    }),
  );

  // 7. LLM check
  const llmResult = await llmCheck(config);
  results.push(llmResult);
  printResult(llmResult);

  // 8. Log directory check
  results.push(
    await runRepairableCheck({
      run: () => logCheck(config, configPath),
      configPath,
      opts,
    }),
  );

  // 9. Port check
  const portResult = await portCheck(config);
  results.push(portResult);
  printResult(portResult);

  // Summary
  const summary = printSummary(results);

  if (opts.launchHistory) {
    printLaunchHistory(startupProfile);
  }

  return summary;
}

function printResult(result: CheckResult): void {
  const icon = STATUS_ICON[result.status];
  p.log.message(`${icon} ${pc.bold(result.name)}: ${result.message}`);
  if (result.status !== "pass" && result.repairHint) {
    p.log.message(`  ${pc.dim(result.repairHint)}`);
  }
}

async function maybeRepair(
  result: CheckResult,
  opts: { repair?: boolean; yes?: boolean },
): Promise<boolean> {
  if (result.status === "pass" || !result.canRepair || !result.repair) return false;
  if (!opts.repair) return false;

  let shouldRepair = opts.yes;
  if (!shouldRepair) {
    const answer = await p.confirm({
      message: `Repair "${result.name}"?`,
      initialValue: true,
    });
    if (p.isCancel(answer)) return false;
    shouldRepair = answer;
  }

  if (shouldRepair) {
    try {
      await result.repair();
      p.log.success(`Repaired: ${result.name}`);
      return true;
    } catch (err) {
      p.log.error(`Repair failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return false;
}

async function runRepairableCheck(input: {
  run: () => CheckResult | Promise<CheckResult>;
  configPath: string;
  opts: { repair?: boolean; yes?: boolean };
}): Promise<CheckResult> {
  let result = await input.run();
  printResult(result);

  const repaired = await maybeRepair(result, input.opts);
  if (!repaired) return result;

  loadPaperclipEnvFile(input.configPath);
  result = await input.run();
  printResult(result);
  return result;
}

function formatLaunchHistoryValue(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "—";
}

function printLaunchHistory(profile: ReturnType<typeof readRepoStartupProfile>): void {
  if (!profile) {
    p.note("No repo-local startup profile found in this checkout.", "Launch History");
    return;
  }

  const rows = readRecentLaunchHistory(profile, 10);
  if (rows.length === 0) {
    p.note("No launch history entries found for this instance yet.", "Launch History");
    return;
  }

  const rendered = rows.map((row) => {
    const recordedAt = formatLaunchHistoryValue(row.recordedAt);
    const result = formatLaunchHistoryValue(row.result);
    const source = formatLaunchHistoryValue(row.startupSource);
    const databaseRef = formatLaunchHistoryValue(row.databaseRef);
    const failureMessage = formatLaunchHistoryValue(row.failureMessage);
    const failureLine = failureMessage !== "—" ? `\n  error: ${failureMessage}` : "";
    return `${recordedAt}  ${result}  (${source})\n  db: ${databaseRef}${failureLine}`;
  });
  p.note(rendered.join("\n\n"), "Launch History");
}

function printSummary(results: CheckResult[]): { passed: number; warned: number; failed: number } {
  const passed = results.filter((r) => r.status === "pass").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const failed = results.filter((r) => r.status === "fail").length;

  const parts: string[] = [];
  parts.push(pc.green(`${passed} passed`));
  if (warned) parts.push(pc.yellow(`${warned} warnings`));
  if (failed) parts.push(pc.red(`${failed} failed`));

  p.note(parts.join(", "), "Summary");

  if (failed > 0) {
    p.outro(pc.red("Some checks failed. Fix the issues above and re-run doctor."));
  } else if (warned > 0) {
    p.outro(pc.yellow("All critical checks passed with some warnings."));
  } else {
    p.outro(pc.green("All checks passed!"));
  }

  return { passed, warned, failed };
}
