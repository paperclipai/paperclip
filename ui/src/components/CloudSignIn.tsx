import { t, useTranslation } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import type { CloudInstanceHealthStatus } from "@/api/health";
import { cloudStackEntryUrl } from "@/lib/cloudLinks";
import { beginCloudSignIn, clearCloudSignInAttempt } from "@/lib/cloud-sign-in";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { Button } from "@/components/ui/button";

export function CloudSignIn({ cloud, returnTo }: { cloud: CloudInstanceHealthStatus; returnTo: string }) {
  useTranslation("task-components");
  const entryUrl = cloudStackEntryUrl(cloud.cloudBaseUrl, cloud.stackSlug, returnTo);
  const started = useRef(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!entryUrl || started.current) return;
    started.current = true;
    setBlocked(!beginCloudSignIn(entryUrl));
  }, [entryUrl]);

  if (entryUrl && !blocked) return <PaperclipLoading />;

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("task-components:signInToPaperclipCloud_64837fa1")}</h1>
      <p role="alert" className="text-sm text-muted-foreground">
        {entryUrl
          ? t("task-components:weCouldnTRestoreYourSessionContinue_9c9ff4b9")
          : t("task-components:cloudSignInIsUnavailableForThis_7fcc00af")}
      </p>
      {entryUrl && (
        <Button asChild>
          <a href={entryUrl} onClick={clearCloudSignInAttempt}>{t("task-components:continueToPaperclipCloud_1e94a732")}</a>
        </Button>
      )}
    </div>
  );
}
