export interface ProductRegressionCase {
  id: number;
  suite: string;
  name: string;
  profile: string;
  fullName: string;
  executionId: string;
}

export const productRegressionCases: readonly ProductRegressionCase[];
