import { useCallback, useEffect, useState, type SetStateAction } from "react";
import { readStagedIssueFiles, writeStagedIssueFiles, type StagedIssueFile } from "../lib/staged-issue-files";

export function useStagedIssueFiles(owner: string | undefined, companyId: string | null | undefined) {
  const key = owner !== undefined && companyId ? JSON.stringify([owner, companyId]) : null;
  const [state, setState] = useState<{
    key: string | null;
    files: StagedIssueFile[];
    removedIds: string[];
    restoring: boolean;
    changed: boolean;
  }>({ key, files: [], removedIds: [], restoring: Boolean(key), changed: false });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const unboundFiles = state.key === null ? state.files : [];
    setError(null);
    setState({ key, files: unboundFiles, removedIds: [], restoring: Boolean(key), changed: false });
    if (key) {
      void readStagedIssueFiles(key).then((files) => {
        if (active) setState({ key, files: [...files, ...unboundFiles], removedIds: [], restoring: false, changed: unboundFiles.length > 0 });
      }).catch(() => {
        if (!active) return;
        setState({ key, files: unboundFiles, removedIds: [], restoring: false, changed: unboundFiles.length > 0 });
        setError("Saved files could not be restored. Attach them again before you create the task.");
      });
    }
    return () => { active = false; };
  }, [key]);

  useEffect(() => {
    if (!key || state.key !== key || state.restoring || !state.changed) return;
    let active = true;
    void writeStagedIssueFiles(key, state.files, state.removedIds).then(() => {
      if (active) setError(null);
    }).catch(() => {
      if (active) setError("Files could not be saved in this browser. Keep this page open until you create the task.");
    });
    return () => { active = false; };
  }, [key, state]);

  const setFiles = useCallback((update: SetStateAction<StagedIssueFile[]>) => {
    setState((current) => {
      if (current.key !== key || current.restoring) return current;
      const files = typeof update === "function" ? update(current.files) : update;
      const retainedIds = new Set(files.map(file => file.id));
      const removedIds = [...new Set([...current.removedIds, ...current.files.map(file => file.id)])]
        .filter(id => !retainedIds.has(id));
      return { ...current, files, removedIds, changed: true };
    });
  }, [key]);

  return {
    files: state.key === key ? state.files : [],
    setFiles,
    restoring: state.key !== key || state.restoring,
    error,
  };
}
