import path from "node:path";
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
import { resolvePaperclipInstanceId, resolvePaperclipInstanceRoot } from "../config/home.js";
import { loadPaperclipEnvFile } from "../config/env.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import {
  acquireRepairLock,
  backupFile,
  checkRunLock,
  isSystemdServiceActive,
  type ProcessLock,
} from "../utils/process-lock.js";

const STATUS_ICON = {
  pass: pc.green("✓"),
  warn: pc.yellow("!"),
  fail: pc.red("✗"),
} as const;

export async function doctor(opts: {
  config?: string;
  repair?: boolean;
  yes?: boolean;
  force?: boolean;
  /** Internal flag: skip the runtime-active guard when doctor is called from within `run`. */
  _calledByRun?: boolean;
}): Promise<{ passed: number; warned: number; failed: number }> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip doctor ")));

  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  const results: CheckResult[] = [];

  // ── Runtime-active guard ──────────────────────────────────────────────────
  // Refuse --repair while a server process is running to prevent clobbering
  // in-flight hotfixes. Bypassed when called from `paperclipai run` (which
  // already holds the runtime lock) or when --force is explicitly passed.
  if (opts.repair && !opts.force && !opts._calledByRun) {
    const instanceId = resolvePaperclipInstanceId();
    const instanceRoot = resolvePaperclipInstanceRoot(instanceId);
    const runPid = checkRunLock(instanceRoot);
    const serviceActive = isSystemdServiceActive("paperclip.service");

    if (runPid !== null || serviceActive) {
      const reason =
        runPid !== null
          ? `a paperclipai run process (PID ${runPid}) is active`
          : "paperclip.service is active via systemd";
      p.log.error(
        `Cannot run --repair: ${reason}.\n` +
          `Running --repair while the server is live risks overwriting hotfixes.\n` +
          `Stop the runtime first, or pass --force to override this guard.`,
      );
      return { passed: 0, warned: 0, failed: 1 };
    }
  }

  // ── Repair concurrency lock ───────────────────────────────────────────────
  // Reject a second concurrent `doctor --repair` so repairs cannot race.
  let repairLock: ProcessLock | undefined;
  if (opts.repair) {
    const instanceId = resolvePaperclipInstanceId();
    const instanceRoot = resolvePaperclipInstanceRoot(instanceId);
    try {
      repairLock = acquireRepairLock(instanceRoot);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
      return { passed: 0, warned: 0, failed: 1 };
    }
  }

  try {
    // 1. Config check (must pass before others)
    const cfgResult = configCheck(opts.config);
    results.push(cfgResult);
    printResult(cfgResult);

    if (cfgResult.status === "fail") {
      return printSummary(results);
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
      return printSummary(results);
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
    return printSummary(results);
  } finally {
    repairLock?.release();
  }
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

  // Backup any files this repair intends to overwrite so hotfixes are preserved.
  if (result.repairWillOverwrite) {
    for (const targetPath of result.repairWillOverwrite) {
      const backup = backupFile(targetPath);
      if (backup) {
        p.log.warn(
          `Hotfix-safe backup: ${path.basename(targetPath)} → ${backup}`,
        );
      }
    }
  }

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

  // Repairs may create/update the adjacent .env file or other local resources.
  loadPaperclipEnvFile(input.configPath);
  result = await input.run();
  printResult(result);
  return result;
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
