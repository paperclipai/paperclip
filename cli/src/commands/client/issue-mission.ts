import {
  buildMissionContractIssueDocument,
  type MissionContractIssueDocument,
} from "@paperclipai/shared";

export interface MissionContractCliOptions {
  request: string;
  scope?: string[];
  acceptance?: string[];
  gates?: string;
}

const DEFAULT_MISSION_GATES = "implementation,review,qa,release,production_smoke";

export function collectRepeatableOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function buildMissionContractDocumentFromOptions(
  options: MissionContractCliOptions,
): MissionContractIssueDocument {
  return buildMissionContractIssueDocument({
    version: 1,
    request: options.request,
    scope: normalizeRepeatedValues(options.scope),
    acceptanceCriteria: normalizeRepeatedValues(options.acceptance),
    requiredGates: parseGateCsv(options.gates ?? DEFAULT_MISSION_GATES),
    boardDecisions: [],
  });
}

function normalizeRepeatedValues(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseGateCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
