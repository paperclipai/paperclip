import type { HarnessDriverDescriptor } from "../contracts/harness-driver.js";
import type { NativeSessionCapabilities } from "../contracts/types.js";
import { negotiateProtocolVersion } from "../protocol/replay-contract.js";
import {
  PAPERCLIP_RUNNER_BUILD_METADATA,
  PAPERCLIP_RUNNER_EVAL_INTEGRATION_SCHEMA,
} from "./build-metadata.js";
import type { PaperclipRunnerdBuildMetadata } from "./runnerd-artifact.js";

export type RequiredHarnessDriverCapability = Exclude<
  keyof NativeSessionCapabilities,
  "unsupported"
>;

export type PaperclipRunnerEvalCompatibilityIssueCode =
  | "package_version_mismatch"
  | "binary_package_version_mismatch"
  | "binary_contract_version_mismatch"
  | "native_execution_version_mismatch"
  | "prp_name_mismatch"
  | "prp_version_no_overlap"
  | "catalog_version_mismatch"
  | "catalog_digest_mismatch"
  | "driver_contract_version_mismatch"
  | "driver_protocol_version_mismatch"
  | "driver_capability_unsupported";

export interface PaperclipRunnerEvalCompatibilityIssue {
  code: PaperclipRunnerEvalCompatibilityIssueCode;
  component: "package" | "binary" | "nativeExecution" | "prp" | "catalog" | "driver";
  expected: string;
  received: string;
  message: string;
}

export interface PaperclipRunnerEvalCompatibilityRequirement {
  consumer: string;
  packageVersion: string;
  runnerd: PaperclipRunnerdBuildMetadata;
  nativeExecutionVersion: number;
  prp: { minimumVersion: number; maximumVersion: number };
  catalog: { version: number; sha256: string };
  driver: {
    contractVersion: number;
    descriptor: HarnessDriverDescriptor;
    requiredCapabilities: readonly RequiredHarnessDriverCapability[];
  };
}

export interface PaperclipRunnerEvalCompatibilityReceipt {
  schema: typeof PAPERCLIP_RUNNER_EVAL_INTEGRATION_SCHEMA;
  consumer: string;
  packageVersion: string;
  runnerdPackageVersion: string;
  negotiatedPrpVersion: number;
  catalogSha256: string;
  driverKind: string;
  driverVersion: string;
}

export class PaperclipRunnerEvalCompatibilityError extends Error {
  readonly code = "paperclip_runner_eval_incompatible" as const;

  constructor(
    readonly consumer: string,
    readonly issues: readonly PaperclipRunnerEvalCompatibilityIssue[],
  ) {
    super(
      `Paperclip runner eval compatibility check failed for ${consumer}: ${issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "PaperclipRunnerEvalCompatibilityError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

/**
 * Negotiate the complete App/Evals join before starting a provider process.
 * Every independently versioned input is checked and all mismatches are
 * returned together so remediation is actionable.
 */
export function assertPaperclipRunnerEvalCompatibility(
  requirement: PaperclipRunnerEvalCompatibilityRequirement,
): PaperclipRunnerEvalCompatibilityReceipt {
  const expected = PAPERCLIP_RUNNER_BUILD_METADATA;
  const issues: PaperclipRunnerEvalCompatibilityIssue[] = [];
  const issue = (
    code: PaperclipRunnerEvalCompatibilityIssueCode,
    component: PaperclipRunnerEvalCompatibilityIssue["component"],
    expectedValue: string | number,
    receivedValue: string | number,
    message: string,
  ): void => {
    issues.push({
      code,
      component,
      expected: String(expectedValue),
      received: String(receivedValue),
      message,
    });
  };

  if (requirement.packageVersion !== expected.package.version) {
    issue(
      "package_version_mismatch",
      "package",
      expected.package.version,
      requirement.packageVersion,
      `package ${requirement.packageVersion} does not match the loaded contract package ${expected.package.version}`,
    );
  }
  if (requirement.runnerd.packageVersion !== expected.package.version) {
    issue(
      "binary_package_version_mismatch",
      "binary",
      expected.package.version,
      requirement.runnerd.packageVersion,
      `runnerd was built for package ${requirement.runnerd.packageVersion}, not ${expected.package.version}`,
    );
  }
  if (requirement.runnerd.binaryContractVersion !== expected.contracts.runnerdArtifact) {
    issue(
      "binary_contract_version_mismatch",
      "binary",
      expected.contracts.runnerdArtifact,
      requirement.runnerd.binaryContractVersion,
      "runnerd artifact contract is incompatible with this package",
    );
  }
  if (
    requirement.nativeExecutionVersion !== expected.contracts.nativeExecution
    || requirement.runnerd.nativeExecutionVersion !== expected.contracts.nativeExecution
  ) {
    issue(
      "native_execution_version_mismatch",
      "nativeExecution",
      expected.contracts.nativeExecution,
      `${requirement.nativeExecutionVersion}/${requirement.runnerd.nativeExecutionVersion}`,
      "consumer and runnerd must both emit paperclip-runner/native-execution/v1",
    );
  }

  if (requirement.runnerd.prp.name !== expected.prp.name) {
    issue(
      "prp_name_mismatch",
      "prp",
      expected.prp.name,
      requirement.runnerd.prp.name,
      "runnerd speaks a different protocol family",
    );
  }
  const packageAndConsumerPrp = negotiateProtocolVersion(
    { min: expected.prp.minimumVersion, max: expected.prp.maximumVersion },
    { min: requirement.prp.minimumVersion, max: requirement.prp.maximumVersion },
  );
  const negotiatedPrpVersion = packageAndConsumerPrp === null
    ? null
    : negotiateProtocolVersion(
        { min: packageAndConsumerPrp, max: packageAndConsumerPrp },
        {
          min: requirement.runnerd.prp.minimumVersion,
          max: requirement.runnerd.prp.maximumVersion,
        },
      );
  if (negotiatedPrpVersion === null) {
    issue(
      "prp_version_no_overlap",
      "prp",
      `${expected.prp.minimumVersion}..${expected.prp.maximumVersion}`,
      `consumer ${requirement.prp.minimumVersion}..${requirement.prp.maximumVersion}; runnerd ${requirement.runnerd.prp.minimumVersion}..${requirement.runnerd.prp.maximumVersion}`,
      "package, runnerd, and consumer have no common PRP version",
    );
  }

  if (requirement.catalog.version !== expected.semanticCatalog.version) {
    issue(
      "catalog_version_mismatch",
      "catalog",
      expected.semanticCatalog.version,
      requirement.catalog.version,
      "semantic catalog contract version is incompatible",
    );
  }
  if (requirement.catalog.sha256 !== expected.semanticCatalog.sha256) {
    issue(
      "catalog_digest_mismatch",
      "catalog",
      expected.semanticCatalog.sha256,
      requirement.catalog.sha256,
      "semantic catalog content digest does not match the loaded package",
    );
  }
  if (
    requirement.driver.contractVersion !== expected.contracts.harnessDriver
    || requirement.runnerd.harnessDriverVersion !== expected.contracts.harnessDriver
  ) {
    issue(
      "driver_contract_version_mismatch",
      "driver",
      expected.contracts.harnessDriver,
      `${requirement.driver.contractVersion}/${requirement.runnerd.harnessDriverVersion}`,
      "consumer and runnerd harness-driver contract versions must match the package",
    );
  }
  if (
    negotiatedPrpVersion !== null
    && requirement.driver.descriptor.protocolVersion !== `prp.v${negotiatedPrpVersion}`
  ) {
    issue(
      "driver_protocol_version_mismatch",
      "driver",
      `prp.v${negotiatedPrpVersion}`,
      String(requirement.driver.descriptor.protocolVersion),
      `driver ${requirement.driver.descriptor.kind}@${requirement.driver.descriptor.version} does not speak the negotiated PRP version`,
    );
  }
  for (const capability of [...new Set(requirement.driver.requiredCapabilities)].sort()) {
    if (requirement.driver.descriptor.capabilities[capability] !== true) {
      issue(
        "driver_capability_unsupported",
        "driver",
        `${capability}=true`,
        `${capability}=${String(requirement.driver.descriptor.capabilities[capability])}`,
        `driver ${requirement.driver.descriptor.kind}@${requirement.driver.descriptor.version} does not support required capability ${capability}`,
      );
    }
  }

  if (issues.length > 0) {
    throw new PaperclipRunnerEvalCompatibilityError(requirement.consumer, issues);
  }

  return {
    schema: PAPERCLIP_RUNNER_EVAL_INTEGRATION_SCHEMA,
    consumer: requirement.consumer,
    packageVersion: expected.package.version,
    runnerdPackageVersion: requirement.runnerd.packageVersion,
    negotiatedPrpVersion: negotiatedPrpVersion!,
    catalogSha256: expected.semanticCatalog.sha256,
    driverKind: requirement.driver.descriptor.kind,
    driverVersion: requirement.driver.descriptor.version,
  };
}
