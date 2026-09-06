import { answerStatusQuestionAction } from "./answer-status-question.js";
import { blockTaskAction } from "./block-task.js";
import { finishTaskAction } from "./finish-task.js";
import { getTaskContextAction } from "./get-task-context.js";
import { getTaskHistoryAction } from "./get-task-history.js";
import { inspectOperationResultAction } from "./inspect-operation-result.js";
import { listDocumentRevisionsAction } from "./list-document-revisions.js";
import { listDocumentsAction } from "./list-documents.js";
import { readDocumentAction } from "./read-document.js";
import { registerDeliverableAction } from "./register-deliverable.js";
import { reportProgressAction } from "./report-progress.js";
import { requestHumanInputAction } from "./request-human-input.js";
import { requestReviewAction } from "./request-review.js";
import { writeDocumentAction } from "./write-document.js";
import { deepFreezeProtocolAction } from "./freeze.js";

/** Core actions that are always present in an authorized runner projection. */
export const PAPERCLIP_CORE_PROTOCOL_ACTIONS = deepFreezeProtocolAction([
  answerStatusQuestionAction,
  blockTaskAction,
  finishTaskAction,
  getTaskContextAction,
  getTaskHistoryAction,
  inspectOperationResultAction,
  listDocumentRevisionsAction,
  listDocumentsAction,
  readDocumentAction,
  registerDeliverableAction,
  reportProgressAction,
  requestHumanInputAction,
  requestReviewAction,
  writeDocumentAction,
] as const);
