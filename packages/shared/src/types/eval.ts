/** Agent evaluation framework types. */

export interface EvalCase {
  id: string;
  name: string;
  description?: string;
  agentId?: string;
  adapterId?: string;
  /** Input: what the agent receives */
  input: {
    issueTitle: string;
    issueBody: string;
    agentRole?: string;
    context?: Record<string, unknown>;
  };
  /** Expected outputs to check against */
  expectations: EvalExpectation[];
  /** Hard constraints for pass/fail */
  constraints?: {
    shouldSucceed: boolean;
    expectedStatus?: string;
    expectedOutputPatterns?: string[];
    forbiddenPatterns?: string[];
    maxDurationMs?: number;
    maxTokens?: number;
    maxCostCents?: number;
  };
  /** Tags for filtering */
  tags?: string[];
  /** Timeout in seconds */
  timeout?: number;
}

export interface EvalExpectation {
  type:
    | "contains"
    | "not_contains"
    | "regex"
    | "status_change"
    | "comment_created"
    | "delegation"
    | "rubric";
  /** For text checks (contains / not_contains / regex) */
  value?: string;
  /** For status_change checks */
  expectedStatus?: string;
  /** For rubric checks (scored by LLM) */
  rubricPrompt?: string;
  rubricMinScore?: number;
}

export interface EvalExpectationResult {
  expectation: EvalExpectation;
  passed: boolean;
  actual?: string;
  score?: number;
  reason?: string;
}

export type EvalResultStatus = "passed" | "failed" | "error" | "skipped";

export interface EvalResult {
  caseId: string;
  caseName: string;
  passed: boolean;
  status: EvalResultStatus;
  /** Duration in ms */
  duration: number;
  tokenCount?: number;
  costCents?: number;
  output?: string;
  expectations: EvalExpectationResult[];
  failedExpectations?: string[];
  error?: string;
}

export interface EvalBundle {
  id: string;
  name: string;
  description?: string;
  cases: EvalCase[];
  companyId?: string;
  createdAt: string;
}

export interface EvalRunSummary {
  bundleId: string;
  bundleName: string;
  totalCases: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  duration: number;
  totalCostCents: number;
  results: EvalResult[];
  runAt: string;
}

export interface EvalSummary {
  bundleId: string;
  totalCases: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  totalDurationMs: number;
  totalCostCents: number;
}
