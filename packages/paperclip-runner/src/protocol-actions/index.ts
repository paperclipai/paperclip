import { administerCompanyAction } from "./administer-company.js";
import { answerStatusQuestionAction } from "./answer-status-question.js";
import { blockTaskAction } from "./block-task.js";
import { commentOnApprovalAction } from "./comment-on-approval.js";
import { controlWorkspaceServiceAction } from "./control-workspace-service.js";
import { createTaskAction } from "./create-task.js";
import { decideApprovalAction } from "./decide-approval.js";
import { exportCompanyAction } from "./export-company.js";
import { finishTaskAction } from "./finish-task.js";
import { genericApiRequestAction } from "./generic-api-request.js";
import { getAgentAction } from "./get-agent.js";
import { getApprovalAction } from "./get-approval.js";
import { getApprovalContextAction } from "./get-approval-context.js";
import { getTaskContextAction } from "./get-task-context.js";
import { getTaskHistoryAction } from "./get-task-history.js";
import { getWorkspaceRuntimeAction } from "./get-workspace-runtime.js";
import { inspectOperationResultAction } from "./inspect-operation-result.js";
import { listAgentsAction } from "./list-agents.js";
import { listApprovalsAction } from "./list-approvals.js";
import { listCasesAction } from "./list-cases.js";
import { listCompanySkillsAction } from "./list-company-skills.js";
import { listDocumentRevisionsAction } from "./list-document-revisions.js";
import { listDocumentsAction } from "./list-documents.js";
import { listGoalsAction } from "./list-goals.js";
import { listProjectsAction } from "./list-projects.js";
import { listRoutinesAction } from "./list-routines.js";
import { listSecretMetadataAction } from "./list-secret-metadata.js";
import { manageRoutineAction } from "./manage-routine.js";
import { readDocumentAction } from "./read-document.js";
import { readSecretValueAction } from "./read-secret-value.js";
import { registerDeliverableAction } from "./register-deliverable.js";
import { reportProgressAction } from "./report-progress.js";
import { requestApprovalAction } from "./request-approval.js";
import { requestHumanInputAction } from "./request-human-input.js";
import { requestReviewAction } from "./request-review.js";
import { scheduleWakeAction } from "./schedule-wake.js";
import { searchTasksAction } from "./search-tasks.js";
import { setDependenciesAction } from "./set-dependencies.js";
import { syncCompanySkillsAction } from "./sync-company-skills.js";
import { upsertCaseAction } from "./upsert-case.js";
import { writeDocumentAction } from "./write-document.js";
import { deepFreezeProtocolAction } from "./freeze.js";

export const PAPERCLIP_PROTOCOL_ACTIONS = deepFreezeProtocolAction([
  administerCompanyAction,
  answerStatusQuestionAction,
  blockTaskAction,
  commentOnApprovalAction,
  controlWorkspaceServiceAction,
  createTaskAction,
  decideApprovalAction,
  exportCompanyAction,
  finishTaskAction,
  genericApiRequestAction,
  getAgentAction,
  getApprovalAction,
  getApprovalContextAction,
  getTaskContextAction,
  getTaskHistoryAction,
  getWorkspaceRuntimeAction,
  inspectOperationResultAction,
  listAgentsAction,
  listApprovalsAction,
  listCasesAction,
  listCompanySkillsAction,
  listDocumentRevisionsAction,
  listDocumentsAction,
  listGoalsAction,
  listProjectsAction,
  listRoutinesAction,
  listSecretMetadataAction,
  manageRoutineAction,
  readDocumentAction,
  readSecretValueAction,
  registerDeliverableAction,
  reportProgressAction,
  requestApprovalAction,
  requestHumanInputAction,
  requestReviewAction,
  scheduleWakeAction,
  searchTasksAction,
  setDependenciesAction,
  syncCompanySkillsAction,
  upsertCaseAction,
  writeDocumentAction,
] as const);

export function paperclipProtocolAction(operationId: string) {
  return PAPERCLIP_PROTOCOL_ACTIONS.find((action) => action.id === operationId);
}
