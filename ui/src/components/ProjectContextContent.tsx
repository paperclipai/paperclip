import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySkillListItem, ContextSource, ContextSourceStatus, ProjectContextOverview, ProjectContextProfileUpdateRequest } from "@paperclipai/shared";
import { AlertCircle, Database, FileText, FolderOpen, Link2, Loader2, Plus, Puzzle, RefreshCw, Search, Target, Trash2, Upload } from "lucide-react";
import { companySkillsApi } from "../api/companySkills";
import { projectContextApi } from "../api/projectContext";
import { useToast } from "../context/ToastContext";
import { useAutosaveIndicator, type AutosaveState } from "../hooks/useAutosaveIndicator";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

function sourceTypeLabel(source: ContextSource) {
  if (source.sourceType === "google_drive") return "Google Drive";
  if (source.sourceType === "upload") return "Upload";
  if (source.sourceType === "manual") return "Manual";
  return source.provider ?? "Plugin";
}

function statusTone(status: ContextSourceStatus) {
  if (status === "ready") return "bg-emerald-500";
  if (status === "syncing") return "bg-sky-400";
  if (status === "error") return "bg-red-400";
  return "bg-muted-foreground/50";
}

function sourceTimestamp(source: ContextSource) {
  if (source.lastSyncedAt) return `synced ${timeAgo(source.lastSyncedAt)}`;
  return `updated ${timeAgo(source.updatedAt)}`;
}

function bySkillName(a: CompanySkillListItem, b: CompanySkillListItem) {
  return a.name.localeCompare(b.name);
}

const LEGACY_CODESM_IMPORT_KEY = "codesm-client-import";
const LEGACY_CODESM_IMPORT_RE = /<!--\s*codesm-client-import:start\s*-->([\s\S]*?)<!--\s*codesm-client-import:end\s*-->/i;
const PROJECT_CONTEXT_PROFILE_AUTOSAVE_DEBOUNCE_MS = 900;

export function extractLegacyCodesmClientImport(markdown: string) {
  const match = markdown.match(LEGACY_CODESM_IMPORT_RE);
  if (!match || match.index === undefined) return null;

  const bodyText = (match[1] ?? "").trim();
  if (!bodyText) return null;

  const remainingInstructionsMarkdown = [
    markdown.slice(0, match.index).trimEnd(),
    markdown.slice(match.index + match[0].length).trimStart(),
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return { bodyText, remainingInstructionsMarkdown };
}

function hasMigratedCodesmSource(sources: ContextSource[]) {
  return sources.some((source) => {
    const metadata = source.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
    return (
      metadata.migratedFrom === "project_instructions"
      && metadata.migrationKey === LEGACY_CODESM_IMPORT_KEY
    );
  });
}

function autosaveErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Project context autosave failed.";
}

function useProjectContextProfileFieldAutosave({
  profileValue,
  save,
}: {
  profileValue?: string;
  save: (value: string) => Promise<void>;
}) {
  const [draft, setDraftState] = useState(profileValue ?? "");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastServerValueRef = useRef(profileValue ?? "");
  const saveRequestIdRef = useRef(0);
  const inFlightValueRef = useRef<string | null>(null);
  const {
    state,
    markDirty,
    reset,
    runSave,
  } = useAutosaveIndicator();

  const isReady = profileValue !== undefined;
  const hasUnsavedChanges = isReady && draft !== lastServerValueRef.current;

  const clearDebounce = useCallback(() => {
    if (!debounceRef.current) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
  }, []);

  useEffect(() => clearDebounce, [clearDebounce]);

  useEffect(() => {
    if (profileValue === undefined) return;
    const previousServerValue = lastServerValueRef.current;
    lastServerValueRef.current = profileValue;
    setDraftState((currentDraft) => {
      if (currentDraft !== previousServerValue) return currentDraft;
      return profileValue;
    });
  }, [profileValue]);

  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    setErrorMessage(null);
  }, []);

  const saveDraft = useCallback(async (value: string) => {
    if (!isReady || value === lastServerValueRef.current || inFlightValueRef.current === value) return;

    const requestId = saveRequestIdRef.current + 1;
    saveRequestIdRef.current = requestId;
    inFlightValueRef.current = value;

    try {
      await runSave(async () => {
        await save(value);
        if (saveRequestIdRef.current !== requestId) return;
        lastServerValueRef.current = value;
        setErrorMessage(null);
      });
    } catch (error) {
      if (saveRequestIdRef.current === requestId) {
        setErrorMessage(autosaveErrorMessage(error));
      }
    } finally {
      if (inFlightValueRef.current === value) {
        inFlightValueRef.current = null;
      }
    }
  }, [isReady, runSave, save]);

  const flush = useCallback(() => {
    clearDebounce();
    void saveDraft(draft);
  }, [clearDebounce, draft, saveDraft]);

  useEffect(() => {
    if (!isReady) return;
    clearDebounce();
    if (draft === lastServerValueRef.current) {
      reset();
      return;
    }

    markDirty();
    debounceRef.current = setTimeout(() => {
      void saveDraft(draft);
    }, PROJECT_CONTEXT_PROFILE_AUTOSAVE_DEBOUNCE_MS);

    return clearDebounce;
  }, [clearDebounce, draft, isReady, markDirty, reset, saveDraft]);

  return {
    draft,
    setDraft,
    flush,
    state,
    hasUnsavedChanges,
    errorMessage,
  };
}

function ProfileAutosaveStatus({
  state,
  hasUnsavedChanges,
  errorMessage,
}: {
  state: AutosaveState;
  hasUnsavedChanges: boolean;
  errorMessage: string | null;
}) {
  const label = (() => {
    if (state === "saving") return "Autosaving...";
    if (state === "error") return "Could not save";
    if (hasUnsavedChanges) return "Unsaved changes";
    if (state === "saved") return "Saved";
    return "";
  })();
  const tone = state === "error"
    ? "text-destructive"
    : hasUnsavedChanges && state !== "saving"
      ? "text-amber-300"
      : "text-muted-foreground";

  return (
    <div className="min-h-5 text-right">
      <span
        className={`text-xs transition-opacity duration-150 ${tone} ${label ? "opacity-100" : "opacity-0"}`}
        title={errorMessage ?? undefined}
      >
        {label || "Saved"}
      </span>
    </div>
  );
}

function useLegacyCodesmImportMigration({
  companyId,
  projectId,
  contextKey,
  overview,
}: {
  companyId: string;
  projectId: string;
  contextKey: readonly unknown[];
  overview?: ProjectContextOverview;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const attemptedMigrations = useRef(new Set<string>());

  const { mutate: migrateLegacyImport, isPending } = useMutation({
    mutationFn: async ({
      instructionsMarkdown,
      sources,
    }: {
      instructionsMarkdown: string;
      sources: ContextSource[];
    }) => {
      const extracted = extractLegacyCodesmClientImport(instructionsMarkdown);
      if (!extracted) return false;

      if (!hasMigratedCodesmSource(sources)) {
        await projectContextApi.createSource(companyId, projectId, {
          sourceType: "manual",
          title: "Imported client source",
          bodyText: extracted.bodyText,
          metadata: {
            migratedFrom: "project_instructions",
            migrationKey: LEGACY_CODESM_IMPORT_KEY,
          },
        });
      }

      await projectContextApi.updateProfile(companyId, projectId, {
        instructionsMarkdown: extracted.remainingInstructionsMarkdown,
      });
      return true;
    },
    onSuccess: async (didMigrate) => {
      if (!didMigrate) return;
      await queryClient.invalidateQueries({ queryKey: contextKey });
      pushToast({ title: "Imported client source moved to Source", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to move imported source",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!overview || isPending) return;
    if (!extractLegacyCodesmClientImport(overview.profile.instructionsMarkdown)) return;

    const attemptKey = [
      overview.profile.id,
      String(overview.profile.updatedAt),
      overview.profile.instructionsMarkdown,
      hasMigratedCodesmSource(overview.sources) ? "source-exists" : "source-missing",
    ].join(":");
    if (attemptedMigrations.current.has(attemptKey)) return;
    attemptedMigrations.current.add(attemptKey);

    migrateLegacyImport({
      instructionsMarkdown: overview.profile.instructionsMarkdown,
      sources: overview.sources,
    });
  }, [isPending, migrateLegacyImport, overview]);
}

export function ProjectContextContent({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const contextKey = useMemo(() => queryKeys.projects.context(companyId, projectId), [companyId, projectId]);
  const [skillFilter, setSkillFilter] = useState("");

  const overviewQuery = useQuery({
    queryKey: contextKey,
    queryFn: () => projectContextApi.overview(companyId, projectId),
  });
  useLegacyCodesmImportMigration({
    companyId,
    projectId,
    contextKey,
    overview: overviewQuery.data,
  });

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId),
  });

  const syncProfileCache = useCallback((profile: ProjectContextOverview["profile"]) => {
    queryClient.setQueryData<ProjectContextOverview | undefined>(contextKey, (current) => {
      if (!current) return current;
      return { ...current, profile };
    });
  }, [contextKey, queryClient]);

  const invalidateContext = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: contextKey });
  }, [contextKey, queryClient]);

  const saveProfilePatch = useCallback(async (payload: ProjectContextProfileUpdateRequest) => {
    const profile = await projectContextApi.updateProfile(companyId, projectId, payload);
    syncProfileCache(profile);
    void invalidateContext();
  }, [companyId, invalidateContext, projectId, syncProfileCache]);
  const saveGoalProfile = useCallback((value: string) => saveProfilePatch({ goalMarkdown: value }), [saveProfilePatch]);
  const saveInstructionsProfile = useCallback(
    (value: string) => saveProfilePatch({ instructionsMarkdown: value }),
    [saveProfilePatch],
  );

  const goalAutosave = useProjectContextProfileFieldAutosave({
    profileValue: overviewQuery.data?.profile.goalMarkdown,
    save: saveGoalProfile,
  });

  const instructionsAutosave = useProjectContextProfileFieldAutosave({
    profileValue: overviewQuery.data?.profile.instructionsMarkdown,
    save: saveInstructionsProfile,
  });

  const updateProfile = useMutation({
    mutationFn: async (payload: ProjectContextProfileUpdateRequest) => {
      const profile = await projectContextApi.updateProfile(companyId, projectId, payload);
      syncProfileCache(profile);
      return profile;
    },
    onSuccess: () => {
      void invalidateContext();
      pushToast({ title: "Project context saved", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to save context", tone: "error" });
    },
  });

  const profile = overviewQuery.data?.profile;
  const selectedSkillKeys = useMemo(
    () => new Set(profile?.defaultSkillKeys ?? []),
    [profile?.defaultSkillKeys],
  );
  const filteredSkills = useMemo(() => {
    const q = skillFilter.trim().toLowerCase();
    return [...(skillsQuery.data ?? [])]
      .filter((skill) => {
        if (!q) return true;
        return (
          skill.name.toLowerCase().includes(q) ||
          skill.key.toLowerCase().includes(q) ||
          (skill.description ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const aSelected = selectedSkillKeys.has(a.key);
        const bSelected = selectedSkillKeys.has(b.key);
        if (aSelected !== bSelected) return aSelected ? -1 : 1;
        return bySkillName(a, b);
      });
  }, [skillFilter, skillsQuery.data, selectedSkillKeys]);

  if (overviewQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading context...</p>;
  }

  if (overviewQuery.error) {
    return <p className="text-sm text-destructive">{overviewQuery.error.message}</p>;
  }

  if (!profile) return null;

  const toggleSkill = (skillKey: string) => {
    const next = new Set(profile.defaultSkillKeys);
    if (next.has(skillKey)) next.delete(skillKey);
    else next.add(skillKey);
    updateProfile.mutate({ defaultSkillKeys: [...next] });
  };

  return (
    <div className="max-w-6xl space-y-5">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Target className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Project Goal</h3>
        </div>
        <Textarea
          value={goalAutosave.draft}
          onChange={(event) => goalAutosave.setDraft(event.target.value)}
          onBlur={goalAutosave.flush}
          placeholder="Project goal..."
          className="min-h-[120px] resize-y font-mono text-sm leading-6"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">{goalAutosave.draft.length.toLocaleString()} / 20,000 chars</div>
          <ProfileAutosaveStatus
            state={goalAutosave.state}
            hasUnsavedChanges={goalAutosave.hasUnsavedChanges}
            errorMessage={goalAutosave.errorMessage}
          />
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Custom instructions</h3>
          </div>
          <Textarea
            value={instructionsAutosave.draft}
            onChange={(event) => instructionsAutosave.setDraft(event.target.value)}
            onBlur={instructionsAutosave.flush}
            placeholder="Custom instructions..."
            className="min-h-[220px] resize-y font-mono text-sm leading-6"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {instructionsAutosave.draft.length.toLocaleString()} / 100,000 chars
            </div>
            <ProfileAutosaveStatus
              state={instructionsAutosave.state}
              hasUnsavedChanges={instructionsAutosave.hasUnsavedChanges}
              errorMessage={instructionsAutosave.errorMessage}
            />
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Puzzle className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Project Skills</h3>
            </div>
            <Badge variant="outline">{selectedSkillKeys.size} inherited</Badge>
          </div>
          <Input
            value={skillFilter}
            onChange={(event) => setSkillFilter(event.target.value)}
            placeholder="Filter skills..."
            className="mb-3 h-8 text-sm"
          />
          <div className="max-h-[258px] space-y-1 overflow-y-auto pr-1">
            {filteredSkills.length > 0 ? (
              filteredSkills.map((skill) => {
                const checked = selectedSkillKeys.has(skill.key);
                return (
                  <label
                    key={skill.key}
                    className="flex cursor-pointer items-start gap-3 rounded-md border border-transparent px-2 py-2 hover:border-border hover:bg-muted/30"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleSkill(skill.key)}
                      disabled={updateProfile.isPending}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{skill.name}</span>
                        {checked ? <Badge variant="secondary">Inherited</Badge> : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{skill.key}</span>
                    </span>
                  </label>
                );
              })
            ) : (
              <p className="px-2 py-6 text-sm text-muted-foreground">No skills found.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export function ProjectSourceContent({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contextKey = queryKeys.projects.context(companyId, projectId);
  const [manualTitle, setManualTitle] = useState("");
  const [manualBody, setManualBody] = useState("");
  const [driveUri, setDriveUri] = useState("");
  const [driveTitle, setDriveTitle] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");

  const overviewQuery = useQuery({
    queryKey: contextKey,
    queryFn: () => projectContextApi.overview(companyId, projectId),
  });
  useLegacyCodesmImportMigration({
    companyId,
    projectId,
    contextKey,
    overview: overviewQuery.data,
  });

  const searchQuery = useQuery({
    queryKey: queryKeys.projects.contextSearch(companyId, projectId, submittedSearch),
    queryFn: () => projectContextApi.search(companyId, projectId, submittedSearch, 8),
    enabled: submittedSearch.trim().length > 0,
  });

  const invalidateContext = async () => {
    await queryClient.invalidateQueries({ queryKey: contextKey });
    if (submittedSearch.trim()) {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.projects.contextSearch(companyId, projectId, submittedSearch),
      });
    }
  };

  const updateProfile = useMutation({
    mutationFn: projectContextApi.updateProfile.bind(null, companyId, projectId),
    onSuccess: () => {
      invalidateContext();
      pushToast({ title: "Source settings saved", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to save source settings", tone: "error" });
    },
  });

  const createSource = useMutation({
    mutationFn: projectContextApi.createSource.bind(null, companyId, projectId),
    onSuccess: () => {
      setManualTitle("");
      setManualBody("");
      setDriveUri("");
      setDriveTitle("");
      invalidateContext();
      pushToast({ title: "Source added", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to add source", tone: "error" });
    },
  });

  const uploadSource = useMutation({
    mutationFn: (file: File) => projectContextApi.uploadSourceFile(companyId, projectId, file),
    onSuccess: () => {
      invalidateContext();
      pushToast({ title: "File uploaded", tone: "success" });
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to upload file", tone: "error" });
    },
  });

  const syncSource = useMutation({
    mutationFn: (sourceId: string) => projectContextApi.syncSource(companyId, sourceId),
    onSuccess: () => invalidateContext(),
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Sync failed", tone: "error" });
    },
  });

  const deleteSource = useMutation({
    mutationFn: (sourceId: string) => projectContextApi.deleteSource(companyId, sourceId),
    onSuccess: () => {
      invalidateContext();
      pushToast({ title: "Source removed", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to remove source", tone: "error" });
    },
  });

  if (overviewQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading sources...</p>;
  }

  if (overviewQuery.error) {
    return <p className="text-sm text-destructive">{overviewQuery.error.message}</p>;
  }

  const profile = overviewQuery.data?.profile;
  if (!profile) return null;

  const addManualSource = () => {
    const title = manualTitle.trim() || "Manual source";
    const bodyText = manualBody.trim();
    if (!bodyText) return;
    createSource.mutate({ sourceType: "manual", title, bodyText });
  };

  const addDriveSource = () => {
    const uri = driveUri.trim();
    if (!uri) return;
    createSource.mutate({
      sourceType: "google_drive",
      provider: "google_drive",
      title: driveTitle.trim() || "Google Drive folder",
      uri,
      externalId: uri,
    });
  };

  const submitSearch = () => {
    setSubmittedSearch(searchDraft.trim());
  };

  return (
    <div className="max-w-6xl space-y-5">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Source</h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <span>{profile.maxChunks} snippets, {profile.maxBundleChars.toLocaleString()} chars</span>
              <span>Source retrieval</span>
              <ToggleSwitch
                checked={profile.retrievalEnabled}
                onCheckedChange={(checked) => updateProfile.mutate({ retrievalEnabled: checked })}
                disabled={updateProfile.isPending}
              />
            </div>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) uploadSource.mutate(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadSource.isPending}
            >
              {uploadSource.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              Upload
            </Button>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-border/70 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Link2 className="h-4 w-4 text-muted-foreground" />
              Google Drive
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Input
                value={driveUri}
                onChange={(event) => setDriveUri(event.target.value)}
                placeholder="Folder URL"
                className="h-8 text-sm"
              />
              <Input
                value={driveTitle}
                onChange={(event) => setDriveTitle(event.target.value)}
                placeholder="Display name"
                className="h-8 text-sm"
              />
              <Button size="sm" className="gap-1.5" onClick={addDriveSource} disabled={!driveUri.trim() || createSource.isPending}>
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border/70 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Manual
            </div>
            <div className="grid gap-2 sm:grid-cols-[220px_minmax(0,1fr)_auto]">
              <Input
                value={manualTitle}
                onChange={(event) => setManualTitle(event.target.value)}
                placeholder="Title"
                className="h-8 text-sm"
              />
              <Input
                value={manualBody}
                onChange={(event) => setManualBody(event.target.value)}
                placeholder="Paste a short note or markdown source"
                className="h-8 text-sm"
              />
              <Button size="sm" className="gap-1.5" onClick={addManualSource} disabled={!manualBody.trim() || createSource.isPending}>
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-border">
          {(overviewQuery.data?.sources ?? []).length > 0 ? (
            overviewQuery.data!.sources.map((source) => (
              <div key={source.id} className="flex flex-col gap-3 border-b border-border px-4 py-3 last:border-b-0 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${statusTone(source.status)}`} />
                    <span className="truncate text-sm font-medium">{source.title}</span>
                    <Badge variant="outline">{sourceTypeLabel(source)}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{source.itemCount ?? 0} items</span>
                    <span>{source.chunkCount ?? 0} chunks</span>
                    <span>{sourceTimestamp(source)}</span>
                    {source.uri ? (
                      <a href={source.uri} target="_blank" rel="noreferrer" className="max-w-[320px] truncate hover:text-foreground hover:underline">
                        {source.uri}
                      </a>
                    ) : null}
                  </div>
                  {source.statusMessage ? (
                    <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-300">
                      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{source.statusMessage}</span>
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    title="Sync"
                    onClick={() => syncSource.mutate(source.id)}
                    disabled={syncSource.isPending}
                  >
                    {syncSource.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    title="Remove"
                    onClick={() => deleteSource.mutate(source.id)}
                    disabled={deleteSource.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <div className="flex items-center gap-3 px-4 py-8 text-sm text-muted-foreground">
              <FolderOpen className="h-4 w-4" />
              No sources yet.
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Search Preview</h3>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
            placeholder="Search indexed project context..."
            className="h-9 text-sm"
          />
          <Button className="gap-1.5" onClick={submitSearch} disabled={!searchDraft.trim() || searchQuery.isFetching}>
            {searchQuery.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Search
          </Button>
        </div>
        {submittedSearch.trim() ? (
          <div className="mt-4 space-y-2">
            {(searchQuery.data ?? []).length > 0 ? (
              searchQuery.data!.map((result) => (
                <div key={result.chunkId} className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{result.itemTitle}</span>
                    <span>{result.sourceTitle}</span>
                    {result.uri ? (
                      <a href={result.uri} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
                        Open
                      </a>
                    ) : null}
                  </div>
                  <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                    {result.content}
                  </p>
                </div>
              ))
            ) : searchQuery.isFetching ? null : (
              <p className="text-sm text-muted-foreground">No matching source chunks.</p>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
