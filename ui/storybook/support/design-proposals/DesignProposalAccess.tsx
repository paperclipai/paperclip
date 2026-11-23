import { useLayoutEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CurrentBoardAccess } from "@/api/access";
import type { HealthStatus } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAuthSession, storybookCompanies } from "../../fixtures/paperclipData";
import { installFixtureApi } from "../capability-gaps/api";

/** Supply the same owner access and loaded operator policy that production
 * menus require. This preview never bypasses their invitation gates. */
export function DesignProposalAccess({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const access: CurrentBoardAccess = {
      user: storybookAuthSession.user, userId: "user-board", isInstanceAdmin: false,
      companyIds: storybookCompanies.map(company => company.id), source: "authenticated", keyId: null,
      memberships: storybookCompanies.map(company => ({ companyId: company.id, membershipRole: "owner", status: "active" })),
    };
    const fixtures = installFixtureApi([{ path: "/api/cli-auth/me", read: () => access }]);
    client.setQueryData<HealthStatus>(queryKeys.health, { status: "ok", deploymentMode: "authenticated", hiddenSettings: [] });
    client.setQueryData<CurrentBoardAccess>(queryKeys.access.currentBoardAccess, access);
    setReady(true);
    return () => fixtures.cleanup();
  }, [client]);
  return ready ? children : null;
}
