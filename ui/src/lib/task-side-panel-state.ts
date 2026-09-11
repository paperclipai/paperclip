import type { WorkspaceFileSelector } from "@paperclipai/shared";
import type { SidePanelTabRecord, SidePanelTabsState } from "@/components/side-panel";

const STORAGE_VERSION = 1;
const MAX_TASK_STATES = 50;

export type TaskSidePanelTabPayload =
  | { kind: "properties" }
  | { kind: "subtasks" }
  | { kind: "artifacts" }
  | { kind: "issue-document"; documentKey: string }
  | {
      kind: "files-browser";
      query: string | null;
      folderPath: string | null;
      projectId: string | null;
      workspaceId: string | null;
    }
  | {
      kind: "workspace-file";
      path: string;
      workspace: WorkspaceFileSelector;
      projectId: string | null;
      workspaceId: string | null;
      line: number | null;
      column: number | null;
    };

export interface StoredTaskSidePanelState {
  state: SidePanelTabsState<TaskSidePanelTabPayload>;
  launcherOpen: boolean;
  userInteracted: boolean;
  autoPlanHandled: boolean;
  updatedAt: number;
}

interface TaskSidePanelStore {
  version: number;
  tasks: Record<string, StoredTaskSidePanelState>;
}

function storageKey(accountScope: string, companyId: string) {
  return `paperclip:task-side-panel:v${STORAGE_VERSION}:${accountScope}:${companyId}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function positiveInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parsePayload(value: unknown): TaskSidePanelTabPayload | null {
  const input = record(value);
  if (!input) return null;
  const kind = input.kind;
  if (kind === "properties") return { kind };
  if (kind === "subtasks") return { kind };
  if (kind === "artifacts") return { kind };
  if (kind === "issue-document") {
    return typeof input.documentKey === "string" && input.documentKey.length > 0
      ? { kind, documentKey: input.documentKey }
      : null;
  }
  if (kind === "files-browser") {
    const query = nullableString(input.query);
    const folderPath = nullableString(input.folderPath);
    const projectId = nullableString(input.projectId);
    const workspaceId = nullableString(input.workspaceId);
    if ([query, folderPath, projectId, workspaceId].some((entry) => typeof entry === "undefined")) return null;
    return { kind, query: query!, folderPath: folderPath!, projectId: projectId!, workspaceId: workspaceId! };
  }
  if (kind === "workspace-file") {
    if (typeof input.path !== "string" || input.path.length === 0) return null;
    const workspace = input.workspace === "execution" || input.workspace === "project" ? input.workspace : "auto";
    const projectId = nullableString(input.projectId);
    const workspaceId = nullableString(input.workspaceId);
    const line = positiveInteger(input.line);
    const column = positiveInteger(input.column);
    if ([projectId, workspaceId, line, column].some((entry) => typeof entry === "undefined")) return null;
    return {
      kind,
      path: input.path,
      workspace,
      projectId: projectId!,
      workspaceId: workspaceId!,
      line: line!,
      column: column!,
    };
  }
  return null;
}

function parseTab(value: unknown, fileTabsEnabled: boolean): SidePanelTabRecord<TaskSidePanelTabPayload> | null {
  const input = record(value);
  if (!input || typeof input.id !== "string" || typeof input.type !== "string" || typeof input.label !== "string") return null;
  const payload = parsePayload(input.payload);
  if (!payload) return null;
  if (!fileTabsEnabled && (payload.kind === "files-browser" || payload.kind === "workspace-file")) return null;
  return {
    id: input.id,
    type: input.type,
    label: input.label,
    ariaLabel: typeof input.ariaLabel === "string" ? input.ariaLabel : undefined,
    closable: typeof input.closable === "boolean" ? input.closable : true,
    contentMode: input.contentMode === "full-bleed" || input.contentMode === "prose" ? input.contentMode : "padded",
    payload,
  };
}

function parseEntry(value: unknown, fileTabsEnabled: boolean): StoredTaskSidePanelState | null {
  const input = record(value);
  const rawState = record(input?.state);
  if (!input || !rawState || !Array.isArray(rawState.tabs)) return null;
  const seen = new Set<string>();
  const tabs = rawState.tabs.flatMap((raw) => {
    const tab = parseTab(raw, fileTabsEnabled);
    if (!tab || seen.has(tab.id)) return [];
    seen.add(tab.id);
    return [tab];
  });
  const requestedActive = typeof rawState.activeTabId === "string" ? rawState.activeTabId : null;
  return {
    state: {
      tabs,
      activeTabId: requestedActive && seen.has(requestedActive) ? requestedActive : tabs[0]?.id ?? null,
    },
    launcherOpen: input.launcherOpen === true,
    userInteracted: input.userInteracted === true,
    autoPlanHandled: input.autoPlanHandled === true,
    updatedAt: typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
  };
}

function readStore(accountScope: string, companyId: string): TaskSidePanelStore {
  if (typeof window === "undefined") return { version: STORAGE_VERSION, tasks: {} };
  try {
    const parsed = record(JSON.parse(window.localStorage.getItem(storageKey(accountScope, companyId)) ?? "null"));
    if (parsed?.version !== STORAGE_VERSION || !record(parsed.tasks)) return { version: STORAGE_VERSION, tasks: {} };
    return { version: STORAGE_VERSION, tasks: parsed.tasks as Record<string, StoredTaskSidePanelState> };
  } catch {
    return { version: STORAGE_VERSION, tasks: {} };
  }
}

export function readTaskSidePanelState(
  accountScope: string,
  companyId: string,
  taskId: string,
  fileTabsEnabled: boolean,
): StoredTaskSidePanelState | null {
  return parseEntry(readStore(accountScope, companyId).tasks[taskId], fileTabsEnabled);
}

export function writeTaskSidePanelState(
  accountScope: string,
  companyId: string,
  taskId: string,
  entry: StoredTaskSidePanelState,
) {
  if (typeof window === "undefined") return;
  try {
    const store = readStore(accountScope, companyId);
    const tasks = { ...store.tasks, [taskId]: entry };
    const retained = Object.entries(tasks)
      .sort((left, right) => (right[1].updatedAt ?? 0) - (left[1].updatedAt ?? 0))
      .slice(0, MAX_TASK_STATES);
    window.localStorage.setItem(storageKey(accountScope, companyId), JSON.stringify({
      version: STORAGE_VERSION,
      tasks: Object.fromEntries(retained),
    } satisfies TaskSidePanelStore));
  } catch {
    // Storage is an enhancement; panel behavior stays usable when unavailable.
  }
}

export function taskPanelPropertiesTab(): SidePanelTabRecord<TaskSidePanelTabPayload> {
  return { id: "properties", type: "properties", label: "Properties", closable: true, contentMode: "padded", payload: { kind: "properties" } };
}

export function taskPanelSubtasksTab(): SidePanelTabRecord<TaskSidePanelTabPayload> {
  return { id: "subtasks", type: "subtasks", label: "Subtasks", closable: true, contentMode: "padded", payload: { kind: "subtasks" } };
}

export function taskPanelArtifactsTab(): SidePanelTabRecord<TaskSidePanelTabPayload> {
  return { id: "artifacts", type: "artifacts", label: "Artifacts", closable: true, contentMode: "padded", payload: { kind: "artifacts" } };
}

export function taskPanelDocumentTab(documentKey: string, label: string): SidePanelTabRecord<TaskSidePanelTabPayload> {
  return {
    id: `document:${documentKey}`,
    type: "issue-document",
    label,
    closable: true,
    contentMode: "prose",
    payload: { kind: "issue-document", documentKey },
  };
}

export function taskPanelFilesTab(): SidePanelTabRecord<TaskSidePanelTabPayload> {
  return {
    id: "files",
    type: "files-browser",
    label: "Files",
    closable: true,
    contentMode: "full-bleed",
    payload: { kind: "files-browser", query: null, folderPath: null, projectId: null, workspaceId: null },
  };
}

export function taskPanelWorkspaceFileTab(input: {
  path: string;
  workspace?: WorkspaceFileSelector;
  projectId?: string | null;
  workspaceId?: string | null;
  line?: number | null;
  column?: number | null;
}): SidePanelTabRecord<TaskSidePanelTabPayload> {
  const projectId = input.projectId ?? null;
  const workspaceId = input.workspaceId ?? null;
  const scope = projectId && workspaceId ? `${projectId}:${workspaceId}` : input.workspace ?? "auto";
  return {
    id: `workspace-file:${scope}:${input.path}`,
    type: "workspace-file",
    label: input.path.split("/").filter(Boolean).at(-1) ?? input.path,
    ariaLabel: input.path,
    closable: true,
    contentMode: "full-bleed",
    payload: {
      kind: "workspace-file",
      path: input.path,
      workspace: input.workspace ?? "auto",
      projectId,
      workspaceId,
      line: input.line ?? null,
      column: input.column ?? null,
    },
  };
}
