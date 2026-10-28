import { validateRetainedRunnerResult } from "./result-validation.js";
import { createHash } from "node:crypto";
import type { MatrixExecution, RunnerE2EResult } from "./types.js";

/** Presentation aliases only; retained execution identities never change. */
export const retainedSuiteLabels: Readonly<Record<string, string>> = { "qa-basics": "Basic app journeys" };

/** Display-only metadata: never load or reconstruct executable branch fixtures. */
export interface ReportExecution {
  id: string;
  suiteDefinitionHash: string;
  suite: Pick<
    MatrixExecution["suite"],
    "id" | "label" | "description" | "expectedMatrixSize"
  >;
  profile: { id: string; label: string; generation: "legacy" | "native" | "none"; provider: string | null; model: string | null; expectedRuntimeMode: "legacy" | "native" | "none" };
  environment: Pick<
    MatrixExecution["environment"],
    "id" | "label" | "provider" | "expectedExecutionTarget"
  >;
  task: Pick<MatrixExecution["task"], "id" | "label">;
}

export function parseReportExecutionId(id: string) {
  // These identities also become evidence paths. Reject path traversal and any
  // syntax other than catalog identities, even in imported JSON. Deployment
  // journeys add one explicit target segment; all historical IDs stay intact.
  if (typeof id !== "string")
    throw new Error("Report execution identity must be a string");
  const journey = /^(product-journeys)\.([a-z0-9][a-z0-9_-]*)\.([a-z0-9][a-z0-9_-]*)\.(local|daytona)\.([a-z0-9][a-z0-9_-]*)$/.exec(id);
  if (journey && id.length <= 512) return { suiteId: journey[1]!, targetId: journey[2]!, profileId: journey[3]!, environmentId: journey[4]! as "local" | "daytona", caseId: journey[5]! };
  const match =
    /^([a-z0-9][a-z0-9_-]*)\.([a-z0-9][a-z0-9_-]*)\.(local|daytona)\.([a-z0-9][a-z0-9_-]*)$/.exec(
      id,
    );
  if (!match || id.length > 512)
    throw new Error(
      `Invalid report execution identity: ${String(id).slice(0, 512)}`,
    );
  return {
    suiteId: match[1]!,
    profileId: match[2]!,
    environmentId: match[3]! as "local" | "daytona",
    caseId: match[4]!,
    targetId: undefined,
  };
}

export function validateReportResultIdentity(result: RunnerE2EResult) {
  validateRetainedRunnerResult(result);
  const identity = parseReportExecutionId(result.executionId);
  if (
    (result.suiteId !== undefined && result.suiteId !== identity.suiteId) ||
    result.profileId !== identity.profileId ||
    result.environmentId !== identity.environmentId ||
    result.caseId !== identity.caseId
    || identity.targetId !== undefined && result.productJourney?.targetId !== identity.targetId
  ) {
    throw new Error(
      `Result identity does not match execution ID: ${result.executionId}`,
    );
  }
  return identity;
}

export function discoverReportCatalog(input: {
  catalog: readonly ReportExecution[];
  expected: readonly string[];
  results: readonly RunnerE2EResult[];
}): ReportExecution[] {
  const expected = new Set(input.expected);
  if (expected.size !== input.expected.length)
    throw new Error("Report expected identities must be unique");
  const identities = new Map(
    input.expected.map((id) => [id, parseReportExecutionId(id)]),
  );
  const results = new Map<string, RunnerE2EResult>();
  for (const result of input.results) {
    validateReportResultIdentity(result);
    if (expected.has(result.executionId))
      results.set(result.executionId, result);
  }
  const catalog = [...input.catalog];
  const knownIds = new Set(catalog.map((execution) => execution.id));
  const knownSuites = new Map(
    catalog.map((execution) => [execution.suite.id, execution.suite]),
  );
  for (const [id, identity] of identities) {
    if (knownIds.has(id)) continue;
    const result = results.get(id);
    const suiteIds = input.expected
      .filter(
        (candidate) => identities.get(candidate)?.suiteId === identity.suiteId,
      )
      .sort();
    const suite = knownSuites.get(identity.suiteId) ?? {
      id: identity.suiteId,
      label: retainedSuiteLabels[identity.suiteId] ?? identity.suiteId,
      description:
        "Suite discovered from retained campaign identities; full suite size is not known to this publisher.",
      expectedMatrixSize: suiteIds.length,
    };
    const knownProfile = input.catalog.find(
      (execution) => execution.suite.id === identity.suiteId && execution.profile.id === identity.profileId,
    )?.profile ?? input.catalog.find(
      (execution) => execution.profile.id === identity.profileId &&
        (!result || execution.profile.provider === result.provider && execution.profile.model === result.model),
    )?.profile;
    const knownEnvironment = input.catalog.find(
      (execution) => execution.environment.id === identity.environmentId,
    )?.environment;
    const runtimeMode = result?.runtimeMode ?? "native";
    catalog.push({
      id,
      suite,
      suiteDefinitionHash:
        result?.suiteDefinitionHash ??
        `selection-${createHash("sha256").update(JSON.stringify(suiteIds)).digest("hex")}`,
      profile: knownProfile ?? {
        id: identity.profileId,
        label: identity.profileId,
        generation: runtimeMode,
        expectedRuntimeMode: runtimeMode,
        provider:
          result?.runtimeMode === "none" ? null : result?.provider ?? "unknown",
        model: result?.runtimeMode === "none" ? null : result?.model ?? "unknown",
      },
      environment: knownEnvironment ?? {
        id: identity.environmentId,
        label: identity.environmentId,
        provider: identity.environmentId,
        expectedExecutionTarget: {
          kind: identity.environmentId === "local" ? "local" : "remote",
        },
      },
      task: { id: identity.caseId, label: identity.caseId },
    });
  }
  return catalog;
}
