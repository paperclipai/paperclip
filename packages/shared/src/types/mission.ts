import type {
  MissionContractBoardDecisionStatus,
  MissionContractDonePolicy,
  MissionContractRequiredGate,
} from "../constants.js";

export interface MissionContractBoardDecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface MissionContractBoardDecision {
  id: string;
  prompt: string;
  options: MissionContractBoardDecisionOption[];
  recommendedOptionId?: string;
  selectedOptionId?: string;
  status: MissionContractBoardDecisionStatus;
  rationale?: string;
}

export interface MissionContract {
  version: 1;
  request: string;
  scope: string[];
  acceptanceCriteria: string[];
  requiredGates: MissionContractRequiredGate[];
  boardDecisions: MissionContractBoardDecision[];
  donePolicy: MissionContractDonePolicy;
}
