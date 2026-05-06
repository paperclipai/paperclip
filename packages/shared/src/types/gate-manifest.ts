import type {
  GateManifestGateStatus,
  GateManifestGateType,
  MissionContractDonePolicy,
} from "../constants.js";

export interface GateManifestGate {
  id: string;
  type: GateManifestGateType;
  title: string;
  ownerAgentId?: string | null;
  ownerAgentName?: string | null;
  issueId?: string | null;
  status: GateManifestGateStatus;
  blockedByGateIds: string[];
  blockedByIssueIds: string[];
  requiredEvidence: string[];
  evidenceRecordIds: string[];
  notes?: string | null;
}

export interface GateManifest {
  version: 1;
  gates: GateManifestGate[];
  donePolicy: MissionContractDonePolicy;
}
