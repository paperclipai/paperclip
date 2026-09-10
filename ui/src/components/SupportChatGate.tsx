import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { fetchSupportChatSession } from "@/api/supportChat";
import { queryKeys } from "@/lib/queryKeys";
import {
  hideSupportChat,
  mountSupportChat,
  updateSupportChatTheme,
} from "@/lib/plain-chat";
import { useOptionalCompany } from "../context/CompanyContext";
import { useTheme } from "../context/ThemeContext";

/**
 * Opens the Plain support chat gate for a signed-in board user. Renders
 * nothing.
 *
 * The server owns enablement: `GET /api/support-chat/session` answers 404 on
 * every instance that does not serve the Cloud support surface, so a
 * self-hosted browser never loads Plain's script and keeps the existing flag
 * feedback entry point (see `SidebarAccountMenu`, which watches the widget
 * status from `@/lib/plain-chat`).
 *
 * The session query drives lifecycle, and it separates identity from context:
 *
 * - **Identity** (account + attestation mode) mounts the widget once per page
 *   lifetime. Sign-out clears account-scoped query caches (`useSignOut`),
 *   which drops the support-chat entry, and the mount effect's cleanup hides
 *   the launcher on that same pass. On Cloud, sign-out is a top-level
 *   navigation, so the whole document — widget included — unloads.
 * - **Context** (selected company, theme) updates the mounted widget in place
 *   via `Plain.update`; switching companies re-asks the server (which
 *   validates membership) and re-points *new* threads at that company's
 *   tenant after temporarily hiding chat while the new context is loading.
 */
export function SupportChatGate() {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const userId = session?.user.id ?? null;

  // Rendered above CompanyProvider in some surfaces (tests, standalone
  // pages): no provider just means no company context, never a crash.
  const companyContext = useOptionalCompany();
  const selectedCompanyId = companyContext?.selectedCompanyId ?? null;

  const { data: config } = useQuery({
    queryKey: queryKeys.supportChat.session(userId ?? "signed-out", selectedCompanyId ?? "none"),
    queryFn: () => fetchSupportChatSession(selectedCompanyId),
    enabled: !!userId,
    retry: false,
    // The payload carries a bearer-grade identity hash: keep it out of the
    // background-refetch churn and drop it as soon as the observer unmounts.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,

  });

  const { theme } = useTheme();
  useEffect(() => {
    if (!userId || !config) return;
    void mountSupportChat({
      appId: config.appId,
      theme,
      customer: config.customer,
      tenantId: config.company?.tenantId ?? null,
      identityKey: `${userId}:${config.customer ? "verified" : "anonymous"}`,
    });
    return () => { void hideSupportChat(); };
    // Theme changes use the separate update effect and must not close chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, config]);

  useEffect(() => {
    void updateSupportChatTheme(theme);
  }, [theme]);

  return null;
}
