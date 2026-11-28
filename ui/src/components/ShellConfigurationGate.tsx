import { useLayoutEffect } from "react";
import { scheduleMainContentFocus } from "@/lib/main-content-focus";
import { Outlet, useLocation } from "@/lib/router";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

/** Keep shell selection stable while the independent access gate loads. */
export function ShellConfigurationGate({ loaded, allowPendingTaskDetail = false }: { loaded: boolean; allowPendingTaskDetail?: boolean }) {
  const { pathname } = useLocation();
  const segments = pathname.split("/").filter(Boolean);
  const isTaskDetail = segments.length === 3 && segments[1] === "issues"
    && !["all", "active", "backlog", "done", "recent"].includes(segments[2]!);
  useLayoutEffect(() => {
    if (!loaded) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    return scheduleMainContentFocus(document.getElementById("main-content"));
  }, [loaded]);
  const prepareOutlet = loaded || (allowPendingTaskDetail && isTaskDetail);
  return <>
    {!loaded ? <div data-testid="shell-configuration-loading"><PaperclipLoading /></div> : null}
    {prepareOutlet ? <div hidden={!loaded} inert={!loaded} aria-hidden={!loaded || undefined} className={loaded ? "contents" : "hidden"} data-testid="shell-prepared-outlet"><Outlet /></div> : null}
  </>;
}
