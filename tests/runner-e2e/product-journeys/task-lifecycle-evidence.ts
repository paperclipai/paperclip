import { createIssueLabelSchema } from "../../../packages/shared/src/validators/issue.js";
import { JourneyError } from "./types.js";

export function taskLifecycleLabelName(campaignId: string): string {
  const name = `Journey QA label ${campaignId}`;
  if (!createIssueLabelSchema.shape.name.safeParse(name).success) {
    throw new JourneyError("unsupported", "task_lifecycle_campaign_label_name_invalid");
  }
  return name;
}

export interface LifecycleTask {
  id: string;
  companyId: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  projectId: string | null;
  assigneeUserId: string;
  assigneeAgentId: null;
  createdByUserId: string;
  createdByAgentId: null;
  labelIds: string[];
  completedAt: string | null;
}
export interface LifecycleLabel { id: string; companyId: string; name: string; color: string }
export interface LifecycleObservation {
  task: LifecycleTask | null;
  runCount: number | null;
  titleVisible: boolean;
  descriptionVisible: boolean;
  statusVisible: boolean;
  labelVisible: boolean;
}
export interface LifecycleExpectation {
  taskId: string;
  companyId: string;
  userId: string;
  originalTitle: string;
  revisedTitle: string;
  description: string;
  labelName: string;
}

function ownedTask(task: LifecycleTask | null, expected: LifecycleExpectation) {
  return Boolean(task && task.id === expected.taskId && task.companyId === expected.companyId && task.identifier
    && task.description === expected.description && task.assigneeUserId === expected.userId && task.assigneeAgentId === null
    && task.createdByUserId === expected.userId && task.createdByAgentId === null);
}
function singleton(ids: unknown, id: string) { return Array.isArray(ids) && ids.length === 1 && ids[0] === id; }
function sameUneditedFields(task: LifecycleTask | null, initial: LifecycleTask | null) {
  return Boolean(task && initial && task.identifier === initial.identifier && task.priority === initial.priority && task.projectId === initial.projectId);
}

/** Independent saved states accompany visible UI readback. Empty or missing observations cannot pass. */
export function taskLifecycleEvidence(input: {
  expected: LifecycleExpectation;
  label: LifecycleLabel | null;
  created: LifecycleObservation;
  edited: LifecycleObservation;
  reloaded: LifecycleObservation;
  completed: LifecycleObservation;
  reopened: LifecycleObservation;
}) {
  const { expected, label, created, edited, reloaded, completed, reopened } = input;
  const validExpected = Boolean(expected.taskId && expected.companyId && expected.userId && expected.originalTitle
    && expected.revisedTitle && expected.originalTitle !== expected.revisedTitle && expected.description && expected.labelName);
  const fresh = validExpected && ownedTask(created.task, expected) && created.task!.title === expected.originalTitle
    && ["backlog", "todo"].includes(created.task!.status) && created.task!.completedAt === null
    && ["critical", "high", "medium", "low"].includes(created.task!.priority)
    && (created.task!.projectId === null || typeof created.task!.projectId === "string" && created.task!.projectId.length > 0)
    && Array.isArray(created.task!.labelIds) && created.task!.labelIds.length === 0
    && created.titleVisible && created.descriptionVisible && created.statusVisible;
  const labelValid = Boolean(label && label.id && label.companyId === expected.companyId && label.name === expected.labelName
    && /^#[a-fA-F0-9]{6}$/.test(label.color));
  const saved = (observation: LifecycleObservation, status: string) => fresh && labelValid && ownedTask(observation.task, expected)
    && sameUneditedFields(observation.task, created.task) && observation.task!.title === expected.revisedTitle
    && observation.task!.status === status && singleton(observation.task!.labelIds, label!.id);
  const shown = (observation: LifecycleObservation) => observation.titleVisible && observation.descriptionVisible
    && observation.statusVisible && observation.labelVisible;
  const editedMatches = saved(edited, "in_progress") && shown(edited) && edited.task!.completedAt === null;
  const reloadedMatches = saved(reloaded, "in_progress") && shown(reloaded) && reloaded.task!.completedAt === null;
  const completedMatches = saved(completed, "done") && shown(completed)
    && typeof completed.task!.completedAt === "string" && Number.isFinite(Date.parse(completed.task!.completedAt));
  const reopenedMatches = saved(reopened, "todo") && shown(reopened) && reopened.task!.completedAt === null;
  const observations = [created, edited, reloaded, completed, reopened];
  return {
    created: fresh,
    edited: editedMatches,
    reloaded: reloadedMatches,
    completedAndReopened: completedMatches && reopenedMatches,
    uneditedFieldsPreserved: fresh && observations.every(observation => ownedTask(observation.task, expected)
      && sameUneditedFields(observation.task, created.task)),
    noAgentWork: fresh && observations.every(observation => observation.runCount === 0),
  };
}
