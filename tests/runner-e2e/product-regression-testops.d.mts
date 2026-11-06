export type TestOpsPlanKey = 'product-regression' | 'reliability';

export interface ProductRegressionCase {
  id: number;
  suite: string;
  name: string;
  profile: string;
  model: string;
  fullName: string;
  executionId: string;
  plan: TestOpsPlanKey;
  environment: 'local' | 'daytona';
  signature?: string;
}

export interface ReliabilityRegistration {
  planId: number | null;
  caseIds: Readonly<Record<string, number>>;
}

export const productRegressionCases: readonly ProductRegressionCase[];
export const productReportingModels: readonly string[];
export const productReportingMatcherKinds: readonly string[];
export const testOpsPlanDetails: Readonly<Record<TestOpsPlanKey, { label: string; name: string; size: number }>>;
export function testOpsPlans(reliabilityRegistration?: ReliabilityRegistration):
  Readonly<Record<TestOpsPlanKey, readonly ProductRegressionCase[] | null>>;
export function projectProductResults(campaign: unknown, selection: unknown, sourceSha: string): {
  summary: { selected: number; passed: number; failed: number; broken: number; plan: TestOpsPlanKey; fullPlan: boolean };
  records: Array<{ file: string; value: { model?: string | null; declaredModel?: string; reportedModelSha256?: string | null;
    modelSource?: 'first_task_configuration' | 'execution_profile' | 'not_recorded';
    environment?: string; labels?: Array<{ name: string; value: string }>;
    checks?: Array<{ name: string; ordinal: number; passed: boolean; pathSha256: string | null }> } }>;
};
