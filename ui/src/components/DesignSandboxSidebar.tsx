import { useAccountIdentity } from "@/api/companies-query";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useRecentItemsLimit } from "@/hooks/useRecentItemsLimit";
import { useRecentTasks } from "@/hooks/useRecentTasks";
import { useRecentTaskOpenWarmup } from "@/hooks/useRecentTaskOpenWarmup";
import { QueryErrorState } from "./QueryView";
import { DesignSidebar } from "./DesignSidebar";

/** Data adapter only; the visual subject is Components / Sidebar. */
export function DesignSandboxSidebar() {
  const { selectedCompanyId } = useCompany();
  const { userId } = useAccountIdentity();
  const { openNewIssue } = useDialogActions();
  const recentPreference = useRecentItemsLimit(userId);
  const limit = recentPreference.limit;
  const { entries } = useRecentTasks({ companyId: selectedCompanyId, userId, limit });
  useRecentTaskOpenWarmup({ companyId: selectedCompanyId, userId, tasks: entries });
  return <DesignSidebar recentError={recentPreference.error && !recentPreference.loaded ? <QueryErrorState size="inline" className="px-4 py-2" error={recentPreference.error} action="load Recents" onRetry={() => void recentPreference.retry()} retrying={recentPreference.isFetching} /> : undefined} recentTasks={entries} onNewTask={() => openNewIssue()} />;
}
