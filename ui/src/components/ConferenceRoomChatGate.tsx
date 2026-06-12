import { Navigate, Outlet } from "@/lib/router";
import { useConferenceRoomChatEnabled } from "@/hooks/useConferenceRoomChatEnabled";

/**
 * Layout route guard for Conference Room Chat surfaces (PAP-136 / PAP-137).
 *
 * The gated routes stay registered (matching the PAP-89 streamlined-nav
 * precedent: gating is presentation-only, no 404 flash); when the
 * experimental flag is off the element redirects to the company home
 * instead of rendering. While the flag is still loading nothing renders so
 * an enabled user is not bounced away by a premature redirect.
 */
export function ConferenceRoomChatGate() {
  const { enabled, loaded } = useConferenceRoomChatEnabled();
  if (!loaded) return null;
  if (!enabled) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}
