export type ProposalSourceType = "paste" | "txt" | "md" | "docx" | "pdf";
export type OPCBlueprintStatus = "draft" | "approved" | "company_created";
export type OPCProjectMode = "advise" | "take_charge";

export interface ProposalArtifact {
  id: string;
  sourceType: ProposalSourceType;
  filename: string | null;
  mimeType: string | null;
  extractedText: string;
  extractionNotes: string | null;
  createdByUserId: string | null;
  createdCompanyId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OPCBudgetTimeGuesses {
  timelineWeeks: number;
  monthlyBudgetCents: number;
  confidence: "low" | "medium" | "high";
  rationale: string;
}

export interface OPCAgentPlanItem {
  name: string;
  role: string;
  title: string;
  capabilities: string;
}

export interface OPCIssuePlanItem {
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  role: string;
}

export interface OPCRoutinePlanItem {
  title: string;
  description: string;
  cadence: "daily" | "weekly";
  role: string;
}

export interface OPCBlueprint {
  id: string;
  proposalId: string;
  status: OPCBlueprintStatus;
  summary: string;
  targetCustomer: string;
  mvpWedge: string;
  uxNotes: string;
  architectureNotes: string;
  risks: string[];
  assumptions: string[];
  deliverables: string[];
  budgetTimeGuesses: OPCBudgetTimeGuesses;
  launchPlan: string[];
  agentPlan: OPCAgentPlanItem[];
  issuePlan: OPCIssuePlanItem[];
  routinePlan: OPCRoutinePlanItem[];
  approvedAt: Date | null;
  approvedByUserId: string | null;
  createdCompanyId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CoachDecision {
  id: string;
  proposalId: string;
  blueprintId: string | null;
  question: string;
  selectedAnswer: string;
  rationale: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface OPCProposalDetail {
  proposal: ProposalArtifact;
  blueprint: OPCBlueprint | null;
  decisions: CoachDecision[];
}

export interface OPCCoachResponse {
  response: string;
  proposedDecisions: Array<{
    question: string;
    options: string[];
    recommendation: string;
    rationale: string;
  }>;
  blueprint: OPCBlueprint;
  decision?: CoachDecision;
}

export interface OPCCreateCompanyResponse {
  company: {
    id: string;
    name: string;
    issuePrefix: string;
  };
  agents: Array<{ id: string; name: string; role: string; title: string | null }>;
  goals: Array<{ id: string; title: string }>;
  issues: Array<{ id: string; identifier: string | null; title: string }>;
  routines: Array<{ id: string; title: string }>;
}
