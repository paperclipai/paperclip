export interface ProductRegressionCase {
  id: number;
  suite: string;
  name: string;
  profile: string;
  fullName: string;
  executionId: string;
}

export const productRegressionCases: readonly ProductRegressionCase[];
export const productReportingModels: readonly string[];
export const productReportingMatcherKinds: readonly string[];
export function projectProductResults(campaign: unknown, selection: unknown, sourceSha: string): {
  summary: { selected: number; passed: number; failed: number; broken: number };
  records: Array<{ file: string; value: { checks?: Array<{ name: string; ordinal: number; passed: boolean; pathSha256: string | null }> } }>;
};
