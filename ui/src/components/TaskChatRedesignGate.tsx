import { Navigate, Outlet } from "@/lib/router";
import { useTaskChatRedesignEnabled } from "@/hooks/useTaskChatRedesignEnabled";

/**
 * Layout route guard for Task Chat Redesign dev surfaces (e.g. the
 * /dev/task-chat-lab harness).
 *
 * The gated routes stay registered (gating is presentation-only, no 404
 * flash); when the experimental flag is off the element redirects to the
 * company home instead of rendering. While the flag is still loading nothing
 * renders so an enabled user is not bounced away by a premature redirect.
 */
export function TaskChatRedesignGate() {
  const { enabled, loaded } = useTaskChatRedesignEnabled();
  if (!loaded) return null;
  if (!enabled) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}
