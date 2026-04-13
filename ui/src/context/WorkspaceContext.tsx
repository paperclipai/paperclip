/**
 * Global workspace context — provides the currently selected workspace
 * (project + workspace + cwd) to all components app-wide.
 *
 * Persisted to localStorage so it survives page refreshes and navigation.
 * Clears when the selected company changes (workspaces are company-scoped).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, ProjectWorkspace } from "@paperclipai/shared";
import { useCompany } from "./CompanyContext";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";

/** Flat representation of a workspace with its parent project info. */
export interface WorkspaceEntry {
  project: Project;
  workspace: ProjectWorkspace;
  cwd: string;
}

interface WorkspaceContextValue {
  /** All available workspaces for the current company. */
  workspaces: WorkspaceEntry[];
  /** Currently selected workspace, or null if none. */
  selected: WorkspaceEntry | null;
  /** The cwd of the selected workspace (convenience shortcut). */
  cwd: string | null;
  /** Whether projects/workspaces are still loading. */
  loading: boolean;
  /** Select a workspace by its ID. */
  selectWorkspace: (workspaceId: string) => void;
  /** Select a workspace by providing a raw cwd (for custom paths). */
  selectCustomCwd: (cwd: string) => void;
  /** Clear the selected workspace. */
  clearWorkspace: () => void;
}

const STORAGE_KEY = "paperclip.selectedWorkspaceId";
const CUSTOM_CWD_KEY = "paperclip.customWorkspaceCwd";

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Fetches all workspaces for the given projects in a single query.
 * This avoids calling useQuery in a loop (which violates rules of hooks).
 */
function useProjectWorkspaces(projects: Project[], companyId: string | null) {
  return useQuery({
    queryKey: ["all-project-workspaces", companyId, projects.map((p) => p.id)],
    queryFn: async () => {
      if (!companyId || projects.length === 0) return [];
      const results = await Promise.all(
        projects.map(async (project) => {
          const workspaces = await projectsApi.listWorkspaces(project.id, companyId);
          return { project, workspaces };
        }),
      );
      const entries: WorkspaceEntry[] = [];
      for (const { project, workspaces } of results) {
        for (const ws of workspaces) {
          if (!ws.cwd) continue;
          entries.push({ project, workspace: ws, cwd: ws.cwd });
        }
      }
      return entries;
    },
    enabled: !!companyId && projects.length > 0,
  });
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId } = useCompany();

  // Stored selection — either a workspace ID or a custom cwd
  const [selectedId, setSelectedId] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY),
  );
  const [customCwd, setCustomCwd] = useState<string | null>(
    () => localStorage.getItem(CUSTOM_CWD_KEY),
  );

  // Fetch all projects for the current company
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const projects = projectsQuery.data ?? [];

  // Fetch all workspaces across all projects in a single query
  const workspacesQuery = useProjectWorkspaces(projects, selectedCompanyId);
  const workspaces = workspacesQuery.data ?? [];

  // Clear selection when company changes and stored workspace doesn't exist
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (!selectedId) return;
    if (workspaces.length === 0) return;

    const exists = workspaces.some((w) => w.workspace.id === selectedId);
    if (!exists) {
      setSelectedId(null);
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [selectedCompanyId, workspaces, selectedId]);

  // Resolve the selected entry
  const selected = useMemo(() => {
    if (selectedId) {
      return workspaces.find((w) => w.workspace.id === selectedId) ?? null;
    }
    return null;
  }, [selectedId, workspaces]);

  const cwd = selected?.cwd ?? customCwd ?? null;

  const selectWorkspace = useCallback((workspaceId: string) => {
    setSelectedId(workspaceId);
    setCustomCwd(null);
    localStorage.setItem(STORAGE_KEY, workspaceId);
    localStorage.removeItem(CUSTOM_CWD_KEY);
  }, []);

  const selectCustomCwd = useCallback((path: string) => {
    setSelectedId(null);
    setCustomCwd(path);
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(CUSTOM_CWD_KEY, path);
  }, []);

  const clearWorkspace = useCallback(() => {
    setSelectedId(null);
    setCustomCwd(null);
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(CUSTOM_CWD_KEY);
  }, []);

  const loading = projectsQuery.isLoading || workspacesQuery.isLoading;

  const value = useMemo(
    () => ({
      workspaces,
      selected,
      cwd,
      loading,
      selectWorkspace,
      selectCustomCwd,
      clearWorkspace,
    }),
    [workspaces, selected, cwd, loading, selectWorkspace, selectCustomCwd, clearWorkspace],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return ctx;
}
