import { capabilityCanonicalOperation } from "./catalog/index.js";

export const PAPERCLIP_RUNNER_COMPATIBILITY = Object.freeze({
  schema: "paperclip.runner.compatibility.v1" as const,
  packageName: "@paperclipai/paperclip-runner" as const,
  packageVersion: "0.0.0" as const,
  components: Object.freeze({
    catalog: 1,
    protocol: 1,
    prp: 1,
    runnerClient: 1,
    runnerdBinary: 2,
    harnessDriver: 1,
    nativeExecution: 1,
    evalIntegration: 1,
    controlPlaneAdapter: 1,
    testkit: 1,
  }),
  evalCorpus: Object.freeze({ minimum: 1, maximum: 1 }),
});

export type PaperclipRunnerCompatibilityComponent =
  keyof typeof PAPERCLIP_RUNNER_COMPATIBILITY.components;

export type PaperclipRunnerCompatibilityIssueCode =
  | "component_version_mismatch"
  | "eval_corpus_version_unsupported"
  | "catalog_operation_unknown"
  | "provider_capabilities_missing"
  | "provider_operation_unsupported";

export interface PaperclipRunnerCompatibilityIssue {
  readonly code: PaperclipRunnerCompatibilityIssueCode;
  readonly component?: PaperclipRunnerCompatibilityComponent | "evalCorpus" | "provider";
  readonly expected?: string;
  readonly received?: string;
  readonly operationId?: string;
  readonly providerId?: string;
  readonly message: string;
}

export interface PaperclipProviderCompatibility {
  readonly id: string;
  readonly supportedOperationIds: readonly string[];
}

export interface PaperclipRunnerCompatibilityRequirement {
  readonly consumer: string;
  readonly components?: Partial<Readonly<Record<PaperclipRunnerCompatibilityComponent, number>>>;
  readonly evalCorpusVersion?: number;
  readonly requiredOperationIds?: readonly string[];
  readonly provider?: PaperclipProviderCompatibility;
}

export class PaperclipRunnerCompatibilityError extends Error {
  readonly code = "paperclip_runner_incompatible" as const;
  readonly issues: readonly PaperclipRunnerCompatibilityIssue[];

  constructor(
    readonly consumer: string,
    issues: readonly PaperclipRunnerCompatibilityIssue[],
  ) {
    super(
      `Paperclip runner compatibility check failed for ${consumer}: ${issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "PaperclipRunnerCompatibilityError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

/**
 * Fail-closed preflight shared by production bindings, testkit consumers, and
 * eval bundles. Provider limitations are reported as stable compatibility
 * issues instead of being inferred from provider-specific failures later.
 */
export function assertPaperclipRunnerCompatibility(
  requirement: PaperclipRunnerCompatibilityRequirement,
): typeof PAPERCLIP_RUNNER_COMPATIBILITY {
  const issues: PaperclipRunnerCompatibilityIssue[] = [];

  for (const [component, received] of Object.entries(requirement.components ?? {}) as Array<
    [PaperclipRunnerCompatibilityComponent, number]
  >) {
    const expected = PAPERCLIP_RUNNER_COMPATIBILITY.components[component];
    if (received !== expected) {
      issues.push({
        code: "component_version_mismatch",
        component,
        expected: String(expected),
        received: String(received),
        message: `${component} contract v${received} is incompatible with v${expected}`,
      });
    }
  }

  if (requirement.evalCorpusVersion !== undefined) {
    const { minimum, maximum } = PAPERCLIP_RUNNER_COMPATIBILITY.evalCorpus;
    if (
      requirement.evalCorpusVersion < minimum
      || requirement.evalCorpusVersion > maximum
    ) {
      issues.push({
        code: "eval_corpus_version_unsupported",
        component: "evalCorpus",
        expected: `${minimum}..${maximum}`,
        received: String(requirement.evalCorpusVersion),
        message: `eval corpus v${requirement.evalCorpusVersion} is outside supported range ${minimum}..${maximum}`,
      });
    }
  }

  const requiredOperations = [...new Set(requirement.requiredOperationIds ?? [])].sort();
  const knownOperations: string[] = [];
  for (const operationId of requiredOperations) {
    if (capabilityCanonicalOperation(operationId) === undefined) {
      issues.push({
        code: "catalog_operation_unknown",
        component: "catalog",
        operationId,
        message: `required operation ${operationId} is absent from the canonical catalog`,
      });
    } else {
      knownOperations.push(operationId);
    }
  }

  if (knownOperations.length > 0 && requirement.provider === undefined) {
    issues.push({
      code: "provider_capabilities_missing",
      component: "provider",
      message: "required operations need an explicit provider capability declaration",
    });
  } else if (requirement.provider !== undefined) {
    const supported = new Set(requirement.provider.supportedOperationIds);
    for (const operationId of knownOperations) {
      if (!supported.has(operationId)) {
        issues.push({
          code: "provider_operation_unsupported",
          component: "provider",
          operationId,
          providerId: requirement.provider.id,
          message: `provider ${requirement.provider.id} does not support required operation ${operationId}`,
        });
      }
    }
  }

  if (issues.length > 0) {
    throw new PaperclipRunnerCompatibilityError(requirement.consumer, issues);
  }
  return PAPERCLIP_RUNNER_COMPATIBILITY;
}
