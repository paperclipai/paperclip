import type {
  CreateRt2Task,
  CreateRt2Todo,
  EndRt2Participant,
  Issue,
  UpdateRt2TaskCapacity,
} from "@paperclipai/shared";
import { api } from "./client";

export type Rt2TaskParticipant = {
  id: string;
  taskIssueId: string;
  userId: string;
  state: "active" | "ended";
  endedReason: EndRt2Participant["reason"] | null;
  joinedAt: Date;
  endedAt: Date | null;
};

export type Rt2TaskSummary = {
  issueId: string;
  projectId: string;
  goalId: string | null;
  title: string;
  description: string | null;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  taskMode: "solo" | "collab";
  capacity: number;
  activeParticipantCount: number;
  deliverableCount: number;
  todoCount: number;
  todoInProgressCount: number;
};

export type Rt2DeliverableSummary = {
  workProductId: string;
  issueId: string;
  title: string;
  type: "document" | "artifact";
  state: "defined" | "submitted";
  summary: string | null;
  isRequired: boolean;
};

export type Rt2TodoSummary = {
  issueId: string;
  parentTaskIssueId: string;
  title: string;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  assigneeUserId: string | null;
  deliverableCount: number;
  submittedDeliverableCount: number;
};

export type Rt2TaskDetail = Rt2TaskSummary & {
  participants: Rt2TaskParticipant[];
  deliverables: Rt2DeliverableSummary[];
  todos: Rt2TodoSummary[];
};

type Rt2TaskCapacityResponse = {
  issueId: string;
  companyId: string;
  projectId: string;
  capacity: number;
};

type Rt2EndParticipantResponse = {
  issueId: string;
  companyId: string;
  projectId: string;
  userId: string;
  reason: EndRt2Participant["reason"];
};

export const rt2TasksApi = {
  listByProject: (companyId: string, projectId: string) =>
    api.get<Rt2TaskSummary[]>(`/companies/${companyId}/rt2/tasks?projectId=${encodeURIComponent(projectId)}`),
  get: (taskIssueId: string) =>
    api.get<Rt2TaskDetail>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}`),
  create: (companyId: string, data: CreateRt2Task) =>
    api.post<{ issueId: string }>(`/companies/${companyId}/rt2/tasks`, data),
  join: (taskIssueId: string) =>
    api.post<Rt2TaskParticipant>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}/join`, {}),
  updateCapacity: (taskIssueId: string, data: UpdateRt2TaskCapacity) =>
    api.patch<Rt2TaskCapacityResponse>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}/capacity`, data),
  createTodo: (taskIssueId: string, data: CreateRt2Todo) =>
    api.post<Issue>(`/rt2/tasks/${encodeURIComponent(taskIssueId)}/todos`, data),
  startTodo: (todoIssueId: string) =>
    api.post<Issue>(`/rt2/todos/${encodeURIComponent(todoIssueId)}/start`, {}),
  endParticipant: (taskIssueId: string, userId: string, reason: EndRt2Participant["reason"]) =>
    api.post<Rt2EndParticipantResponse>(
      `/rt2/tasks/${encodeURIComponent(taskIssueId)}/participants/${encodeURIComponent(userId)}/end`,
      { reason },
    ),
};
