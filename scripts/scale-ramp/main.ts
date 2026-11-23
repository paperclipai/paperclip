import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { cleanupRun, discoverState, type CleanupReport } from "./cleanup.ts";
import { PaperclipClient, Redactor, realClock, type Clock, type Fetcher } from "./client.ts";
import { FALLBACK_TOKEN_ENV, metricsCredential, parseOptions, readSecrets, TOKEN_ENV, type Options } from "./config.ts";
import { criteriaTable } from "./criteria.ts";
import { checkSpend, estimateSpend, type SpendEstimate } from "./estimate.ts";
import { Ramp, type RampOutcome } from "./ramp.ts";
import { buildResult, summaryLines, verdictOf } from "./report.ts";
import { prepareCompany } from "./setup.ts";
import { emptyState, fileStateStore, type RunState } from "./state.ts";

export interface MainDeps {
  env: NodeJS.ProcessEnv;
  fetcher: Fetcher;
  clock: Clock;
  out: (line: string) => void;
  err: (line: string) => void;
  confirm: (question: string) => Promise<string>;
  onInterrupt: (handler: () => void) => () => void;
  random?: () => number;
}

export const EXIT = { pass: 0, fail: 1, usage: 2, incomplete: 3, error: 4 } as const;

export function planLines(options: Options, estimate: SpendEstimate): string[] {
  const steps = options.steps.map(step => `${step.concurrency}`).join(" -> ");
  const credential = options.profile.credentialKey === null ? "none"
    : options.profile.providerSecretId ? `existing secret for ${options.profile.credentialKey}`
      : `${options.profile.credentialKey} from the environment, stored as a company secret and deleted at cleanup`;
  return [
    `Target: ${options.target.baseUrl} (${options.target.kind})`,
    `Run id: ${options.label}`,
    `Company: ${options.companyId ?? "a new company named for the run id"}`,
    `Ramp: ${steps} agents, ${options.steps[0]!.holdMs / 60_000} min per step, drain ${options.drainMs / 60_000} min, stop on the first failed criterion`,
    `Agents: up to ${estimate.agents}, ${options.profile.provider} ${options.profile.model}; credential: ${credential}`,
    `Tasks: about ${estimate.tasks}, hard cap ${estimate.maxTasks}`,
    `Estimated spend: $${estimate.totalUsd} (model $${estimate.modelUsd}, sandboxes $${estimate.sandboxUsd} for ${estimate.sandboxHours} sandbox-hours), about ${estimate.wallMinutes} min`,
    ...estimate.assumptions.map(line => `  assumption: ${line}`),
    "Criteria:",
    ...criteriaTable(options.thresholds).map(criterion => `  ${criterion.id} [${criterion.source}] ${criterion.description}: ${criterion.threshold}`),
  ];
}

async function writeOutputs(dir: string, name: string, body: unknown, summary: string[] | null, redactor: Redactor): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, name), `${redactor.text(JSON.stringify(body, null, 2))}\n`, { mode: 0o600 });
  if (summary) await writeFile(path.join(dir, "SUMMARY.md"), `${redactor.text(summary.join("\n"))}\n`, { mode: 0o600 });
}

export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv, deps.env, deps.clock.now(), deps.random);
  } catch (error) {
    deps.err(`scale ramp: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.usage;
  }
  const secrets = readSecrets(deps.env, options.profile.providerSecretId ? null : options.profile.credentialKey);
  const redactor = new Redactor([secrets.token, secrets.credential, secrets.metricsToken]);
  const out = (line: string) => deps.out(redactor.text(line));
  const err = (line: string) => deps.err(redactor.text(line));
  const estimate = estimateSpend(options);

  if (options.mode !== "cleanup") for (const line of planLines(options, estimate)) out(line);
  if (options.mode === "dry-run") {
    out("Dry run: nothing was created or contacted.");
    return EXIT.pass;
  }
  if (options.mode === "run") {
    const spend = checkSpend(estimate, options.spendThresholdUsd, options.confirmSpendUsd);
    if (!spend.ok) {
      err(spend.reason);
      return EXIT.usage;
    }
  }
  if (!secrets.token) {
    err(`Set ${TOKEN_ENV} (or ${FALLBACK_TOKEN_ENV}) to a board token for ${options.target.host}`);
    return EXIT.usage;
  }
  if (!options.yes) {
    const action = options.mode === "cleanup" ? `clean up ${options.label} on` : "start creating agents and tasks on";
    const answer = await deps.confirm(`Type ${options.target.host} to ${action} it: `);
    if (answer.trim().toLowerCase() !== options.target.host) {
      err("Confirmation did not match the target host; nothing was done.");
      return EXIT.usage;
    }
  }

  const api = new PaperclipClient(options.target, secrets.token, deps.fetcher, deps.clock, redactor);
  const store = fileStateStore(options.outDir);

  if (options.mode === "cleanup") {
    let report: CleanupReport | null = null;
    let error: string | null = null;
    try {
      const state = await store.load() ?? await discoverState(api, options.label, options.companyId, options.target.baseUrl, deps.clock.now());
      report = await cleanupRun({ api, clock: deps.clock, label: options.label, state, log: out });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    await writeOutputs(options.outDir, `cleanup-${deps.clock.now()}.json`, { runId: options.label, report, error }, null, redactor);
    if (error) err(`Cleanup failed: ${error}`);
    if (report) out(`Cleanup ${options.label}: ${report.runsCancelled} runs cancelled, ${report.tasksArchived} tasks archived, ${report.agentsDeleted} agents deleted, ${report.errors.length} errors`);
    return error || (report?.errors.length ?? 0) > 0 ? EXIT.fail : EXIT.pass;
  }

  let interrupted = false;
  const release = deps.onInterrupt(() => {
    interrupted = true;
    err("Interrupt received: stopping the ramp and cleaning up");
  });
  const startedAt = deps.clock.now();
  const state: RunState = emptyState(options.label, options.target.baseUrl, startedAt);
  let outcome: RampOutcome | null = null;
  let cleanup: CleanupReport | null = null;
  let error: string | null = null;
  try {
    await store.save(state);
    await prepareCompany({ api, options, state, store, credential: secrets.credential, log: out });
    const ramp = new Ramp({
      api, clock: deps.clock, fetcher: deps.fetcher, options, state, store, maxTasks: estimate.maxTasks,
      spendCapUsd: options.confirmSpendUsd ?? Math.max(options.spendThresholdUsd, estimate.totalUsd), metricsToken: metricsCredential(options, secrets),
      log: out, shouldStop: () => interrupted,
    });
    outcome = await ramp.run();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    err(`Ramp stopped by an error: ${error}`);
  } finally {
    out(`Cleaning up ${options.label}`);
    try {
      cleanup = await cleanupRun({ api, clock: deps.clock, label: options.label, state, log: out });
    } catch (caught) {
      err(`Cleanup failed; finish it with --cleanup-only ${options.label}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    release();
  }
  const failedRequests = api.records.filter(record => !record.ok).length;
  const result = buildResult({
    options, estimate, startedAt, finishedAt: deps.clock.now(), outcome, cleanup, error,
    requests: { total: api.records.length, failed: failedRequests },
    credentialSource: options.profile.credentialKey === null ? "none" : options.profile.providerSecretId ? "existing secret" : "stored for the run and deleted at cleanup",
  });
  const summary = summaryLines(result);
  await writeOutputs(options.outDir, "result.json", result, summary, redactor);
  for (const line of summary) out(line);
  out(`Result: ${path.join(options.outDir, "result.json")}`);
  if (cleanup && cleanup.errors.length) err(`Cleanup left ${cleanup.errors.length} errors; finish it with --cleanup-only ${options.label}`);
  const verdict = verdictOf(outcome, error);
  return verdict === "pass" ? EXIT.pass : verdict === "fail" ? EXIT.fail : verdict === "incomplete" ? EXIT.incomplete : EXIT.error;
}

export function processDeps(): MainDeps {
  return {
    env: process.env,
    fetcher: (url, init) => fetch(url, init),
    clock: realClock,
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    confirm: async question => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    onInterrupt: handler => {
      const listener = () => handler();
      process.once("SIGINT", listener);
      process.once("SIGTERM", listener);
      return () => {
        process.off("SIGINT", listener);
        process.off("SIGTERM", listener);
      };
    },
  };
}
