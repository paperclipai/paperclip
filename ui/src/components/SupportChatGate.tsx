import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { fetchSupportChatSession } from "@/api/supportChat";
import { queryKeys } from "@/lib/queryKeys";
import {
  hideSupportChat,
  mountSupportChat,
  updateSupportChatCompany,
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
 *   tenant without closing an open chat panel.
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
    // A company switch changes the query key; holding the previous entry over
    // the refetch keeps the mounted widget from tearing down and closing an
    // open panel mid-switch. Only for the same account — an account switch
    // must never see the previous account's payload, not even as placeholder.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[2] === userId ? previousData : undefined,
  });

  const { theme } = useTheme();
  // The mount effect intentionally re-runs only when identity changes; it
  // reads everything else (theme, full config) from refs at mount time, and
  // the dedicated context effects below keep a mounted widget in step.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const configRef = useRef(config);
  configRef.current = config;

  const appId = config?.appId ?? null;
  // One key per account and attestation mode: a verified-identity mount never
  // silently degrades to an anonymous one (or vice versa) without a fresh
  // page. Company selection is deliberately absent — it is context, and must
  // not remount (and thereby close) an active chat.
  const identityKey = config ? `${userId}:${config.customer ? "verified" : "anonymous"}` : null;

  useEffect(() => {
    if (!userId || !appId || !identityKey) return;
    const current = configRef.current;
    if (!current) return;
    void mountSupportChat({
      appId,
      theme: themeRef.current,
      customer: current.customer,
      tenantId: current.company?.tenantId ?? null,
      identityKey,
    });
    return () => {
      void hideSupportChat();
    };
  }, [userId, appId, identityKey]);

  // Keyed on the tenant id, not the config object: a refetch that lands on
  // the same tenant re-applies nothing, and before the widget mounts the
  // update is a queue-ordered no-op (the mount itself carries the initial
  // context from `configRef`).
  const tenantId = config?.company?.tenantId ?? null;
  useEffect(() => {
    void updateSupportChatCompany(tenantId);
  }, [tenantId]);

  useEffect(() => {
    void updateSupportChatTheme(theme);
  }, [theme]);

  return null;
}
