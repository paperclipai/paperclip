import { useEffect, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";
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
const MODAL_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [aria-modal="true"]:not([data-state="closed"]), dialog[open]';
function useModalOpen(enabled: boolean) {
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
 * A new user's first session is the onboarding first task. Announcements wait
 * until that task is finished so they cannot cover its questions. Unknown
 * state (loading or a failed read) keeps the optional card hidden.
 */
function useOnboardingInProgress(companyId: string | null) {
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

const ACCOUNT_ROW_SELECTOR = "[data-sidebar-account]";
/**
 * Distance in CSS pixels from the viewport bottom to the top of the visible
 * sidebar account row, so the desktop well can sit above the account menu
 * trigger instead of covering it. Zero when no account row is on screen.
 */
function useAccountRowClearance(enabled: boolean) {
  const [clearance, setClearance] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const observed = new Set<Element>();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    function measure() {
      let next = 0;
      for (const row of document.querySelectorAll(ACCOUNT_ROW_SELECTOR)) {
        if (resizeObserver && !observed.has(row)) { observed.add(row); resizeObserver.observe(row); }
        const rect = row.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.left >= window.innerWidth) continue;
        next = Math.max(next, Math.ceil(window.innerHeight - rect.top));
      }
      setClearance(next);
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    measure();
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [enabled]);
  return clearance;
}

export function AnnouncementWell({ health }: { health?: HealthStatus }) {
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
  const accountClearance = useAccountRowClearance(Boolean(announcement));
  if (!announcement || modalOpen || (toasts?.length ?? 0) > 0) return null;
  return (
    <aside
      aria-label="Paperclip announcements"
      style={{ "--announcement-account-clearance": accountClearance } as CSSProperties}
      className="announcement-well fixed left-3 bottom-(--announcement-mobile-bottom) z-40 w-(--announcement-available-width) max-w-(--announcement-width) max-h-(--announcement-mobile-max-height) overflow-y-auto md:bottom-(--announcement-desktop-bottom) md:max-h-(--announcement-desktop-max-height)"
    >
      <AnnouncementCard key={announcement.id} announcement={announcement} onDismiss={() => dismiss(announcement.id)} />
    </aside>
  );
}
