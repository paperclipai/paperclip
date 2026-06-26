import type { ReactNode } from "react";
import { Loader2, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { BOOTSTRAP_FALLBACK_COMMAND } from "@/bootstrapSetup";
import { useTranslation } from "@/i18n";
import type { AuthSession } from "@paperclipai/shared";

type BootstrapPendingPageProps = {
  claimAvailable: boolean;
  hasActiveInvite?: boolean;
  session: AuthSession | null | undefined;
  claimState: "idle" | "claiming" | "success";
  claimError?: { status?: number; message?: string } | null;
  onClaim: () => void;
};

function CliFallback({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Terminal className="size-4 text-muted-foreground" aria-hidden />
        <span>{t("bootstrap.cliFallback.title")}</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasActiveInvite ? t("bootstrap.cliFallback.inviteActive") : t("bootstrap.cliFallback.command")}
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
{BOOTSTRAP_FALLBACK_COMMAND}
      </pre>
    </div>
  );
}

function StateChrome({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">{children}</div>
    </div>
  );
}

function displayIdentity(session: AuthSession) {
  return session.user.email || session.user.name || session.user.id;
}

function claimErrorCopy(
  error: BootstrapPendingPageProps["claimError"],
  t: (key: string) => string,
): { title: string; body: string } {
  if (error?.status === 409) {
    return {
      title: t("bootstrap.error.claimedTitle"),
      body: t("bootstrap.error.claimedBody"),
    };
  }
  if (error?.status === 401) {
    return {
      title: t("bootstrap.error.sessionExpiredTitle"),
      body: "",
    };
  }
  return {
    title: t("bootstrap.error.networkTitle"),
    body: "",
  };
}

export function BootstrapPendingPage({
  claimAvailable,
  hasActiveInvite = false,
  session,
  claimState,
  claimError,
  onClaim,
}: BootstrapPendingPageProps) {
  const { t } = useTranslation();

  if (!claimAvailable) {
    return (
      <StateChrome>
        <h1 className="text-xl font-semibold">{t("bootstrap.waiting.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("bootstrap.waiting.body")}</p>
        <CliFallback hasActiveInvite={hasActiveInvite} />
        <p className="mt-4 text-xs text-muted-foreground">{t("bootstrap.waiting.publicNote")}</p>
      </StateChrome>
    );
  }

  if (claimState === "success") {
    return (
      <StateChrome>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="size-5" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{t("bootstrap.success.title")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("bootstrap.success.body")}</p>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-3">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <span className="text-sm text-muted-foreground">{t("bootstrap.success.redirecting")}</span>
        </div>
        <div className="mt-5">
          <Button asChild variant="outline">
            <a href="/">{t("bootstrap.success.continue")}</a>
          </Button>
        </div>
      </StateChrome>
    );
  }

  if (!session) {
    return (
      <StateChrome>
        <h1 className="text-xl font-semibold">{t("bootstrap.setup.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("bootstrap.setup.signedOutBody")}</p>
        <div className="mt-5">
          <Button asChild>
            <Link to="/auth?next=/">{t("bootstrap.setup.signIn")}</Link>
          </Button>
        </div>
        <CliFallback hasActiveInvite={hasActiveInvite} />
      </StateChrome>
    );
  }

  const errorCopy = claimErrorCopy(claimError, t);
  const isClaiming = claimState === "claiming";
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("bootstrap.setup.title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("bootstrap.setup.signedInBody")}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={onClaim} disabled={isClaiming}>
          {isClaiming && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
          {isClaiming ? t("bootstrap.setup.claiming") : t("bootstrap.setup.claim")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t("bootstrap.setup.signedInAs", { identity: displayIdentity(session) })}
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {t("bootstrap.setup.wrongAccount")}{" "}
        <Link to="/auth?next=/" className="underline underline-offset-2">
          {t("bootstrap.setup.switchAccount")}
        </Link>
        .
      </p>
      {claimError && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 flex-shrink-0" aria-hidden />
          <div>
            <p className="font-medium">{errorCopy.title}</p>
            {errorCopy.body && <p className="mt-1 text-destructive/90">{errorCopy.body}</p>}
          </div>
        </div>
      )}
      <CliFallback hasActiveInvite={hasActiveInvite} />
    </StateChrome>
  );
}
