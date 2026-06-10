export interface GateResult {
  gateId: string;
  passed: boolean;
  reason: string;
}

export interface MergeGateResult {
  canMerge: boolean;
  gates: GateResult[];
}
