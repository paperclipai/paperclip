export interface SubscriptionPlan {
  id: string;
  companyId: string;
  agentId: string | null;
  provider: string;
  biller: string;
  monthlyCostCents: number;
  seatCount: number;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
