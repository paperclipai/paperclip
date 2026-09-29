import type { ReactNode } from "react";
import { useChatConnectorsEnabled } from "@/hooks/useChatConnectorsEnabled";
import { Navigate } from "@/lib/router";

export function ChatConnectorsExperimentalGate({
  children,
}: {
  children: ReactNode;
}) {
  const { enabled, loaded } = useChatConnectorsEnabled();
  if (!loaded) return null;
  if (!enabled) return <Navigate to="/apps" replace />;
  return <>{children}</>;
}
