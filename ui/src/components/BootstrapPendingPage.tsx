import { t, useTranslation, Trans } from "@/i18n";
import type { ReactNode } from "react";
import { Loader2, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { BOOTSTRAP_FALLBACK_COMMAND } from "@/bootstrapSetup";
import type { AuthSession } from "@paperclipai/shared";
import { Card } from "@/components/ui/card";

type BootstrapPendingPageProps = {
  claimAvailable: boolean;
  hasActiveInvite?: boolean;
  session: AuthSession | null | undefined;
  claimState: "idle" | "claiming" | "success";
  claimError?: { status?: number; message?: string } | null;
  onClaim: () => void;
};

function CliFallback({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  useTranslation("task-components");
  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Terminal className="size-4 text-muted-foreground" aria-hidden />
        <span>{t("task-components:preferToFinishSetupFromTheHost_d29e5c6f")}</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasActiveInvite
          ? t("task-components:aBootstrapInviteIsAlreadyActiveCheck_3c8fb492")
          : t("task-components:runThisCommandOnTheHostThat_ca2f606a")}
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
{BOOTSTRAP_FALLBACK_COMMAND}
      </pre>
    </div>
  );
}

function StateChrome({ children }: { children: ReactNode }) {
  useTranslation("task-components");
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">{children}</Card>
    </div>
  );
}

function displayIdentity(session: AuthSession) {
  return session.user.email || session.user.name || session.user.id;
}

function claimErrorCopy(error: BootstrapPendingPageProps["claimError"]) {
  if (error?.status === 409) {
    return {
      title: t("task-components:someoneElseHasAlreadyClaimedThisInstance_e9efa2de"),
      body: t("final-components-a:refreshToSignInOr_3a564548"),
    };
  }
  if (error?.status === 401) {
    return {
      title: t("task-components:yourSessionExpiredSignInAgainTo_7c6edab3"),
      body: "",
    };
  }
  return {
    title: t("task-components:weCouldnTReachTheServerTry_2fca89bf"),
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
  useTranslation("task-components");
  if (!claimAvailable) {
    return (
      <StateChrome>
        <h1 className="text-xl font-semibold">{t("task-components:thisPaperclipIsWaitingOnItsFirst_fe4cc591")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("task-components:thisInstanceRunsInInviteOnlyMode_b781534e")}</p>
        <CliFallback hasActiveInvite={hasActiveInvite} />
        <p className="mt-4 text-xs text-muted-foreground">{t("task-components:browserBasedClaimIsIntentionallyDisabledIn_bbdfcda4")}</p>
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
            <h1 className="text-xl font-semibold">{t("task-components:youReTheInstanceAdmin_7b0496df")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("task-components:setupIsCompleteTakingYouToOnboarding_6e267116")}</p>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-3">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <span className="text-sm text-muted-foreground">{t("task-components:redirecting_cd23991b")}</span>
        </div>
        <div className="mt-5">
          <Button asChild variant="outline">
            <a href="/">{t("task-components:continueToDashboard_740e1ec1")}</a>
          </Button>
        </div>
      </StateChrome>
    );
  }

  if (!session) {
    return (
      <StateChrome>
        <h1 className="text-xl font-semibold">{t("task-components:finishSettingUpThisPaperclip_fd728e25")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("task-components:noAdminHasClaimedThisInstanceYet_dcabbf1b")}</p>
        <div className="mt-5">
          <Button asChild>
            <Link to="/auth?next=/">{t("task-components:signInCreateAccount_5d4f5eb1")}</Link>
          </Button>
        </div>
        <CliFallback hasActiveInvite={hasActiveInvite} />
      </StateChrome>
    );
  }

  const errorCopy = claimErrorCopy(claimError);
  const isClaiming = claimState === "claiming";
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("task-components:finishSettingUpThisPaperclip_fd728e25")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("task-components:noAdminHasClaimedThisInstanceYet_c5c1f5e4")}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={onClaim} disabled={isClaiming}>
          {isClaiming && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
          {isClaiming ? t("task-components:claiming_a07badb5") : t("task-components:claimThisInstance_b7c7de5d")}
        </Button>
        <span className="text-sm text-muted-foreground">{t("task-components:signedInAs_abc50e33")}{" "}<span className="font-medium text-foreground">{displayIdentity(session)}</span>
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_27debccaca16" components={{ part1: <>{<Link to="/auth?next=/" className="underline underline-offset-2">{t("task-components:switchAccount_fedce010")}</Link>}</> }} /></p>
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
