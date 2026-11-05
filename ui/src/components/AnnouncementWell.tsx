import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useAccountIdentity } from "@/api/companies-query";
import type { HealthStatus } from "@/api/health";
import { useCompany } from "@/context/CompanyContext";
import { useDialogState } from "@/context/DialogContext";
import { useOptionalToastActions, useOptionalToastState } from "@/context/ToastContext";
import { useAnnouncement } from "@/hooks/useAnnouncement";
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

export function AnnouncementWell({ health }: { health?: HealthStatus }) {
  useTranslation("task-components");
  const { userId: accountId, settled } = useAccountIdentity();
  const { selectedCompanyId, loading } = useCompany();
  const { onboardingOpen } = useDialogState();
  const toastActions = useOptionalToastActions();
  const toasts = useOptionalToastState();
  const userId = health?.deploymentMode === "local_trusted" ? "local-board" : (settled ? accountId : null);
  const { announcement, dismiss } = useAnnouncement({
    userId, companyId: selectedCompanyId,
    enabled: Boolean(userId && !loading && selectedCompanyId && !onboardingOpen),
    onSaveFailure: (savedLocally) => toastActions?.pushToast({ presentation: { title: savedLocally ? { key: "final-components-a:dismissedInThisBrowser_eaa3e484" } : { key: "final-components-a:dismissedForThisVisit_4f556bd8" }, body: { key: "final-components-a:couldnTSaveAcrossDevices_0dee8850" } }, 
      title: savedLocally ? t("final-components-a:dismissedInThisBrowser_eaa3e484") : t("final-components-a:dismissedForThisVisit_4f556bd8"),
      body: t("final-components-a:couldnTSaveAcrossDevices_0dee8850"),
      tone: "info", dedupeKey: "announcement-dismissal-sync",
    }),
  });
  const modalOpen = useModalOpen(Boolean(announcement));
  if (!announcement || modalOpen || (toasts?.length ?? 0) > 0) return null;
  return (
    <aside aria-label={t("task-components:paperclipAnnouncements_0f9b3c82")} className="announcement-well fixed left-3 bottom-(--announcement-mobile-bottom) z-40 w-(--announcement-available-width) max-w-(--announcement-width) max-h-(--announcement-mobile-max-height) overflow-y-auto md:bottom-3 md:max-h-(--announcement-max-height)">
      <AnnouncementCard key={announcement.id} announcement={announcement} onDismiss={() => dismiss(announcement.id)} />
    </aside>
  );
}
