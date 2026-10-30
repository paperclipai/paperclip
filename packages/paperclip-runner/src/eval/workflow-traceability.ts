import { RUNNER_WORKFLOW_IDS, type RunnerWorkflowId } from "./workflow-contracts.js";

export const STRESS_TRACEABILITY_SCHEMA = "paperclip.runner.stress-eval-traceability.v1" as const;

export interface StressTraceabilityFinding {
  id: string;
  classification: "workflow_eval" | "regression_test" | "explicit_exclusion";
  workflowIds: RunnerWorkflowId[];
  regressionTests: string[];
  reason?: string;
}

export interface StressTraceabilityManifest {
  schema: typeof STRESS_TRACEABILITY_SCHEMA;
  campaign: string;
  expectedFindings: 44;
  workflows: RunnerWorkflowId[];
  findings: StressTraceabilityFinding[];
}

export interface StressTraceabilitySummary {
  findings: number;
  workflowEvalFindings: number;
  regressionTestFindings: number;
  exclusions: number;
  coveredWorkflows: number;
}

export function validateStressTraceabilityManifest(manifest: StressTraceabilityManifest): StressTraceabilitySummary {
  if (manifest.schema !== STRESS_TRACEABILITY_SCHEMA || manifest.expectedFindings !== 44) {
    throw new Error("unsupported stress traceability manifest");
  }
  const expectedIds = Array.from({ length: 44 }, (_, index) => `STRESS-${String(index + 1).padStart(3, "0")}`);
  const actualIds = manifest.findings.map((finding) => finding.id);
  if (actualIds.length !== expectedIds.length || new Set(actualIds).size !== expectedIds.length) {
    throw new Error("stress traceability must contain 44 unique findings");
  }
  for (const id of expectedIds) {
    if (!actualIds.includes(id)) throw new Error(`stress traceability is missing ${id}`);
  }
  if (manifest.workflows.length !== RUNNER_WORKFLOW_IDS.length
    || !RUNNER_WORKFLOW_IDS.every((id) => manifest.workflows.includes(id))) {
    throw new Error("stress traceability workflow inventory does not match the Runner workflow catalog");
  }
  for (const finding of manifest.findings) {
    for (const workflowId of finding.workflowIds) {
      if (!(RUNNER_WORKFLOW_IDS as readonly string[]).includes(workflowId)) {
        throw new Error(`${finding.id} references unknown workflow ${workflowId}`);
      }
    }
    if (finding.classification === "workflow_eval" && finding.workflowIds.length === 0) {
      throw new Error(`${finding.id} is a workflow eval without a workflow`);
    }
    if (finding.classification !== "explicit_exclusion" && finding.regressionTests.length === 0) {
      throw new Error(`${finding.id} is missing a regression test anchor`);
    }
    if (finding.regressionTests.some((path) => !/\.test\.[cm]?[jt]sx?$/.test(path))) {
      throw new Error(`${finding.id} references a non-test regression anchor`);
    }
    if (finding.classification === "regression_test" && finding.regressionTests.length === 0) {
      throw new Error(`${finding.id} is a regression finding without a test`);
    }
    if (finding.classification === "explicit_exclusion" && !finding.reason) {
      throw new Error(`${finding.id} exclusion is missing a reason`);
    }
  }
  return {
    findings: manifest.findings.length,
    workflowEvalFindings: manifest.findings.filter((finding) => finding.classification === "workflow_eval").length,
    regressionTestFindings: manifest.findings.filter((finding) => finding.classification === "regression_test").length,
    exclusions: manifest.findings.filter((finding) => finding.classification === "explicit_exclusion").length,
    coveredWorkflows: new Set(manifest.findings.flatMap((finding) => finding.workflowIds)).size,
  };
}
