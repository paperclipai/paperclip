import { useTranslation } from "@/i18n";
import { useCallback, useEffect, useState } from "react";
import { Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { navigateTopLevel } from "@/lib/browserNavigation";
import {
  clearPendingCloudHandoff,
  prepareOAuthNavigation,
  readPendingCloudHandoff,
} from "@/lib/oauthHandoff";
import { describeError } from "@/api/errors";

export type ManagedOAuthHandoffPhase = "loading" | "reauthenticating" | "error";

export function ManagedOAuthHandoffState({
  phase,
  error,
  onRetry,
  onCancel,
}: {
  phase: ManagedOAuthHandoffPhase;
  error?: string | null;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("connections");
  const failed = phase === "error";
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="flex max-w-lg items-start gap-3">
        <span className="mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
          {failed ? (
            <Link2 className="h-5 w-5 text-destructive" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          )}
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight">
            {failed ? t("sign_in_couldn_t_continue_e986161") : t("preparing_secure_sign_in_fc861f2")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {failed
              ? error ?? t("paperclip_couldn_t_prepare_the_provider_sign_53b750a")
              : phase === "reauthenticating"
                ? t("your_paperclip_sign_in_is_being_refreshed_7fcdb20")
                : t("paperclip_is_opening_the_provider_securely_a44d5ce")}
          </p>
          {failed ? (
            <div className="mt-6 flex items-center gap-2">
              <Button type="button" onClick={onRetry}>{t("try_again_042c862")}</Button>
              <Button type="button" variant="ghost" onClick={onCancel}>{t("return_to_paperclip_39189ca")}</Button>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

/** Fixed tenant landing used only after Paperclip Cloud refreshes login. */
export function PaperclipCloudOAuthHandoffPage() {
  const { t } = useTranslation("connections");
  const [phase, setPhase] = useState<ManagedOAuthHandoffPhase>("loading");
  const [error, setError] = useState<string | null>(null);

  const resume = useCallback(async () => {
    const handoff = readPendingCloudHandoff();
    if (!handoff) {
      setPhase("error");
      setError(t("this_sign_in_expired_return_to_paperclip_c222785"));
      return;
    }
    setPhase("loading");
    setError(null);
    try {
      const target = await prepareOAuthNavigation({ authorizationUrl: "", handoff });
      if (target.kind === "reauthentication") {
        setPhase("error");
        setError(t("paperclip_couldn_t_refresh_this_sign_in_2c2a8a6"));
        return;
      }
      clearPendingCloudHandoff();
      navigateTopLevel(target.url);
    } catch (caught) {
      setPhase("error");
      setError(describeError(caught).body);
    }
  }, [t]);

  useEffect(() => {
    void resume();
  }, [resume]);

  return (
    <ManagedOAuthHandoffState
      phase={phase}
      error={error}
      onRetry={() => void resume()}
      onCancel={() => {
        clearPendingCloudHandoff();
        navigateTopLevel("/");
      }}
    />
  );
}
