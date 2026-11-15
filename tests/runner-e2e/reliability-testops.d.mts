export interface ReliabilityDefinition {
  plan: 'reliability';
  suite: 'everyday-workflows';
  name: string;
  environment: 'local' | 'daytona';
  signature: string;
  profile: string;
  model: string;
  fullName: string;
  executionId: string;
}

export interface ReliabilityRegistration {
  planId: number | null;
  caseIds: Readonly<Record<string, number>>;
}

export const reliabilityPlanKey: 'reliability';
export const reliabilityPlanName: string;
export const reliabilitySuite: 'everyday-workflows';
export const reliabilityProfile: string;
export const reliabilityModel: string;
export const reliabilityDefinitions: readonly ReliabilityDefinition[];
export const reliabilityRegistration: Readonly<ReliabilityRegistration>;
export function registeredReliabilityCases(
  registration?: ReliabilityRegistration,
  reservedCaseIds?: readonly number[],
  reservedPlanIds?: readonly number[],
): ReadonlyArray<ReliabilityDefinition & { id: number }> | null;
