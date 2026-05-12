import {
  WORKSPACE_ROOT_PLAN_LINK_ERROR,
  containsWorkspaceRootPlanLinks,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export function assertNoWorkspaceRootPlanLinks(value: string | null | undefined) {
  if (containsWorkspaceRootPlanLinks(value)) {
    throw unprocessable(WORKSPACE_ROOT_PLAN_LINK_ERROR);
  }
}
