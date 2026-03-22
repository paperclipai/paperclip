import type { CompanyStatus } from "../constants.js";

export type TelegramNotificationLevel = "all" | "important" | "critical";

export interface CompanySettings {
  telegram?: {
    chatId?: string;
    forumChatId?: string;
    defaultAssigneeAgentId?: string;
    notificationLevel?: TelegramNotificationLevel;
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
