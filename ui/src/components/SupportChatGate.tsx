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
import { useTheme } from "../context/ThemeContext";

// Cloud enablement is server-owned; self-hosted instances load no Plain script.
export function SupportChatGate() {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const userId = session?.user.id ?? null;

  const { data: config } = useQuery({
    queryKey: queryKeys.supportChat.session(userId ?? "signed-out"),
    queryFn: () => fetchSupportChatSession(),
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
