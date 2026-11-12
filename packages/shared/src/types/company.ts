import type {
  CompanyStatus,
  IssueThreadInteractionKind,
  IssueThreadInteractionResolverPolicy,
  PauseReason,
} from "../constants.js";

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
  defaultResponsibleUserId: string | null;
  /**
   * PAP-749 task 1d-lite: the company's default decision owner. When set,
   * ownerless attention cards route to this user's "For you" list; when null
   * they stay in the claimable Unassigned pool. Placement only — it never
   * grants authority, which the resolver policy still gates. Distinct from
   * {@link defaultResponsibleUserId}, which is attribution and is never used
   * to route cards.
   */
  defaultDecisionOwnerUserId: string | null;
  /**
   * PAP-749 task 1d: the budget owner. A budget hard stop also goes to this
   * user's "For you" list, with Raise limit / Keep paused, while the Company
   * view still shows it. `null` leaves the hard stop in Company only.
   * Placement only, like {@link defaultDecisionOwnerUserId}.
   */
  budgetOwnerUserId: string | null;
  requireBoardApprovalForNewAgents: boolean;
  interactionResolverGovernance: InteractionResolverGovernance;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
