import { useEffect, useState } from "react";
import { ANNOUNCEMENT_ANIMATION_CSP, type Announcement } from "@paperclipai/shared";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export function useAnnouncementAnimation(announcement: Announcement, previewSrc?: string) {
  const reducedMotion = usePrefersReducedMotion();
  const src = previewSrc ?? `/api/announcements/${encodeURIComponent(announcement.id)}/animation`;
  const key = `${src}:${announcement.animation?.path ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; document: string } | null>(null);
  const enabled = Boolean(announcement.animation) && !reducedMotion;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    void (async () => {
      try {
        const response = await fetch(src, {
          credentials: "same-origin", cache: "no-store", redirect: "error",
          referrerPolicy: "no-referrer", signal: controller.signal,
        });
        if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "text/html") return;
        const html = await response.text();
        if (!controller.signal.aborted) {
          // srcdoc does not inherit the fetch response's CSP. Apply its
          // resource restrictions again, alongside the iframe's empty sandbox.
          setLoaded({ key, document: `<meta http-equiv="Content-Security-Policy" content="${ANNOUNCEMENT_ANIMATION_CSP}">${html}` });
        }
      } catch { /* The static image stays visible, with no error popup. */ }
      finally { clearTimeout(timeout); }
    })();
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [enabled, key, src]);

  return enabled && loaded?.key === key ? loaded.document : null;
}
