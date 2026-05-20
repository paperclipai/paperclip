// LET-503 — Viewer role hook for EAOS chrome gating.
//
// Ordinary customer roles (member/viewer/no membership) must not see raw
// operator chrome: the legacy Kernel/Admin escape hatch, the audit/session
// footer breadcrumb, posture chips, or any operator-only affordance.
// Operator-class viewers (instance admin, company owner/admin/operator)
// keep that chrome so they can correlate sessions and drop into the
// kernel without searching for it.
//
// This hook is intentionally permissive while the access query is still
// loading — `isOperator` only flips to `true` once we have confirmed
// access data. That way customers don't briefly see a Kernel hatch flash
// on first paint.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useCompany } from "@/context/CompanyContext";
import { accessApi, type HumanCompanyRole } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";

const OPERATOR_MEMBERSHIP_ROLES: ReadonlySet<HumanCompanyRole> = new Set([
  "owner",
  "admin",
  "operator",
]);

export interface EaosViewerRole {
  readonly isOperator: boolean;
  readonly isInstanceAdmin: boolean;
  readonly membershipRole: HumanCompanyRole | "member" | null;
  readonly loading: boolean;
}

export function useEaosViewerRole(): EaosViewerRole {
  const { selectedCompanyId } = useCompany();
  const accessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    staleTime: 60_000,
  });

  return useMemo(() => {
    const access = accessQuery.data ?? null;
    const isInstanceAdmin = Boolean(access?.isInstanceAdmin);
    const membership = access?.memberships?.find((entry) => entry.companyId === selectedCompanyId) ?? null;
    const role = membership?.membershipRole ?? null;
    const isOperator = isInstanceAdmin || (role !== null && role !== "member" && OPERATOR_MEMBERSHIP_ROLES.has(role as HumanCompanyRole));
    return {
      isOperator,
      isInstanceAdmin,
      membershipRole: role,
      loading: accessQuery.isLoading,
    };
  }, [accessQuery.data, accessQuery.isLoading, selectedCompanyId]);
}
