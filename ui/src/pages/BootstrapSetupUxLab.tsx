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
        <span>Prefer to finish setup from the host?</span>
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
      <h1 className="text-xl font-semibold">Finish setting up this Paperclip</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        No admin has claimed this instance yet. Sign in or create your Paperclip account to become the first
        admin from this browser.
      </p>
      <div className="mt-5">
        <Button asChild>
          <a href="/auth?next=/">Sign in / Create account</a>
        </Button>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function SignedInPrivate() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">Finish setting up this Paperclip</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        No admin has claimed this instance yet. Claim it now to become the first admin and start onboarding.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button>Claim this instance</Button>
        <span className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">jane@appliance.local</span>
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Wrong account?{" "}
        <a href="/auth?next=/" className="underline underline-offset-2">
          Switch account
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
      <h1 className="text-xl font-semibold">Finish setting up this Paperclip</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        No admin has claimed this instance yet. Claim it now to become the first admin and start onboarding.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button disabled>
          <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
          Claiming…
        </Button>
        <span className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">jane@appliance.local</span>
        </span>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimErrorPrivate() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">Finish setting up this Paperclip</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        No admin has claimed this instance yet. Claim it now to become the first admin and start onboarding.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button>Claim this instance</Button>
        <span className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">jane@appliance.local</span>
        </span>
      </div>
      <div
        role="alert"
        className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-4 flex-shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Someone else has already claimed this instance.</p>
          <p className="mt-1 text-destructive/90">
            Refresh to sign in, or ask the existing admin to invite you from{" "}
            <span className="font-mono">Instance settings → Access</span>.
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
          <h1 className="text-xl font-semibold">You&rsquo;re the instance admin</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Setup is complete. Taking you to onboarding to create your first company&hellip;
          </p>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        <span className="text-sm text-muted-foreground">Redirecting&hellip;</span>
      </div>
      <div className="mt-5">
        <Button asChild variant="outline">
          <a href="/">Continue to dashboard</a>
        </Button>
      </div>
    </StateChrome>
  );
}

function PublicInviteOnly() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">This Paperclip is waiting on its first admin</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This instance runs in invite‑only mode. The operator must generate a one‑time first‑admin invite URL
        from the host. Once you have the link, open it from this browser to finish setup.
      </p>
      <CliFallback hasActiveInvite />
      <p className="mt-4 text-xs text-muted-foreground">
        Browser‑based claim is intentionally disabled in public mode so anyone on the network can&rsquo;t
        promote themselves.
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
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">UX Lab</p>
          <h1 className="mt-1 text-2xl font-semibold">Bootstrap-pending setup states</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Fixtures for the bootstrap-pending screen in <span className="font-mono">CloudAccessGate</span>. Used
            as the UX spec for{" "}
            <a className="underline underline-offset-2" href="/PAP/issues/PAP-10113">
              PAP-10113
            </a>{" "}
            and the implementation reference for{" "}
            <a className="underline underline-offset-2" href="/PAP/issues/PAP-10114">
              PAP-10114
            </a>
            . The browser claim CTA only appears when{" "}
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
