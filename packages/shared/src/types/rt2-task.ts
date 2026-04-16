export type Rt2TaskMode = "solo" | "collab";

export type Rt2ParticipantState = "active" | "ended";

export type Rt2ParticipantEndReason = "manager_removed" | "self_left" | "capacity_reduced";

export type Rt2DeliverableKind = "document" | "artifact";

export type Rt2DeliverableState = "defined" | "submitted";

export interface Rt2DeliverableInput {
  title: string;
  type: Rt2DeliverableKind;
  summary?: string | null;
}

export interface Rt2TaskParticipant {
  id: string;
  taskIssueId: string;
  userId: string;
  state: Rt2ParticipantState;
  endedReason: Rt2ParticipantEndReason | null;
  joinedAt: Date;
  endedAt: Date | null;
}

export interface Rt2TodoSummary {
  issueId: string;
  parentTaskIssueId: string;
  title: string;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  assigneeUserId: string | null;
  deliverableCount: number;
  submittedDeliverableCount: number;
}

export interface Rt2DeliverableSummary {
  workProductId: string;
  issueId: string;
  title: string;
  type: Rt2DeliverableKind;
  state: Rt2DeliverableState;
  summary: string | null;
  isRequired: boolean;
}

export interface Rt2TaskSummary {
  issueId: string;
  projectId: string;
  goalId: string | null;
  title: string;
  description: string | null;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  taskMode: Rt2TaskMode;
  capacity: number;
  activeParticipantCount: number;
  deliverableCount: number;
  todoCount: number;
  todoInProgressCount: number;
}

export interface Rt2TaskDetail extends Rt2TaskSummary {
  participants: Rt2TaskParticipant[];
  deliverables: Rt2DeliverableSummary[];
  todos: Rt2TodoSummary[];
}
