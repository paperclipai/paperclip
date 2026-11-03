import { useCallback, useRef, useState } from "react";
import type { ToolOAuthStartResult } from "@paperclipai/shared";
import { prepareOAuthNavigation, savePendingCloudHandoff } from "@/lib/oauthHandoff";
import { Button } from "@/components/ui/button";

/** Reserve during the click, before any request, and keep the connector page open. */
export function useAuthorizationWindow() {
  const popup = useRef<Window | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const reserve = useCallback(() => {
    setFallbackUrl(null);
    if (popup.current && !popup.current.closed) return;
    try {
      popup.current = window.open("about:blank", "_blank");
      if (popup.current) popup.current.opener = null;
    }
    catch { popup.current = null; }
  }, []);
  const cancel = useCallback(() => {
    popup.current?.close();
    popup.current = null;
    setFallbackUrl(null);
  }, []);
  const open = useCallback(async (start: string | Pick<ToolOAuthStartResult, "authorizationUrl" | "handoff">) => {
    try {
      const request = typeof start === "string" ? { authorizationUrl: start } : start;
      const target = await prepareOAuthNavigation(request);
      const destination = popup.current;
      if (target.kind === "reauthentication" && request.handoff) {
        if (!destination || destination.closed) throw new Error("Allow a sign-in window and try again to refresh your account.");
        savePendingCloudHandoff(request.handoff.session, destination.sessionStorage);
      }
      // Reauthentication requires the session already stored in this window.
      setFallbackUrl(target.kind === "authorization" ? target.url : null);
      if (destination && !destination.closed) {
        destination.location.assign(target.url);
        destination.focus();
      }
      return target;
    } catch (error) { cancel(); throw error; }
  }, [cancel]);
  const fallback = fallbackUrl ? <Button variant="outline" asChild>
    <a href={fallbackUrl} target="_blank" rel="noopener noreferrer">Open sign-in in a new tab</a>
  </Button> : null;
  return { reserve, open, cancel, fallback, windowRef: popup };
}
