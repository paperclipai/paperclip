import { Outlet, useLocation } from "@/lib/router";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

/** Keep shell selection stable while the independent access gate loads. */
export function ShellConfigurationGate({ loaded, allowPendingTaskDetail = false }: { loaded: boolean; allowPendingTaskDetail?: boolean }) {
  const { pathname } = useLocation();
  const segments = pathname.split("/").filter(Boolean);
  const isTaskDetail = segments.length === 3 && segments[1] === "issues"
    && !["all", "active", "backlog", "done", "recent"].includes(segments[2]!);
  // Task detail owns a second presentation gate. It can show its account-bound
  // title editor while identity loads, without exposing variant-specific tools.
  return loaded || (allowPendingTaskDetail && isTaskDetail) ? <Outlet /> : <PaperclipLoading />;
}
