import { t, useTranslation } from "@/i18n";
import { lazy } from "react";
import { useDialogActions, useDialogState } from "../context/DialogContext";
import { DeferredOverlay } from "./DeferredOverlay";
import { NewIssueDialog } from "./NewIssueDialog";

const NewProjectDialog = lazy(() => import("./NewProjectDialog").then((module) => ({ default: module.NewProjectDialog })));
const NewGoalDialog = lazy(() => import("./NewGoalDialog").then((module) => ({ default: module.NewGoalDialog })));
const NewAgentDialog = lazy(() => import("./NewAgentDialog").then((module) => ({ default: module.NewAgentDialog })));

export function BoardDialogs() {
  useTranslation("task-components");
  const { newIssueOpen, newProjectOpen, newGoalOpen, newAgentOpen } = useDialogState();
  const { closeNewIssue, closeNewProject, closeNewGoal, closeNewAgent } = useDialogActions();
  return <>
    <DeferredOverlay requested={newIssueOpen} title={t("task-components:newTask_3e992276")} onClose={closeNewIssue}><NewIssueDialog /></DeferredOverlay>
    <DeferredOverlay requested={newProjectOpen} title={t("task-components:newProject_a41eb2bf")} onClose={closeNewProject}><NewProjectDialog /></DeferredOverlay>
    <DeferredOverlay requested={newGoalOpen} title={t("task-components:newGoal_f326ad6e")} onClose={closeNewGoal}><NewGoalDialog /></DeferredOverlay>
    <DeferredOverlay requested={newAgentOpen} title={t("task-components:newAgent_98a23e6d")} onClose={closeNewAgent}><NewAgentDialog /></DeferredOverlay>
  </>;
}
