import { runnerMatrix } from "./catalog.js";
import type { MatrixExecution, MatrixJob } from "./types.js";

export interface RunnerSelectorOptions {
  all: boolean;
  list: boolean;
  matrixJson: boolean;
  ids: string[];
  suites: string[];
  groups: string[];
  profiles: string[];
  environments: string[];
  cases: string[];
  headed: boolean;
  ui: boolean;
  debug: boolean;
  maxParallel: number;
}

export class RunnerSelectorError extends Error {}

function valueFor(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new RunnerSelectorError(`${flag} requires a value`);
  return value;
}

export function parseRunnerSelectors(
  rawArgs: readonly string[],
): RunnerSelectorOptions {
  const args = rawArgs.filter((value) => value !== "--");
  const options: RunnerSelectorOptions = {
    all: false,
    list: false,
    matrixJson: false,
    ids: [],
    suites: [],
    groups: [],
    profiles: [],
    environments: [],
    cases: [],
    headed: false,
    ui: false,
    debug: false,
    maxParallel: Number(process.env.PAPERCLIP_E2E_MAX_PARALLEL ?? "1"),
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--all") options.all = true;
    else if (flag === "--list") options.list = true;
    else if (flag === "--matrix-json") options.matrixJson = true;
    else if (flag === "--headed") options.headed = true;
    else if (flag === "--ui") options.ui = true;
    else if (flag === "--debug") options.debug = true;
    else if (flag === "--max-parallel") {
      const value = valueFor(args, index, flag);
      index += 1;
      options.maxParallel = Number(value);
    } else if (
      [
        "--id",
        "--suite",
        "--group",
        "--profile",
        "--environment",
        "--case",
      ].includes(flag)
    ) {
      const value = valueFor(args, index, flag);
      index += 1;
      if (flag === "--id") options.ids.push(value);
      else if (flag === "--suite") options.suites.push(value);
      else if (flag === "--group") options.groups.push(value);
      else if (flag === "--profile") options.profiles.push(value);
      else if (flag === "--environment") options.environments.push(value);
      else options.cases.push(value);
    } else {
      throw new RunnerSelectorError(`Unknown runner E2E argument: ${flag}`);
    }
  }

  if (!Number.isInteger(options.maxParallel) || options.maxParallel < 1) {
    throw new RunnerSelectorError("--max-parallel must be a positive integer");
  }

  const hasDimensions =
    options.suites.length +
      options.groups.length +
      options.profiles.length +
      options.environments.length +
      options.cases.length >
    0;
  if (options.ids.length > 0 && (hasDimensions || options.all)) {
    throw new RunnerSelectorError(
      "--id is exclusive with --all and dimension filters",
    );
  }
  if (options.all && hasDimensions) {
    throw new RunnerSelectorError("--all is exclusive with dimension filters");
  }
  if (
    !options.list &&
    !options.matrixJson &&
    !options.all &&
    options.ids.length === 0 &&
    !hasDimensions
  ) {
    throw new RunnerSelectorError(
      "Billable runner E2E runs require --all or an explicit selector",
    );
  }
  return options;
}

function assertKnown(
  label: string,
  selected: readonly string[],
  known: Set<string>,
) {
  const unknown = selected.filter((value) => !known.has(value));
  if (unknown.length > 0)
    throw new RunnerSelectorError(`Unknown ${label}: ${unknown.join(", ")}`);
}

export function selectRunnerExecutions(
  options: RunnerSelectorOptions,
  matrix: readonly MatrixExecution[] = runnerMatrix,
): MatrixExecution[] {
  const knownGroups = new Set(matrix.flatMap((execution) => execution.groups));
  assertKnown(
    "suite",
    options.suites,
    new Set(matrix.map((execution) => execution.suite.id)),
  );
  assertKnown("group", options.groups, knownGroups);
  assertKnown(
    "profile",
    options.profiles,
    new Set(matrix.map((execution) => execution.profile.id)),
  );
  assertKnown(
    "environment",
    options.environments,
    new Set(matrix.map((execution) => execution.environment.id)),
  );
  assertKnown(
    "case",
    options.cases,
    new Set(matrix.map((execution) => execution.task.id)),
  );
  assertKnown(
    "execution id",
    options.ids,
    new Set(matrix.map((execution) => execution.id)),
  );

  const selected = matrix.filter((execution) => {
    if (options.ids.length > 0) return options.ids.includes(execution.id);
    if (
      options.all ||
      (options.list &&
        options.groups.length === 0 &&
        options.suites.length === 0 &&
        options.profiles.length === 0 &&
        options.environments.length === 0 &&
        options.cases.length === 0)
    )
      return true;
    return (
      (options.suites.length === 0 ||
        options.suites.includes(execution.suite.id)) &&
      options.groups.every((group) => execution.groups.includes(group)) &&
      (options.profiles.length === 0 ||
        options.profiles.includes(execution.profile.id)) &&
      (options.environments.length === 0 ||
        options.environments.includes(execution.environment.id)) &&
      (options.cases.length === 0 || options.cases.includes(execution.task.id))
    );
  });
  if (selected.length === 0)
    throw new RunnerSelectorError(
      "Runner E2E selectors matched zero executions",
    );
  return selected;
}

export function buildMatrixJobs(
  executions: readonly MatrixExecution[],
): MatrixJob[] {
  return executions
    .map((execution) => ({
      executionId: execution.id,
      suiteId: execution.suite.id,
      profileId: execution.profile.id,
      credentialName: execution.profile.credential,
      environmentId: execution.environment.id,
      caseId: execution.task.id,
      timeoutMinutes: Math.max(
        execution.environment.id === "daytona" ? 40 : 25,
        Math.ceil(
          (2 *
            (execution.task.attemptTimeoutMs[execution.environment.id] +
              90_000) +
            5 * 60_000) /
            60_000,
        ),
      ),
      needsDaytona: execution.environment.id === "daytona",
    }))
    .sort((left, right) => left.executionId.localeCompare(right.executionId));
}
