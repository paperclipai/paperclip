import { useAccountIdentity } from "@/api/companies-query";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useRecentTasks } from "@/hooks/useRecentTasks";
import { DesignSidebar } from "./DesignSidebar";

/** Data adapter only; the visual subject is Components / Sidebar. */
export function DesignSandboxSidebar() {
  const { selectedCompanyId } = useCompany();
  const { userId } = useAccountIdentity();
  const { openNewIssue } = useDialogActions();
  const { entries } = useRecentTasks({ companyId: selectedCompanyId, userId });
  return <DesignSidebar recentTasks={entries} onNewTask={() => openNewIssue()} />;
}
