import { useAccountIdentity } from "@/api/companies-query";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useRecentItemsLimit } from "@/hooks/useRecentItemsLimit";
import { useRecentTasks } from "@/hooks/useRecentTasks";
import { useRecentTaskOpenWarmup } from "@/hooks/useRecentTaskOpenWarmup";
import { DesignSidebar } from "./DesignSidebar";

/** Data adapter only; the visual subject is Components / Sidebar. */
export function DesignSandboxSidebar() {
  const { selectedCompanyId } = useCompany();
  const { userId } = useAccountIdentity();
  const { openNewIssue } = useDialogActions();
  const { limit } = useRecentItemsLimit(userId);
  const { entries } = useRecentTasks({ companyId: selectedCompanyId, userId, limit });
  useRecentTaskOpenWarmup({ companyId: selectedCompanyId, userId, tasks: entries });
  return <DesignSidebar recentTasks={entries} onNewTask={() => openNewIssue()} />;
}
