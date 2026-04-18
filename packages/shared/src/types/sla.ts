import type { IssuePriority } from "../constants.js";

export type SlaStatus = "ok" | "approaching" | "breached";

export interface SlaPolicyRule {
  id: string;
  policyId: string;
  priority: IssuePriority;
  targetHours: number;
  warningHours: number | null;
  createdAt: Date;
}

export interface SlaPolicy {
  id: string;
  companyId: string;
  name: string;
  isDefault: boolean;
  status: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
}

export interface SlaPolicyWithRules extends SlaPolicy {
  rules: SlaPolicyRule[];
}

export interface IssueSlaInfo {
  status: SlaStatus;
  dueDate: Date | null;
  slaAutoSet: boolean;
  hoursRemaining: number | null;
  hoursOverdue: number | null;
}
