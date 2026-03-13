export interface Memory {
  id: string;
  companyId: string;
  scopeType: string;
  scopeId: string | null;
  category: string;
  content: string;
  confidence: number;
  sourceAgentId: string | null;
  sourceRunId: string | null;
  createdAt: Date;
}
