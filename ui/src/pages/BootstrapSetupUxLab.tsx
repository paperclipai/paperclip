import { t as finalPagesT } from "@/i18n";
import { t as translateShell, useTranslation, Trans } from "@/i18n";
import type { ReactElement, ReactNode } from "react";
import { Loader2, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { BOOTSTRAP_FALLBACK_COMMAND } from "@/bootstrapSetup";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type LabFixtureKey =
  | "signed-out-private"
  | "signed-in-private"
  | "claiming"
  | "claim-error"
  | "claim-success"
  | "public-invite-only";

const FIXTURE_LABELS: Record<LabFixtureKey, string> = {
  get "signed-out-private"() { return translateShell("shell:1_authenticated_private_signed_out_browser_claim"); },
  get "signed-in-private"() { return translateShell("shell:2_authenticated_private_signed_in_claim_cta"); },
  get claiming() { return translateShell("shell:3_authenticated_private_claim_in_flight"); },
  get "claim-error"() { return translateShell("shell:4_authenticated_private_claim_error_e_g"); },
  get "claim-success"() { return translateShell("shell:5_authenticated_private_claim_succeeded_redirect_pending"); },
  get "public-invite-only"() { return translateShell("shell:6_authenticated_public_invite_only_no_browser"); },
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
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Terminal className="size-4 text-muted-foreground" aria-hidden />
        <span>{translateShell("shell:prefer_to_finish_setup_from_the_host")}</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasActiveInvite
          ? translateShell("shell:a_bootstrap_invite_is_already_active_check")
          : translateShell("shell:run_this_command_on_the_host_that")}
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
{BOOTSTRAP_FALLBACK_COMMAND}
      </pre>
    </div>
  );
}

function StateChrome({ children }: { children: ReactNode }) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">{children}</Card>
    </div>
  );
}

function SignedOutPrivate() {
  const { t: translateShell } = useTranslation("shell");
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{translateShell("shell:finish_setting_up_this_paperclip")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{translateShell("shell:no_admin_has_claimed_this_instance_yet")}</p>
      <div className="mt-5">
        <Button asChild>
          <a href="/auth?next=/">{translateShell("shell:sign_in_create_account")}</a>
        </Button>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function SignedInPrivate() {
  const { t: translateShell } = useTranslation("shell");
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{translateShell("shell:finish_setting_up_this_paperclip")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{translateShell("shell:no_admin_has_claimed_this_instance_yet_c5c1f5")}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button>{translateShell("shell:claim_this_instance")}</Button>
        <span className="text-sm text-muted-foreground"><Trans ns="shell" i18nKey="signed_in_as" components={{ part1: <>{<span className="font-medium text-foreground">jane@appliance.local</span>}</> }} /></span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground"><Trans ns="shell" i18nKey="wrong_account" components={{ part1: <>{<a href="/auth?next=/" className="underline underline-offset-2">{finalPagesT("final-pages:Switch_account_fedce0")}</a>}</> }} /></p>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimingPrivate() {
  const { t: translateShell } = useTranslation("shell");
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{translateShell("shell:finish_setting_up_this_paperclip")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{translateShell("shell:no_admin_has_claimed_this_instance_yet_c5c1f5")}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button disabled>
          <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />{translateShell("shell:claiming")}</Button>
        <span className="text-sm text-muted-foreground"><Trans ns="shell" i18nKey="signed_in_as" components={{ part1: <>{<span className="font-medium text-foreground">jane@appliance.local</span>}</> }} /></span>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimErrorPrivate() {
  const { t: translateShell } = useTranslation("shell");
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{translateShell("shell:finish_setting_up_this_paperclip")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{translateShell("shell:no_admin_has_claimed_this_instance_yet_c5c1f5")}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button>{translateShell("shell:claim_this_instance")}</Button>
        <span className="text-sm text-muted-foreground"><Trans ns="shell" i18nKey="signed_in_as" components={{ part1: <>{<span className="font-medium text-foreground">jane@appliance.local</span>}</> }} /></span>
      </div>
      <div
        role="alert"
        className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-4 flex-shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{translateShell("shell:someone_else_has_already_claimed_this_instance")}</p>
          <p className="mt-1 text-destructive/90"><Trans ns="shell" i18nKey="refresh_to_sign_in_or_ask_the" components={{ part1: <>{<span className="font-mono">{finalPagesT("final-pages:Settings_Access_aaed72")}</span>}</> }} /></p>
        </div>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimSuccess() {
  const { t: translateShell } = useTranslation("shell");
  return (
    <StateChrome>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold">{translateShell("shell:you_re_the_instance_admin")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{translateShell("shell:setup_is_complete_taking_you_to_onboarding")}</p>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        <span className="text-sm text-muted-foreground">{translateShell("shell:redirecting")}</span>
      </div>
      <div className="mt-5">
        <Button asChild variant="outline">
          <a href="/">{translateShell("shell:continue_to_dashboard")}</a>
        </Button>
      </div>
    </StateChrome>
  );
}

function PublicInviteOnly() {
  const { t: translateShell } = useTranslation("shell");
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{translateShell("shell:this_paperclip_is_waiting_on_its_first")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{translateShell("shell:this_instance_runs_in_invite_only_mode")}</p>
      <CliFallback hasActiveInvite />
      <p className="mt-4 text-xs text-muted-foreground">{translateShell("shell:browser_based_claim_is_intentionally_disabled_in")}</p>
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
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="bg-background min-h-screen pb-16">
      <header className="border-b border-border bg-muted/20">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{translateShell("shell:ux_lab")}</p>
          <h1 className="mt-1 text-2xl font-semibold">{translateShell("shell:bootstrap_pending_setup_states")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground"><Trans ns="shell" i18nKey="fixtures_for_the_bootstrap_pending_screen_in" components={{ part1: <>{<span className="font-mono">CloudAccessGate</span>}</>, part2: <>{<a className="underline underline-offset-2" href="/PAP/issues/PAP-10113">
              PAP-10113
            </a>}</>, part3: <>{<a className="underline underline-offset-2" href="/PAP/issues/PAP-10114">
              PAP-10114
            </a>}</>, part4: <>{<span className="font-mono">deploymentMode === &quot;authenticated&quot;</span>}</>, part5: <>{<span className="font-mono">deploymentExposure === &quot;private&quot;</span>}</> }} /></p>
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
