import type { ReactNode } from "react";
import { Loader2, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { BOOTSTRAP_FALLBACK_COMMAND } from "@/bootstrapSetup";
import type { AuthSession } from "@paperclipai/shared";
import { t, useTranslation } from "@/i18n";

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
        <span>
          {t("components.bootstrapPendingPage.cliFallbackPrompt", {
            defaultValue: "Prefer to finish setup from the host?",
          })}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasActiveInvite
          ? t("components.bootstrapPendingPage.cliFallbackActiveInvite", {
              defaultValue:
                "A bootstrap invite is already active. Check your Paperclip startup logs for the first-admin URL, or run this command on the host to rotate it:",
            })
          : t("components.bootstrapPendingPage.cliFallbackRunCommand", {
              defaultValue:
                "Run this command on the host that runs Paperclip to print a one-time first-admin invite URL:",
            })}
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

function claimErrorCopy(error: BootstrapPendingPageProps["claimError"]) {
  if (error?.status === 409) {
    return {
      title: t("components.bootstrapPendingPage.claimError409Title", {
        defaultValue: "Someone else has already claimed this instance.",
      }),
      body: t("components.bootstrapPendingPage.claimError409Body", {
        defaultValue:
          "Refresh to sign in, or ask the existing admin to invite you from Instance settings -> Access.",
      }),
    };
  }
  if (error?.status === 401) {
    return {
      title: t("components.bootstrapPendingPage.claimError401Title", {
        defaultValue: "Your session expired. Sign in again to claim this instance.",
      }),
      body: "",
    };
  }
  return {
    title: t("components.bootstrapPendingPage.claimErrorDefaultTitle", {
      defaultValue: "We couldn't reach the server. Try again in a moment.",
    }),
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
        <h1 className="text-xl font-semibold">
          {t("components.bootstrapPendingPage.waitingTitle", {
            defaultValue: "This Paperclip is waiting on its first admin",
          })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("components.bootstrapPendingPage.waitingDescription", {
            defaultValue:
              "This instance runs in invite-only mode. The operator must generate a one-time first-admin invite URL from the host. Once you have the link, open it from this browser to finish setup.",
          })}
        </p>
        <CliFallback hasActiveInvite={hasActiveInvite} />
        <p className="mt-4 text-xs text-muted-foreground">
          {t("components.bootstrapPendingPage.waitingPublicModeNote", {
            defaultValue:
              "Browser-based claim is intentionally disabled in public mode so anyone on the network can't promote themselves.",
          })}
        </p>
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
            <h1 className="text-xl font-semibold">
              {t("components.bootstrapPendingPage.successTitle", {
                defaultValue: "You're the instance admin",
              })}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("components.bootstrapPendingPage.successDescription", {
                defaultValue:
                  "Setup is complete. Taking you to onboarding to create your first company...",
              })}
            </p>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-3">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <span className="text-sm text-muted-foreground">
            {t("components.bootstrapPendingPage.redirecting", { defaultValue: "Redirecting..." })}
          </span>
        </div>
        <div className="mt-5">
          <Button asChild variant="outline">
            <a href="/">
              {t("components.bootstrapPendingPage.continueToDashboard", {
                defaultValue: "Continue to dashboard",
              })}
            </a>
          </Button>
        </div>
      </StateChrome>
    );
  }

  if (!session) {
    return (
      <StateChrome>
        <h1 className="text-xl font-semibold">
          {t("components.bootstrapPendingPage.finishSetupTitle", {
            defaultValue: "Finish setting up this Paperclip",
          })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("components.bootstrapPendingPage.finishSetupSignInDescription", {
            defaultValue:
              "No admin has claimed this instance yet. Sign in or create your Paperclip account to become the first admin from this browser.",
          })}
        </p>
        <div className="mt-5">
          <Button asChild>
            <Link to="/auth?next=/">
              {t("components.bootstrapPendingPage.signInCreateAccount", {
                defaultValue: "Sign in / Create account",
              })}
            </Link>
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
      <h1 className="text-xl font-semibold">
        {t("components.bootstrapPendingPage.finishSetupTitle", {
          defaultValue: "Finish setting up this Paperclip",
        })}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("components.bootstrapPendingPage.finishSetupClaimDescription", {
          defaultValue:
            "No admin has claimed this instance yet. Claim it now to become the first admin and start onboarding.",
        })}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={onClaim} disabled={isClaiming}>
          {isClaiming && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
          {isClaiming
            ? t("components.bootstrapPendingPage.claiming", { defaultValue: "Claiming..." })
            : t("components.bootstrapPendingPage.claimInstance", {
                defaultValue: "Claim this instance",
              })}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t("components.bootstrapPendingPage.signedInAs", { defaultValue: "Signed in as" })}{" "}
          <span className="font-medium text-foreground">{displayIdentity(session)}</span>
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {t("components.bootstrapPendingPage.wrongAccount", { defaultValue: "Wrong account?" })}{" "}
        <Link to="/auth?next=/" className="underline underline-offset-2">
          {t("components.bootstrapPendingPage.switchAccount", { defaultValue: "Switch account" })}
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
