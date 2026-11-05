import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { TaskViewsMenu } from "@/components/TaskViewsMenu";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";
import { loadTaskListView, taskListViewStorageKey } from "@/lib/task-list-views";
import { ORGANIZATION_SCOPED_PARAMS, normalizeTaskViewKey, resolveInitialTaskView, taskView, type TaskViewKey } from "@/lib/task-views";
import { useLocation, useNavigate, useSearchParams } from "@/lib/router";
import { CoordinatorTasks } from "./CoordinatorTasks";
import { Inbox } from "./Inbox";

function loadView(key: string, userId: string | null): TaskViewKey {
  try {
    const saved = normalizeTaskViewKey(localStorage.getItem(key));
    if (saved) return saved;
    const previous = userId ? loadTaskListView(taskListViewStorageKey("coordinator", userId), undefined, "inbox") : "inbox";
    return previous === "inbox" ? "mine" : previous === "blocked" ? "needs_attention" : previous;
  } catch {
    return "mine";
  }
}

export function CoordinatorTaskViews() {
  const { selectedCompanyId } = useCompany();
  const { userId, loaded } = useCoordinatorWorkspaceEnabled();
  const { openNewIssue } = useDialogActions();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const key = JSON.stringify(["paperclip:coordinator-task-view:v2", selectedCompanyId, userId]);
  const [preference, setPreference] = useState(() => ({ key, view: loadView(key, userId) }));
  const savedView = preference.key === key ? preference.view : loadView(key, userId);
  const requested = params.get("view") === "inbox" ? "mine" : params.get("view");
  const organizationScoped = [...ORGANIZATION_SCOPED_PARAMS, "workspaceId", "status", "label"].some(param => params.getAll(param).some(Boolean));
  const view = resolveInitialTaskView(requested, organizationScoped, savedView);
  const definition = taskView(view);
  useEffect(() => {
    if (!loaded || !userId || !selectedCompanyId) return;
    try { localStorage.setItem(key, view); } catch {}
    setPreference(current => current.key === key && current.view === view ? current : { key, view });
    if (params.get("view") === view) return;
    const next = new URLSearchParams(params);
    next.set("view", view);
    navigate({ search: next.toString(), hash: location.hash }, { replace: true });
  }, [key, loaded, userId, selectedCompanyId, view, params, navigate, location.hash]);
  const views = <TaskViewsMenu coordinator value={view} onChange={next => navigate(`/issues?view=${next}`)} />;
  if (definition.surface === "issues") return <CoordinatorTasks viewControl={views} />;
  return <section className="coordinator-task-list" aria-label="Tasks"><Inbox
    tab={definition.inboxTab}
    surfaceLabel="Tasks"
    toolbarContext={<div className="flex min-w-0 items-center gap-2">{views}<Button variant="outline" size="sm" onClick={() => openNewIssue()}><Plus className="size-4" />New Task</Button></div>}
  /></section>;
}
