import { useId } from "react";
import { ChartNoAxesColumn } from "lucide-react";
import type { BrowserAnalyticsConfig } from "@paperclipai/shared";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { browserBlocksAnalytics, storeAnalyticsChoice, useAnalyticsConsent } from "@/lib/analytics/consent";
import { PRIVACY_POLICY_URL } from "./AnalyticsConsentBanner";

export function ProductAnalyticsSetting({ config }: { config: BrowserAnalyticsConfig | null | undefined }) {
  const consent = useAnalyticsConsent(config ?? null);
  const labelId = useId();
  const descriptionId = useId();
  if (!config || !consent) return null;
  const blocked = browserBlocksAnalytics(config);
  return (
    <section className="space-y-4" aria-labelledby={labelId}>
      <div className="flex max-w-2xl items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ChartNoAxesColumn className="h-5 w-5 text-muted-foreground" />
            <h2 id={labelId} className="text-base font-semibold">Product analytics</h2>
          </div>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {config.replayEnabled
              ? "Share usage analytics and session recordings from this browser to help improve Paperclip. Recordings hide what you type and your messages, documents and connected accounts, but may show page names like task titles. "
              : "Share usage analytics from this browser to help improve Paperclip. "}
            {blocked ? "Your browser asks sites not to track you, so analytics stays off. " : null}
            <a
              href={PRIVACY_POLICY_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-4 hover:opacity-90"
            >
              Privacy policy
            </a>
          </p>
        </div>
        <ToggleSwitch
          checked={consent === "granted"}
          disabled={blocked}
          onCheckedChange={(checked) => storeAnalyticsChoice(checked ? "granted" : "denied")}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
        />
      </div>
    </section>
  );
}
