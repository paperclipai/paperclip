import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { fetchSupportChatSession } from "@/api/supportChat";
import { queryKeys } from "@/lib/queryKeys";
import {
  hideSupportChat,
  mountSupportChat,
  updateSupportChatTheme,
} from "@/lib/plain-chat";
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
 * The session query drives lifecycle: sign-out clears account-scoped query
 * caches (`useSignOut`), which drops the support-chat entry, and the effect
 * below hides the launcher on that same pass. On Cloud, sign-out is a
 * top-level navigation, so the whole document — widget included — unloads.
 */
export function SupportChatGate() {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const userId = session?.user.id ?? null;

  const { data: config } = useQuery({
    queryKey: queryKeys.supportChat.session(userId ?? "signed-out"),
    queryFn: fetchSupportChatSession,
    enabled: !!userId,
    retry: false,
    // The payload carries a bearer-grade identity hash: keep it out of the
    // background-refetch churn and drop it as soon as the observer unmounts.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const { theme } = useTheme();
  // The mount effect reads the theme at mount time without re-running on
  // theme changes — a dedicated effect below keeps a mounted widget in step.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    if (!userId || !config) return;
    void mountSupportChat({
      appId: config.appId,
      theme: themeRef.current,
      customer: config.customer,
      // One key per account and attestation mode: a verified-identity mount
      // never silently degrades to an anonymous one (or vice versa) without
      // a fresh page.
      identityKey: `${userId}:${config.customer ? "verified" : "anonymous"}`,
    });
    return () => {
      void hideSupportChat();
    };
  }, [userId, config]);

  useEffect(() => {
    void updateSupportChatTheme(theme);
  }, [theme]);

  return null;
}
