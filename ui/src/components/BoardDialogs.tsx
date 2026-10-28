import { lazy } from "react";
import { useDialogActions, useDialogState } from "../context/DialogContext";
import { DeferredOverlay } from "./DeferredOverlay";
import { NewIssueDialog } from "./NewIssueDialog";

const NewProjectDialog = lazy(() => import("./NewProjectDialog").then((module) => ({ default: module.NewProjectDialog })));
const NewGoalDialog = lazy(() => import("./NewGoalDialog").then((module) => ({ default: module.NewGoalDialog })));
const NewAgentDialog = lazy(() => import("./NewAgentDialog").then((module) => ({ default: module.NewAgentDialog })));

export function BoardDialogs() {
  const { newIssueOpen, newProjectOpen, newGoalOpen, newAgentOpen } = useDialogState();
  const { closeNewIssue, closeNewProject, closeNewGoal, closeNewAgent } = useDialogActions();
  return <>
    <DeferredOverlay requested={newIssueOpen} title="New task" onClose={closeNewIssue}><NewIssueDialog /></DeferredOverlay>
    <DeferredOverlay requested={newProjectOpen} title="New project" onClose={closeNewProject}><NewProjectDialog /></DeferredOverlay>
    <DeferredOverlay requested={newGoalOpen} title="New goal" onClose={closeNewGoal}><NewGoalDialog /></DeferredOverlay>
    <DeferredOverlay requested={newAgentOpen} title="New agent" onClose={closeNewAgent}><NewAgentDialog /></DeferredOverlay>
  </>;
}
