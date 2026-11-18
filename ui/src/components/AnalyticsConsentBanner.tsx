import { useId } from "react";
import { Button } from "@/components/ui/button";

export const PRIVACY_POLICY_URL = "https://paperclip.ing/privacy/";

export function AnalyticsConsentBanner({
  recordings,
  onAccept,
  onDecline,
}: {
  recordings: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const textId = useId();
  return (
    <section
      aria-label="Analytics choice"
      aria-describedby={textId}
      className="fixed inset-x-4 bottom-(--sz-calc-14) z-40 mx-auto max-w-xl rounded-md border bg-popover text-popover-foreground shadow-lg md:bottom-4"
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <p id={textId} className="flex-1 text-sm text-muted-foreground">
          {recordings
            ? "Paperclip uses analytics and session recordings to improve the product. Recordings hide what you type and your messages, documents and connected accounts, but may show page names like task titles. "
            : "Paperclip uses analytics to improve the product. "}
          <a
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-4 hover:opacity-90"
          >
            Privacy policy
          </a>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDecline}>
            Decline
          </Button>
          <Button type="button" size="sm" onClick={onAccept}>
            Accept
          </Button>
        </div>
      </div>
    </section>
  );
}
