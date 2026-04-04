export interface Workflow {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  description: string | null;
  definitionYaml: string;
  definitionCompiled: Record<string, unknown> | null;
  assigneeAgentId: string | null;
  status: string;
  version: number;
  metadata: Record<string, unknown> | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRevision {
  id: string;
  workflowId: string;
  version: number;
  definitionYaml: string;
  definitionCompiled: Record<string, unknown> | null;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface WorkflowAgentAssignment {
  id: string;
  companyId: string;
  workflowId: string;
  agentId: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface WorkflowRun {
  id: string;
  companyId: string;
  workflowId: string;
  workflowVersion: number;
  agentId: string;
  status: string;
  currentStepKey: string | null;
  stepIndex: number;
  resultJson: Record<string, unknown> | null;
  error: string | null;
  linkedIssueId: string | null;
  parentRunId: string | null;
  parentStepKey: string | null;
  stateJson: Record<string, unknown> | null;
  triggerSource: string;
  triggeredAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRunStep {
  id: string;
  runId: string;
  stepKey: string;
  stepIndex: number;
  status: string;
  inputJson: Record<string, unknown> | null;
  submissionJson: Record<string, unknown> | null;
  validationResult: Record<string, unknown> | null;
  heartbeatRunId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowStepDef {
  key: string;
  name: string;
  description?: string;
  type: string;
  validationSchema?: Record<string, unknown>;
  childWorkflowId?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface WorkflowGraph {
  steps: WorkflowStepDef[];
  edges: WorkflowEdge[];
  entryStepKey: string;
}

export interface WorkflowAgentSummary {
  id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
}

export interface WorkflowRunSummary {
  id: string;
  status: string;
  currentStepKey: string | null;
  stepIndex: number;
  agentId: string;
  triggerSource: string;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface WorkflowDetail extends Workflow {
  assignments: WorkflowAgentSummary[];
  recentRuns: WorkflowRunSummary[];
  compiledGraph: WorkflowGraph | null;
}

export interface WorkflowListItem extends Workflow {
  assignmentCount: number;
  lastRun: WorkflowRunSummary | null;
  activeRunCount: number;
}

export interface WorkflowMermaidOutput {
  mermaid: string;
  title: string;
}
