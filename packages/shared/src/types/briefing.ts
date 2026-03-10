import type {
  BriefingCadence,
  BriefingScheduleRunStatus,
  BriefingWindowPreset,
  HealthDelta,
  HealthStatus,
  PricingState,
  RecordScopeType,
} from "../constants.js";
import type { AnyRecord, ExecutiveDecisionItem } from "./record.js";

export interface BriefingSchedule {
  id: string;
  companyId: string;
  recordId: string;
  enabled: boolean;
  cadence: BriefingCadence;
  timezone: string;
  localHour: number;
  localMinute: number;
  dayOfWeek: number | null;
  windowPreset: BriefingWindowPreset;
  autoPublish: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastRunStatus: BriefingScheduleRunStatus;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PortfolioProject {
  projectId: string;
  projectName: string;
  leadAgentId: string | null;
  leadAgentName: string | null;
  budgetBurn: number;
  budgetPricingState: PricingState;
  milestoneStatus: string;
  currentBlocker: string | null;
  lastMeaningfulResult: AnyRecord | null;
  nextBoardDecision: ExecutiveDecisionItem | null;
  confidence: number | null;
  healthStatus: HealthStatus;
  healthDelta: HealthDelta;
}

export interface PortfolioSummary {
  companyId: string;
  scopeType: RecordScopeType;
  scopeRefId: string;
  projects: PortfolioProject[];
}
