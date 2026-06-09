import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { IssueWorkMode } from "@paperclipai/shared";

interface NewIssueDefaults {
  status?: string;
  workMode?: IssueWorkMode;
  priority?: string;
  projectId?: string;
  projectWorkspaceId?: string;
  goalId?: string;
  parentId?: string;
  parentIdentifier?: string;
  parentTitle?: string;
  executionWorkspaceId?: string;
  executionWorkspaceMode?: string;
  parentExecutionWorkspaceLabel?: string;
  assigneeAgentId?: string;
  assigneeUserId?: string;
  title?: string;
  description?: string;
}

interface NewGoalDefaults {
  parentId?: string;
}

interface OnboardingOptions {
  initialStep?: 1 | 2 | 3 | 4;
  companyId?: string;
}

interface DialogContextValue {
  newIssueOpen: boolean;
  newIssueDefaults: NewIssueDefaults;
  openNewIssue: (defaults?: NewIssueDefaults) => void;
  closeNewIssue: () => void;
  newProjectOpen: boolean;
  openNewProject: () => void;
  closeNewProject: () => void;
  newGoalOpen: boolean;
  newGoalDefaults: NewGoalDefaults;
  openNewGoal: (defaults?: NewGoalDefaults) => void;
  closeNewGoal: () => void;
  newAgentOpen: boolean;
  openNewAgent: () => void;
  closeNewAgent: () => void;
  onboardingOpen: boolean;
  onboardingOptions: OnboardingOptions;
  openOnboarding: (options?: OnboardingOptions) => void;
  closeOnboarding: () => void;
}

type DialogStateValue = Pick<
  DialogContextValue,
  | "newIssueOpen"
  | "newIssueDefaults"
  | "newProjectOpen"
  | "newGoalOpen"
  | "newGoalDefaults"
  | "newAgentOpen"
  | "onboardingOpen"
  | "onboardingOptions"
>;

type DialogActionsValue = Omit<DialogContextValue, keyof DialogStateValue>;

const DialogStateContext = createContext<DialogStateValue | null>(null);
const DialogActionsContext = createContext<DialogActionsValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newIssueDefaults, setNewIssueDefaults] = useState<NewIssueDefaults>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  const [newGoalDefaults, setNewGoalDefaults] = useState<NewGoalDefaults>({});
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingOptions, setOnboardingOptions] = useState<OnboardingOptions>({});

  const openNewIssue = useCallback((defaults: NewIssueDefaults = {}) => {
    setNewIssueDefaults(defaults);
    setNewIssueOpen(true);
  }, []);

  const closeNewIssue = useCallback(() => {
    setNewIssueOpen(false);
    setNewIssueDefaults({});
  }, []);

  const openNewProject = useCallback(() => {
    setNewProjectOpen(true);
  }, []);

  const closeNewProject = useCallback(() => {
    setNewProjectOpen(false);
  }, []);

  const openNewGoal = useCallback((defaults: NewGoalDefaults = {}) => {
    setNewGoalDefaults(defaults);
    setNewGoalOpen(true);
  }, []);

  const closeNewGoal = useCallback(() => {
    setNewGoalOpen(false);
    setNewGoalDefaults({});
  }, []);

  const openNewAgent = useCallback(() => {
    setNewAgentOpen(true);
  }, []);

  const closeNewAgent = useCallback(() => {
    setNewAgentOpen(false);
  }, []);

  const openOnboarding = useCallback((options: OnboardingOptions = {}) => {
    setOnboardingOptions(options);
    setOnboardingOpen(true);
  }, []);

  const closeOnboarding = useCallback(() => {
    setOnboardingOpen(false);
    setOnboardingOptions({});
  }, []);

  const stateValue = useMemo<DialogStateValue>(
    () => ({
      newIssueOpen,
      newIssueDefaults,
      newProjectOpen,
      newGoalOpen,
      newGoalDefaults,
      newAgentOpen,
      onboardingOpen,
      onboardingOptions,
    }),
    [
      newIssueOpen,
      newIssueDefaults,
      newProjectOpen,
      newGoalOpen,
      newGoalDefaults,
      newAgentOpen,
      onboardingOpen,
      onboardingOptions,
    ],
  );

  const actionsValue = useMemo<DialogActionsValue>(
    () => ({
      openNewIssue,
      closeNewIssue,
      openNewProject,
      closeNewProject,
      openNewGoal,
      closeNewGoal,
      openNewAgent,
      closeNewAgent,
      openOnboarding,
      closeOnboarding,
    }),
    [
      openNewIssue,
      closeNewIssue,
      openNewProject,
      closeNewProject,
      openNewGoal,
      closeNewGoal,
      openNewAgent,
      closeNewAgent,
      openOnboarding,
      closeOnboarding,
    ],
  );

  return (
    <DialogActionsContext.Provider value={actionsValue}>
      <DialogStateContext.Provider value={stateValue}>
        {children}
      </DialogStateContext.Provider>
    </DialogActionsContext.Provider>
  );
}

export function useDialogActions() {
  const ctx = useContext(DialogActionsContext);
  if (!ctx) {
    throw new Error("useDialogActions must be used within DialogProvider");
  }
  return ctx;
}

export function useDialogState() {
  const ctx = useContext(DialogStateContext);
  if (!ctx) {
    throw new Error("useDialogState must be used within DialogProvider");
  }
  return ctx;
}

export function useDialog() {
  return {
    ...useDialogState(),
    ...useDialogActions(),
  };
}
