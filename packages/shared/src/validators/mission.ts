import { z } from "zod";
import {
  MISSION_CONTRACT_BOARD_DECISION_STATUSES,
  MISSION_CONTRACT_DOCUMENT_KEY,
  MISSION_CONTRACT_DONE_POLICIES,
  MISSION_CONTRACT_REQUIRED_GATES,
} from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const missionContractGateSchema = z.enum(MISSION_CONTRACT_REQUIRED_GATES);
export const missionContractDonePolicySchema = z.enum(MISSION_CONTRACT_DONE_POLICIES);
export const missionContractBoardDecisionStatusSchema = z.enum(MISSION_CONTRACT_BOARD_DECISION_STATUSES);

export const missionContractBoardDecisionOptionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
}).strict();

export const missionContractBoardDecisionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(500),
  options: z.array(missionContractBoardDecisionOptionSchema).min(2).max(4),
  recommendedOptionId: z.string().trim().min(1).max(80).optional(),
  selectedOptionId: z.string().trim().min(1).max(80).optional(),
  status: missionContractBoardDecisionStatusSchema.default("pending"),
  rationale: z.string().trim().max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  const optionIds = new Set<string>();
  for (const [index, option] of value.options.entries()) {
    if (optionIds.has(option.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Board decision option ids must be unique",
        path: ["options", index, "id"],
      });
    }
    optionIds.add(option.id);
  }

  if (value.recommendedOptionId && !optionIds.has(value.recommendedOptionId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "recommendedOptionId must reference one of the options",
      path: ["recommendedOptionId"],
    });
  }
  if (value.selectedOptionId && !optionIds.has(value.selectedOptionId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "selectedOptionId must reference one of the options",
      path: ["selectedOptionId"],
    });
  }
});

export const missionContractSchema = z.object({
  version: z.literal(1),
  request: multilineTextSchema.pipe(z.string().trim().min(1).max(20000)),
  scope: z.array(z.string().trim().min(1).max(240)).min(1).max(50),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(50),
  requiredGates: z.array(missionContractGateSchema).min(1).max(MISSION_CONTRACT_REQUIRED_GATES.length),
  boardDecisions: z.array(missionContractBoardDecisionSchema).max(20).default([]),
  donePolicy: missionContractDonePolicySchema.default("all_required_gates_passed"),
}).strict().superRefine((value, ctx) => {
  const gates = new Set<string>();
  for (const [index, gate] of value.requiredGates.entries()) {
    if (gates.has(gate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "requiredGates must be unique",
        path: ["requiredGates", index],
      });
    }
    gates.add(gate);
  }
});

export type MissionContractGate = z.infer<typeof missionContractGateSchema>;
export type MissionContractDonePolicy = z.infer<typeof missionContractDonePolicySchema>;
export type MissionContractBoardDecisionStatus = z.infer<typeof missionContractBoardDecisionStatusSchema>;
export type MissionContractBoardDecisionOption = z.infer<typeof missionContractBoardDecisionOptionSchema>;
export type MissionContractBoardDecision = z.infer<typeof missionContractBoardDecisionSchema>;
export type MissionContract = z.infer<typeof missionContractSchema>;

export interface MissionContractIssueDocument {
  key: typeof MISSION_CONTRACT_DOCUMENT_KEY;
  title: "Mission Contract";
  format: "markdown";
  body: string;
  changeSummary: string;
}

export function formatMissionContractDocumentBody(contract: unknown): string {
  const parsed = missionContractSchema.parse(contract);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function parseMissionContractDocumentBody(body: string): MissionContract {
  return missionContractSchema.parse(JSON.parse(body));
}

export function buildMissionContractIssueDocument(contract: unknown): MissionContractIssueDocument {
  return {
    key: MISSION_CONTRACT_DOCUMENT_KEY,
    title: "Mission Contract",
    format: "markdown",
    body: formatMissionContractDocumentBody(contract),
    changeSummary: "Update mission contract",
  };
}
