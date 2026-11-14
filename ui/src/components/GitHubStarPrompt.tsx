import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { healthApi } from "@/api/health";
import { issuesApi } from "@/api/issues";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCompany } from "@/context/CompanyContext";
import { useDialogState } from "@/context/DialogContext";
import { useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { MODAL_SELECTOR, useModalOpen, useOnboardingInProgress } from "./AnnouncementWell";
import { PaperclipMark } from "./PaperclipLockup";

export const STAR_PROMPT_COMPLETED_TASKS = 5;
export const STAR_PROMPT_SEEN_KEY = "paperclip.github-star-prompt.seen";
export const PAPERCLIP_GITHUB_URL = "https://github.com/paperclipai/paperclip";
export const TASK_ATTENTION_SELECTOR = '[data-testid="task-execution-retry"], [role="status"][aria-label="Task status"]';
const TASK_LIST_VIEWS = new Set(["all", "active", "backlog", "done", "recent"]);

export function isTaskFocusPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  const [section, ref] = segments.slice(-2);
  return (segments.length === 2 || segments.length === 3) && Boolean(ref)
    && (section === "chats" || (section === "issues" && !TASK_LIST_VIEWS.has(ref!)));
}

function readSeen() {
  try { return window.localStorage.getItem(STAR_PROMPT_SEEN_KEY) !== null; } catch { return true; }
}

function markSeen() {
  try { window.localStorage.setItem(STAR_PROMPT_SEEN_KEY, new Date().toISOString()); } catch { /* shown once per visit instead */ }
}

/**
 * Asks self-hosted users to star the repository once they have finished
 * enough tasks to know whether Paperclip helps them. It shows at most once
 * per browser: showing it counts as seen, so a reload or another open tab
 * never repeats it. It waits for any other dialog to close. Cloud instances,
 * unfinished onboarding and unknown state (loading or a failed read) keep it
 * hidden.
 */
export function GitHubStarPrompt() {
  const { selectedCompanyId, loading } = useCompany();
  const { onboardingOpen } = useDialogState();
  const [seen, setSeen] = useState(readSeen);
  const [open, setOpen] = useState(false);
  const onboardingInProgress = useOnboardingInProgress(selectedCompanyId);
  const health = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get(), enabled: false });
  const selfHosted = health.isSuccess && !health.data.cloud;
  const eligible = selfHosted && !seen && !loading && Boolean(selectedCompanyId) && !onboardingOpen && !onboardingInProgress;
  const done = useQuery({
    queryKey: queryKeys.issues.starPromptDone(selectedCompanyId ?? "__none__"),
    queryFn: ({ signal }) => issuesApi.listCompact(selectedCompanyId!, { status: "done", limit: STAR_PROMPT_COMPLETED_TASKS }, { signal }),
    enabled: eligible,
    staleTime: 60_000,
  });
  const reached = eligible && done.isSuccess && done.data.length >= STAR_PROMPT_COMPLETED_TASKS;
  const otherModalOpen = useModalOpen(reached);
  const taskNeedsAttention = useModalOpen(reached || open, TASK_ATTENTION_SELECTOR);
  const midTask = isTaskFocusPath(useLocation().pathname);

  useEffect(() => {
    if (seen) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === STAR_PROMPT_SEEN_KEY || event.key === null) setSeen(readSeen());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [seen]);

  useEffect(() => {
    if (!reached || otherModalOpen || taskNeedsAttention || midTask
      || document.querySelector(`${MODAL_SELECTOR}, ${TASK_ATTENTION_SELECTOR}`)) return;
    // Another tab may have shown it after this one mounted.
    if (readSeen()) { setSeen(true); return; }
    markSeen();
    setSeen(true);
    setOpen(true);
  }, [reached, otherModalOpen, taskNeedsAttention, midTask]);

  useEffect(() => {
    if (open && (midTask || taskNeedsAttention)) setOpen(false);
  }, [open, midTask, taskNeedsAttention]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md" data-testid="github-star-prompt">
        <DialogHeader className="items-center text-center sm:text-center">
          <div className="mb-2 flex size-14 items-center justify-center rounded-full border border-border bg-muted">
            <PaperclipMark decorative className="size-7" />
          </div>
          <DialogTitle>You completed {STAR_PROMPT_COMPLETED_TASKS} tasks!</DialogTitle>
          <DialogDescription className="max-w-xs">
            If you're enjoying Paperclip, consider giving us a star on GitHub!
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button asChild className="w-full">
            <a href={PAPERCLIP_GITHUB_URL} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
              <Star className="size-4 fill-current" aria-hidden />
              Star on GitHub
            </a>
          </Button>
          <Button variant="ghost" className="w-full text-muted-foreground" onClick={() => setOpen(false)}>Not now</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
