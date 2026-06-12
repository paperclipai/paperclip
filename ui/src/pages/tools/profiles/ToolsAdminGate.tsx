import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";

/**
 * Best-effort admin gate for the access-profiles surface, mirroring
 * `AdvancedToolsRoute` (PAP-10862, plan D8). Instance admins and company
 * owners/admins pass; the server stays authoritative. Shared so the profiles
 * index and the create wizard guard identically.
 */
export function ToolsAdminGate({ children }: { children: ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });

  if (boardAccess.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading…</div>;
  }

  const data = boardAccess.data;
  const membership = data?.memberships?.find((m) => m.companyId === selectedCompanyId);
  const isAdmin =
    Boolean(data?.isInstanceAdmin) ||
    membership?.membershipRole === "owner" ||
    membership?.membershipRole === "admin";

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-foreground">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Access profiles are for administrators</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Access profiles decide which tools your agents can use. Ask an administrator to set these up, or
            head back to{" "}
            <Link to="/apps" className="font-medium text-primary hover:underline">
              your apps
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
