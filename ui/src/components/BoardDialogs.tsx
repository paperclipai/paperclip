import { useTranslation } from "@/i18n";
import { lazy } from "react";
import { useDialogActions, useDialogState } from "../context/DialogContext";
import { DeferredOverlay } from "./DeferredOverlay";
import { NewIssueDialog } from "./NewIssueDialog";

const NewProjectDialog = lazy(() => import("./NewProjectDialog").then((module) => ({ default: module.NewProjectDialog })));
const NewGoalDialog = lazy(() => import("./NewGoalDialog").then((module) => ({ default: module.NewGoalDialog })));
const NewAgentDialog = lazy(() => import("./NewAgentDialog").then((module) => ({ default: module.NewAgentDialog })));

export function BoardDialogs() {
  const { t } = useTranslation();
  const { newIssueOpen, newProjectOpen, newGoalOpen, newAgentOpen } = useDialogState();
  const { closeNewIssue, closeNewProject, closeNewGoal, closeNewAgent } = useDialogActions();
  return <>
    <DeferredOverlay requested={newIssueOpen} title={t("issues.BoardDialogs.newTask")} onClose={closeNewIssue}><NewIssueDialog /></DeferredOverlay>
    <DeferredOverlay requested={newProjectOpen} title={t("issues.BoardDialogs.newProject")} onClose={closeNewProject}><NewProjectDialog /></DeferredOverlay>
    <DeferredOverlay requested={newGoalOpen} title={t("issues.BoardDialogs.newGoal")} onClose={closeNewGoal}><NewGoalDialog /></DeferredOverlay>
    <DeferredOverlay requested={newAgentOpen} title={t("issues.BoardDialogs.newAgent")} onClose={closeNewAgent}><NewAgentDialog /></DeferredOverlay>
  </>;
}
