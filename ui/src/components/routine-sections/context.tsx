import { createContext, useContext } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  CompanySecret,
  RoutineDetail as RoutineDetailType,
  RoutineEnvConfig,
  RoutineVariable,
} from "@paperclipai/shared";
import type { MarkdownEditorRef, MentionOption } from "../MarkdownEditor";
import type { InlineEntityOption } from "../InlineEntitySelector";
import type { RoutineHistoryDirtyFieldDescriptor } from "../RoutineHistoryTab";
import type { RoutineRunDialogSubmitData } from "../RoutineRunVariablesDialog";
import type {
  RoutineTriggerResponse,
  RotateRoutineTriggerResponse,
} from "../../api/routines";
import type { agentsApi } from "../../api/agents";
import type { projectsApi } from "../../api/projects";
import type { secretsApi } from "../../api/secrets";

export const ROUTINE_SECTION_KEYS = [
  "overview",
  "triggers",
  "variables",
  "secrets",
  "delivery",
  "runs",
  "activity",
  "history",
] as const;

export type RoutineSectionKey = (typeof ROUTINE_SECTION_KEYS)[number];

/** Editable sections own a save bar; read-only (operate) sections do not. */
export const EDITABLE_SECTIONS: RoutineSectionKey[] = [
  "overview",
  "triggers",
  "variables",
  "secrets",
  "delivery",
];

/** Which dirty-field keys belong to which section (for scoped save state). */
export const SECTION_FIELD_KEYS: Record<string, string[]> = {
  overview: ["title", "description", "projectId", "assigneeAgentId", "priority"],
  variables: ["variables"],
  secrets: ["env"],
  delivery: ["concurrencyPolicy", "catchUpPolicy"],
};

export type RoutineEditDraft = {
  title: string;
  description: string;
  projectId: string;
  assigneeAgentId: string;
  priority: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  variables: RoutineVariable[];
  env: RoutineEnvConfig | null;
};

export type NewTriggerDraft = {
  kind: string;
  cronExpression: string;
  signingMode: string;
  replayWindowSec: string;
};

export function createDefaultNewTrigger(): NewTriggerDraft {
  return {
    kind: "schedule",
    cronExpression: "0 10 * * *",
    signingMode: "bearer",
    replayWindowSec: "300",
  };
}

export type SecretMessage = {
  title: string;
  entries: Array<{ webhookUrl: string; webhookSecret: string }>;
};

type AgentList = Awaited<ReturnType<typeof agentsApi.list>>;
type ProjectList = Awaited<ReturnType<typeof projectsApi.list>>;
type SecretList = Awaited<ReturnType<typeof secretsApi.list>>;
type RoutineRunList = Awaited<ReturnType<typeof import("../../api/routines").routinesApi.listRuns>>;
type RoutineActivityList = Awaited<
  ReturnType<typeof import("../../api/routines").routinesApi.activity>
>;

export type RoutineDetailContextValue = {
  routine: RoutineDetailType;
  routineId: string;
  companyId: string;

  // edit state
  editDraft: RoutineEditDraft;
  setEditDraft: React.Dispatch<React.SetStateAction<RoutineEditDraft>>;
  routineDefaults: RoutineEditDraft;
  dirtyFields: RoutineHistoryDirtyFieldDescriptor[];
  isEditDirty: boolean;
  sectionDirtyFields: (section: RoutineSectionKey) => RoutineHistoryDirtyFieldDescriptor[];
  isSectionDirty: (section: RoutineSectionKey) => boolean;
  discardSection: (section: RoutineSectionKey) => void;

  // save
  saveRoutine: UseMutationResult<unknown, unknown, void, unknown>;
  saveConflict: boolean;
  reloadLatest: () => void;

  // header / automation
  automationEnabled: boolean;
  automationLabel: string;
  automationLabelClassName: string;
  automationToggleDisabled: boolean;
  onToggleAutomation: () => void;
  onOpenRunDialog: () => void;
  runRoutinePending: boolean;

  // triggers
  newTrigger: NewTriggerDraft;
  setNewTrigger: React.Dispatch<React.SetStateAction<NewTriggerDraft>>;
  createTrigger: UseMutationResult<RoutineTriggerResponse, unknown, void, unknown>;
  updateTrigger: UseMutationResult<unknown, unknown, { id: string; patch: Record<string, unknown> }, unknown>;
  deleteTrigger: UseMutationResult<unknown, unknown, string, unknown>;
  rotateTrigger: UseMutationResult<RotateRoutineTriggerResponse, unknown, string, unknown>;

  // secrets
  secretMessage: SecretMessage | null;
  setSecretMessage: (message: SecretMessage | null) => void;
  copySecretValue: (label: string, value: string) => void;
  availableSecrets: SecretList;
  createSecret: UseMutationResult<CompanySecret, unknown, { name: string; value: string }, unknown>;

  // entities
  agents: AgentList;
  projects: ProjectList;
  agentById: Map<string, AgentList[number]>;
  projectById: Map<string, ProjectList[number]>;
  assigneeOptions: InlineEntityOption[];
  projectOptions: InlineEntityOption[];
  recentAssigneeIds: string[];
  recentProjectIds: string[];
  mentionOptions: MentionOption[];
  currentAssignee: AgentList[number] | null;
  currentProject: ProjectList[number] | null;

  // operate data
  routineRuns: RoutineRunList | undefined;
  activity: RoutineActivityList | undefined;
  hasLiveRun: boolean;
  activeIssueId: string | undefined;

  // refs
  titleInputRef: React.RefObject<HTMLTextAreaElement | null>;
  descriptionEditorRef: React.RefObject<MarkdownEditorRef | null>;
  assigneeSelectorRef: React.RefObject<HTMLButtonElement | null>;
  projectSelectorRef: React.RefObject<HTMLButtonElement | null>;

  // history restore plumbing
  onHistoryRestoreSecretMaterials: (
    response: import("../../api/routines").RestoreRoutineRevisionResponse,
  ) => void;
  onHistoryRestored: (
    response: import("../../api/routines").RestoreRoutineRevisionResponse,
  ) => void;

  navigateToSection: (section: RoutineSectionKey, options?: { replace?: boolean }) => void;
};

export const RoutineDetailContext = createContext<RoutineDetailContextValue | null>(null);

export function useRoutineDetail(): RoutineDetailContextValue {
  const value = useContext(RoutineDetailContext);
  if (!value) {
    throw new Error("useRoutineDetail must be used within a RoutineDetailContext provider");
  }
  return value;
}
