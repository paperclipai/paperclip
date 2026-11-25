import { commentOnApprovalAction } from "./comment-on-approval.js";
import { createTaskAction } from "./create-task.js";
import { decideApprovalAction } from "./decide-approval.js";
import { getAgentAction } from "./get-agent.js";
import { getApprovalAction } from "./get-approval.js";
import { getApprovalContextAction } from "./get-approval-context.js";
import { listAgentsAction } from "./list-agents.js";
import { listApprovalsAction } from "./list-approvals.js";
import { listGoalsAction } from "./list-goals.js";
import { listProjectsAction } from "./list-projects.js";
import { requestApprovalAction } from "./request-approval.js";
import { searchTasksAction } from "./search-tasks.js";
import { setDependenciesAction } from "./set-dependencies.js";
import { deepFreezeProtocolAction } from "./freeze.js";

/** Optional discovery, delegation, dependency, and governance actions. */
export const PAPERCLIP_COLLABORATION_PROTOCOL_ACTIONS = deepFreezeProtocolAction([
  commentOnApprovalAction,
  createTaskAction,
  decideApprovalAction,
  getAgentAction,
  getApprovalAction,
  getApprovalContextAction,
  listAgentsAction,
  listApprovalsAction,
  listGoalsAction,
  listProjectsAction,
  requestApprovalAction,
  searchTasksAction,
  setDependenciesAction,
] as const);
