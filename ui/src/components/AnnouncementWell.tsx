import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { useAccountIdentity } from "@/api/companies-query";
import type { HealthStatus } from "@/api/health";
import { issuesApi } from "@/api/issues";
import { useCompany } from "@/context/CompanyContext";
import { useDialogState } from "@/context/DialogContext";
import { useOptionalToastActions, useOptionalToastState } from "@/context/ToastContext";
import { useAnnouncement } from "@/hooks/useAnnouncement";
import { queryKeys } from "@/lib/queryKeys";
import { AnnouncementCard } from "./AnnouncementCard";

// Includes the command palette, sheets and dialogs created outside DialogContext.
export const MODAL_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [aria-modal="true"]:not([data-state="closed"]), dialog[open]';
export function useModalOpen(enabled: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const scan = () => setOpen(Boolean(document.querySelector(MODAL_SELECTOR)));
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "aria-modal", "open"] });
    return () => observer.disconnect();
  }, [enabled]);
  return open;
}

const FINISHED_ONBOARDING_STATUSES = new Set(["done", "cancelled"]);

/**
 * A new user's first session is the onboarding first task. Announcements and
 * other optional prompts wait until that task is finished so they cannot cover
 * its questions. Unknown state (loading or a failed read) keeps them hidden.
 */
export function useOnboardingInProgress(companyId: string | null) {
  const query = useQuery({
    queryKey: queryKeys.issues.onboardingFirstTask(companyId ?? "__none__"),
    queryFn: ({ signal }) => issuesApi.list(companyId!, { originKind: ONBOARDING_FIRST_TASK_ORIGIN_KIND, limit: 1 }, { signal }),
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });
  if (!companyId) return false;
  if (!query.isSuccess) return true;
  return query.data.some((issue) => issue.originKind === ONBOARDING_FIRST_TASK_ORIGIN_KIND && !FINISHED_ONBOARDING_STATUSES.has(issue.status));
}

/**
 * Where the card lives. `sidebar` docks it in the desktop sidebar column, in
 * normal layout flow, so it never covers the task thread or composer.
 * `floating` keeps the mobile placement above the bottom navigation.
 */
export type AnnouncementPlacement = "sidebar" | "floating";

export function AnnouncementWell({ health, placement = "floating" }: { health?: HealthStatus; placement?: AnnouncementPlacement }) {
  const { userId: accountId, settled } = useAccountIdentity();
  const { selectedCompanyId, loading } = useCompany();
  const { onboardingOpen } = useDialogState();
  const toastActions = useOptionalToastActions();
  const toasts = useOptionalToastState();
  const onboardingInProgress = useOnboardingInProgress(selectedCompanyId);
  const userId = health?.deploymentMode === "local_trusted" ? "local-board" : (settled ? accountId : null);
  const { announcement, dismiss } = useAnnouncement({
    userId, companyId: selectedCompanyId,
    enabled: Boolean(userId && !loading && selectedCompanyId && !onboardingOpen && !onboardingInProgress),
    onSaveFailure: (savedLocally) => toastActions?.pushToast({
      title: savedLocally ? "Dismissed in this browser" : "Dismissed for this visit",
      body: "Couldn’t save across devices. We’ll retry when you reconnect or return.",
      tone: "info", dedupeKey: "announcement-dismissal-sync",
    }),
  });
  const modalOpen = useModalOpen(Boolean(announcement));
  if (!announcement || modalOpen || (toasts?.length ?? 0) > 0) return null;
  return (
    <aside
      aria-label="Paperclip announcements"
      data-placement={placement}
      className={cn(
        "announcement-well",
        placement === "sidebar"
          ? "shrink-0 overflow-y-auto px-3 pb-2 max-h-(--announcement-sidebar-max-height)"
          : "fixed left-3 bottom-(--announcement-mobile-bottom) z-40 w-(--announcement-available-width) max-w-(--announcement-width) max-h-(--announcement-mobile-max-height) overflow-y-auto md:bottom-3 md:max-h-(--announcement-max-height)",
      )}
    >
      <AnnouncementCard key={announcement.id} announcement={announcement} onDismiss={() => dismiss(announcement.id)} />
    </aside>
  );
}
