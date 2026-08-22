import type {
  CompanyStatus,
  IssueThreadInteractionKind,
  IssueThreadInteractionResolverPolicy,
  PauseReason,
} from "../constants.js";
import type {
  CompanyActivityWindow,
  CompanyActivityWindowState,
  CompanyRunPauseState,
} from "./company-activity-window.js";

export interface InteractionResolverKindGovernance {
  defaultPolicy?: IssueThreadInteractionResolverPolicy;
  cap?: IssueThreadInteractionResolverPolicy;
}

export type InteractionResolverGovernance = Partial<
  Record<IssueThreadInteractionKind, InteractionResolverKindGovernance>
>;

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  strandedRecoveryOwnerAgentId: string | null;
  activityWindow: CompanyActivityWindow | null;
  activityWindowState: CompanyActivityWindowState | null;
  runPause: CompanyRunPauseState;
  routineGuardConfig: { minimumScheduleIntervalMinutes?: number };
  /** True when the company may start runs right now (window open or no window, and not paused). */
  activeNow: boolean;
  /** True when company runs are explicitly paused (run pause control). */
  paused: boolean;
  attachmentMaxBytes: number;
  defaultResponsibleUserId: string | null;
  requireBoardApprovalForNewAgents: boolean;
  interactionResolverGovernance: InteractionResolverGovernance;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  workProductsRoot: string | null;
  brandColor: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
