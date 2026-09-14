import type { ReactElement, ReactNode } from "react";
import { Loader2, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { BOOTSTRAP_FALLBACK_COMMAND } from "@/bootstrapSetup";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { t } from "@/i18n";

type LabFixtureKey =
  | "signed-out-private"
  | "signed-in-private"
  | "claiming"
  | "claim-error"
  | "claim-success"
  | "public-invite-only";

const FIXTURE_LABELS: Record<LabFixtureKey, string> = {
  "signed-out-private": "1 · authenticated/private — signed out (browser claim available)",
  "signed-in-private": "2 · authenticated/private — signed in (claim CTA primary)",
  claiming: "3 · authenticated/private — claim in flight",
  "claim-error": "4 · authenticated/private — claim error (e.g. 409 already claimed)",
  "claim-success": "5 · authenticated/private — claim succeeded, redirect pending",
  "public-invite-only": "6 · authenticated/public — invite-only (no browser claim)",
};

const FIXTURE_ORDER: LabFixtureKey[] = [
  "signed-out-private",
  "signed-in-private",
  "claiming",
  "claim-error",
  "claim-success",
  "public-invite-only",
];

function CliFallback({ hasActiveInvite }: { hasActiveInvite: boolean }) {
  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Terminal className="size-4 text-muted-foreground" aria-hidden />
        <span>{t("bootstrap-setup-ux-lab.prefer-to-finish-setup-from-the-host-15n")}</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasActiveInvite
          ? "A bootstrap invite is already active. Check your Paperclip startup logs for the first‑admin URL, or run this command on the host to rotate it:"
          : "Run this command on the host that runs Paperclip to print a one‑time first‑admin invite URL:"}
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
      <Card className="block p-6">{children}</Card>
    </div>
  );
}

function SignedOutPrivate() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("bootstrap-setup-ux-lab.finish-setting-up-this-paperclip-19v")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("bootstrap-setup-ux-lab.no-admin-has-claimed-this-instance-y-93q")}
      </p>
      <div className="mt-5">
        <Button asChild>
          <a href="/auth?next=/">{t("bootstrap-setup-ux-lab.sign-in-create-account-1cr")}</a>
        </Button>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function SignedInPrivate() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("bootstrap-setup-ux-lab.finish-setting-up-this-paperclip-19v")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("bootstrap-setup-ux-lab.no-admin-has-claimed-this-instance-y-12t")}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button>{t("bootstrap-setup-ux-lab.claim-this-instance-1qu")}</Button>
        <span className="text-sm text-muted-foreground">
          {t("bootstrap-setup-ux-lab.signed-in-as-pgo")} <span className="font-medium text-foreground">jane@appliance.local</span>
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {t("bootstrap-setup-ux-lab.wrong-account-12h")}{" "}
        <a href="/auth?next=/" className="underline underline-offset-2">
          {t("bootstrap-setup-ux-lab.switch-account-9s6")}
        </a>
        .
      </p>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimingPrivate() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("bootstrap-setup-ux-lab.finish-setting-up-this-paperclip-19v")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("bootstrap-setup-ux-lab.no-admin-has-claimed-this-instance-y-12t")}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button disabled>
          <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
          {t("bootstrap-setup-ux-lab.claiming-11c")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t("bootstrap-setup-ux-lab.signed-in-as-pgo")} <span className="font-medium text-foreground">jane@appliance.local</span>
        </span>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimErrorPrivate() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("bootstrap-setup-ux-lab.finish-setting-up-this-paperclip-19v")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("bootstrap-setup-ux-lab.no-admin-has-claimed-this-instance-y-12t")}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button>{t("bootstrap-setup-ux-lab.claim-this-instance-1qu")}</Button>
        <span className="text-sm text-muted-foreground">
          {t("bootstrap-setup-ux-lab.signed-in-as-pgo")} <span className="font-medium text-foreground">jane@appliance.local</span>
        </span>
      </div>
      <div
        role="alert"
        className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-4 flex-shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{t("bootstrap-setup-ux-lab.someone-else-has-already-claimed-thi-1mp")}</p>
          <p className="mt-1 text-destructive/90">
            {t("bootstrap-setup-ux-lab.refresh-to-sign-in-or-ask-the-existi-1l9")}{" "}
            <span className="font-mono">{t("bootstrap-setup-ux-lab.settings-access-ug2")}</span>.
          </p>
        </div>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimSuccess() {
  return (
    <StateChrome>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold">{t("bootstrap-setup-ux-lab.you-re-the-instance-admin-1c1")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("bootstrap-setup-ux-lab.setup-is-complete-taking-you-to-onbo-1au")}
          </p>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        <span className="text-sm text-muted-foreground">{t("bootstrap-setup-ux-lab.redirecting-1ik")}</span>
      </div>
      <div className="mt-5">
        <Button asChild variant="outline">
          <a href="/">{t("bootstrap-setup-ux-lab.continue-to-dashboard-t7e")}</a>
        </Button>
      </div>
    </StateChrome>
  );
}

function PublicInviteOnly() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{t("bootstrap-setup-ux-lab.this-paperclip-is-waiting-on-its-fir-17l")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("bootstrap-setup-ux-lab.this-instance-runs-in-invite-only-mo-13j")}
      </p>
      <CliFallback hasActiveInvite />
      <p className="mt-4 text-xs text-muted-foreground">
        {t("bootstrap-setup-ux-lab.browser-based-claim-is-intentionally-1cb")}
      </p>
    </StateChrome>
  );
}

const FIXTURE_BODIES: Record<LabFixtureKey, ReactElement> = {
  "signed-out-private": <SignedOutPrivate />,
  "signed-in-private": <SignedInPrivate />,
  claiming: <ClaimingPrivate />,
  "claim-error": <ClaimErrorPrivate />,
  "claim-success": <ClaimSuccess />,
  "public-invite-only": <PublicInviteOnly />,
};

export function BootstrapSetupUxLab() {
  return (
    <div className="bg-background min-h-screen pb-16">
      <header className="border-b border-border bg-muted/20">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("bootstrap-setup-ux-lab.ux-lab-his")}</p>
          <h1 className="mt-1 text-2xl font-semibold">{t("bootstrap-setup-ux-lab.bootstrap-pending-setup-states-ite")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {t("bootstrap-setup-ux-lab.fixtures-for-the-bootstrap-pending-s-1i7")} <span className="font-mono">{t("bootstrap-setup-ux-lab.cloud-access-gate-1i8")}</span>{t("bootstrap-setup-ux-lab.used-as-the-ux-spec-for-ph0")}{" "}
            <a className="underline underline-offset-2" href="/PAP/issues/PAP-10113">
              {t("bootstrap-setup-ux-lab.pap-10113-1c0")}
            </a>{" "}
            {t("bootstrap-setup-ux-lab.and-the-implementation-reference-for-196")}{" "}
            <a className="underline underline-offset-2" href="/PAP/issues/PAP-10114">
              {t("bootstrap-setup-ux-lab.pap-10114-1b6")}
            </a>
            {t("bootstrap-setup-ux-lab.the-browser-claim-cta-only-appears-w-1uc")}{" "}
            <span className="font-mono">deploymentMode === &quot;authenticated&quot;</span> and{" "}
            <span className="font-mono">deploymentExposure === &quot;private&quot;</span>.
          </p>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-12 px-6 pt-10">
        {FIXTURE_ORDER.map((key) => (
          <section key={key} aria-labelledby={`lab-${key}`}>
            <h2
              id={`lab-${key}`}
              className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              {FIXTURE_LABELS[key]}
            </h2>
            <div className="rounded-lg border border-dashed border-border/70 bg-muted/10 p-2">
              {FIXTURE_BODIES[key]}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
