import type { CompanyStatus } from "../constants.js";

export interface CompanySettings {
  telegram?: {
    chatId?: string;
  };
}

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  requireBoardApprovalForNewAgents: boolean;
  brandColor: string | null;
  settings: CompanySettings;
  createdAt: Date;
  updatedAt: Date;
}
