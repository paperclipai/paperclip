import { t as translateShell, useTranslation, Trans } from "@/i18n";
// token-extraction: allowlisted — intentional one-off decoration (DECISION-SHEET.md B1
// user ruling). The bg-[...gradient...] / shadow-[...] literals in this demo/UX-lab page
// are deliberate one-off decoration, reverted from --gradient-extract-*/--shadow-extract-*
// tokens; the file is on the check-token-gates allowlist in ui/src/index.css.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Check,
  Clock3,
  ExternalLink,
  FlaskConical,
  KeyRound,
  Link2,
  Loader2,
  MailPlus,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";

const inviteRoleOptions = [
  {
    value: "viewer",
    get label() { return translateShell("shell:viewer"); },
    description: "Can view organization work and follow along.",
    get gets() { return translateShell("shell:view_only_organization_membership"); },
  },
  {
    value: "operator",
    get label() { return translateShell("shell:operator"); },
    description: "Can edit organization work and invite people.",
    get gets() { return translateShell("shell:full_editing_and_audit_access_cannot_approve"); },
  },
  {
    value: "admin",
    get label() { return translateShell("shell:admin"); },
    description: "Recommended for operators who need to invite people, create agents, and approve joins.",
    get gets() { return translateShell("shell:can_create_agents_invite_users_assign_tasks"); },
  },
  {
    value: "owner",
    get label() { return translateShell("shell:owner"); },
    description: "Full organization access, including membership management.",
    get gets() { return translateShell("shell:everything_in_admin_plus_managing_members"); },
  },
] as const;

const inviteHistory = [
  {
    id: "invite-active",
    get state() { return translateShell("shell:active"); },
    humanRole: "operator",
    invitedBy: "Board User 25",
    email: "board25@paperclip.local",
    createdAt: "Apr 25, 2026, 9:00 AM",
    get action() { return translateShell("shell:revoke"); },
    get relatedLabel() { return translateShell("shell:review_request"); },
  },
  {
    id: "invite-accepted",
    get state() { return translateShell("shell:accepted"); },
    humanRole: "viewer",
    invitedBy: "Board User 24",
    email: "board24@paperclip.local",
    createdAt: "Apr 24, 2026, 8:15 AM",
    get action() { return translateShell("shell:inactive"); },
    relatedLabel: "—",
  },
  {
    id: "invite-revoked",
    get state() { return translateShell("shell:revoked"); },
    humanRole: "admin",
    invitedBy: "Board User 20",
    email: "board20@paperclip.local",
    createdAt: "Apr 20, 2026, 2:45 PM",
    get action() { return translateShell("shell:inactive"); },
    relatedLabel: "—",
  },
  {
    id: "invite-expired",
    get state() { return translateShell("shell:expired"); },
    humanRole: "owner",
    invitedBy: "Board User 19",
    email: "board19@paperclip.local",
    createdAt: "Apr 19, 2026, 7:10 PM",
    get action() { return translateShell("shell:inactive"); },
    relatedLabel: "—",
  },
] as const;

const fieldClassName =
  "w-full border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500";
const panelClassName = "border border-zinc-800 bg-zinc-950/95 p-6";

function LabSection({
  eyebrow,
  title,
  description,
  accentClassName,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  accentClassName?: string;
  children: ReactNode;
}) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <section
      className={cn(
        "rounded-(--rad-28) border border-border/70 bg-background/80 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.08)] sm:p-5",
        accentClassName,
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            {eyebrow}
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function StatusCard({
  icon,
  title,
  body,
  tone = "default",
}: {
  icon: ReactNode;
  title: string;
  body: string;
  tone?: "default" | "warn" | "success" | "error";
}) {
  const { t: translateShell } = useTranslation("shell");
  const toneClassName = {
    default: "border-border/70 bg-background/85",
    warn: "border-amber-400/40 bg-amber-500/[0.08]",
    success: "border-emerald-400/40 bg-emerald-500/[0.08]",
    error: "border-rose-400/40 bg-rose-500/[0.08]",
  }[tone];

  return (
    <Card className={cn("rounded-(--rad-24) shadow-none", toneClassName)}>
      <CardHeader className="space-y-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-current/10 bg-background/70 text-muted-foreground">
          {icon}
        </div>
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription className="mt-2 text-sm leading-6">{body}</CardDescription>
        </div>
      </CardHeader>
    </Card>
  );
}

function InviteLandingShell({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="overflow-hidden rounded-(--rad-28) border border-zinc-800 bg-zinc-950 shadow-[0_30px_80px_rgba(2,6,23,0.55)]">
      <div className="grid gap-px bg-zinc-800 lg:grid-cols-(--gtc-37)">
        <section className={cn(panelClassName, "space-y-6 bg-zinc-950")}>{left}</section>
        <section className={cn(panelClassName, "h-full bg-zinc-950")}>{right}</section>
      </div>
    </div>
  );
}

function InviteSummaryPanel({
  title,
  description,
  inviteMessage,
  requestedAccess,
  signedInLabel,
}: {
  title: string;
  description: string;
  inviteMessage?: string;
  requestedAccess: string;
  signedInLabel?: string;
}) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <>
      <div className="flex items-start gap-4">
        <CompanyPatternIcon
          companyName="Acme Robotics"
          logoUrl="/api/invites/pcp_invite_test/logo"
          className="h-16 w-16 rounded-none border border-zinc-800"
        />
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-(--tracking-caps) text-zinc-500">{translateShell("shell:you_ve_been_invited_to_join_paperclip")}</p>
          <h3 className="mt-2 text-2xl font-semibold text-zinc-100">{title}</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">{description}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <MetaCard label={translateShell("shell:organization")} value="Acme Robotics" />
        <MetaCard label={translateShell("shell:invited_by")} value="Board User" />
        <MetaCard label={translateShell("shell:requested_access")} value={requestedAccess} />
        <MetaCard label={translateShell("shell:invite_expires")} value="Mar 7, 2027" />
      </div>

      {inviteMessage ? (
        <div className="border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="text-xs uppercase tracking-(--tracking-caps) text-amber-200/80">{translateShell("shell:message_from_inviter")}</div>
          <p className="mt-2 text-sm leading-6 text-amber-50">{inviteMessage}</p>
        </div>
      ) : null}

      {signedInLabel ? (
        <div className="border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-50"><Trans ns="shell" i18nKey="signed_in_as_544d8c" components={{ part1: <>{<span className="font-medium">{signedInLabel}</span>}</> }} /></div>
      ) : null}
    </>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="border border-zinc-800 p-3">
      <div className="text-xs uppercase tracking-(--tracking-caps) text-zinc-500">{label}</div>
      <div className="mt-1 text-sm text-zinc-100">{value}</div>
    </div>
  );
}

function InlineAuthPreview({
  mode,
  feedback,
  working,
}: {
  mode: "sign_up" | "sign_in";
  feedback?: { tone: "info" | "error"; text: string };
  working?: boolean;
}) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">
          {mode === "sign_up" ? translateShell("shell:create_your_account") : translateShell("shell:sign_in_to_continue")}
        </h3>
        <p className="mt-1 text-sm text-zinc-400">
          {mode === "sign_up"
            ? translateShell("shell:start_with_a_paperclip_account_after_that")
            : translateShell("shell:use_the_paperclip_account_that_already_matches")}
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className={cn(
            "flex-1 border px-3 py-2 text-sm transition-colors",
            mode === "sign_up"
              ? "border-zinc-100 bg-zinc-100 text-zinc-950"
              : "border-zinc-800 text-zinc-300 hover:border-zinc-600",
          )}
        >{translateShell("shell:create_account")}</button>
        <button
          type="button"
          className={cn(
            "flex-1 border px-3 py-2 text-sm transition-colors",
            mode === "sign_in"
              ? "border-zinc-100 bg-zinc-100 text-zinc-950"
              : "border-zinc-800 text-zinc-300 hover:border-zinc-600",
          )}
        >{translateShell("shell:i_already_have_an_account")}</button>
      </div>

      <form className="space-y-4">
        {mode === "sign_up" ? (
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">{translateShell("shell:name")}</span>
            <input name="name" className={fieldClassName} defaultValue="Jane Example" readOnly />
          </label>
        ) : null}
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">{translateShell("shell:email")}</span>
          <input name="email" type="email" className={fieldClassName} defaultValue="jane@example.com" readOnly />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">{translateShell("shell:password")}</span>
          <input name="password" type="password" className={fieldClassName} defaultValue="supersecret" readOnly />
        </label>
        {feedback ? (
          <p className={cn("text-xs", feedback.tone === "info" ? "text-amber-300" : "text-red-400")}>
            {feedback.text}
          </p>
        ) : null}
        <Button type="button" className="w-full rounded-none" disabled={working}>
          {working ? translateShell("shell:working") : mode === "sign_in" ? translateShell("shell:sign_in_and_continue") : translateShell("shell:create_account_and_continue")}
        </Button>
      </form>

      <p className="text-xs leading-5 text-zinc-500">
        {mode === "sign_up"
          ? translateShell("shell:already_signed_up_before_use_the_existing")
          : translateShell("shell:no_account_yet_switch_back_to_create")}
      </p>
    </div>
  );
}

function AgentRequestPreview() {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">{translateShell("shell:submit_agent_details")}</h3>
        <p className="mt-1 text-sm text-zinc-400">{translateShell("shell:this_invite_will_create_an_approval_request")}</p>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-400">{translateShell("shell:agent_name")}</span>
        <input className={fieldClassName} defaultValue="Acme Ops Agent" readOnly />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-400">{translateShell("shell:adapter_type")}</span>
        <select className={fieldClassName} defaultValue="codex_local" disabled>
          <option value="codex_local">Codex</option>
          <option value="claude_local">{"Claude Code"}</option>
          <option value="cursor">Cursor</option>
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-400">{translateShell("shell:capabilities")}</span>
        <textarea
          className={fieldClassName}
          rows={4}
          defaultValue="Reviews invites, triages requests, and keeps the board queue moving."
          readOnly
        />
      </label>
      <Button type="button" className="w-full rounded-none">{translateShell("shell:submit_request")}</Button>
    </div>
  );
}

function AcceptInvitePreview({
  autoAccept,
  isCurrentMember,
  error,
}: {
  autoAccept?: boolean;
  isCurrentMember?: boolean;
  error?: string;
}) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">{translateShell("shell:accept_organization_invite")}</h3>
        <p className="mt-1 text-sm text-zinc-400">
          {autoAccept
            ? translateShell("shell:granting_your_access_to_acme_robotics")
            : isCurrentMember
              ? translateShell("shell:this_account_already_belongs_to_acme_robotics")
              : translateShell("shell:this_will_grant_or_complete_your_access")}
        </p>
      </div>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      {autoAccept ? (
        <div className="text-sm text-zinc-400">{translateShell("shell:submitting_request")}</div>
      ) : (
        <Button type="button" className="w-full rounded-none" disabled={isCurrentMember}>{translateShell("shell:accept_invite")}</Button>
      )}
    </div>
  );
}

function InviteResultPreview({
  title,
  description,
  claimSecret,
  onboardingTextUrl,
  joinedNow = false,
}: {
  title: string;
  description: string;
  claimSecret?: string;
  onboardingTextUrl?: string;
  joinedNow?: boolean;
}) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="mx-auto max-w-md border border-zinc-800 bg-zinc-950 p-6 text-zinc-100">
      <div className="flex items-center gap-3">
        <CompanyPatternIcon
          companyName="Acme Robotics"
          logoUrl="/api/invites/pcp_invite_test/logo"
          className="h-12 w-12 rounded-none border border-zinc-800"
        />
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>
      <div className="mt-4 space-y-3">
        <p className="text-sm text-zinc-400">{description}</p>
        {joinedNow ? (
          <Button type="button" className="w-full rounded-none">{translateShell("shell:open_board")}</Button>
        ) : (
          <>
            <div className="border border-zinc-800 p-3">
              <p className="mb-1 text-xs text-zinc-500">{translateShell("shell:approval_page")}</p>
              <a className="text-sm text-zinc-200 underline underline-offset-2" href="/company/settings/members">{translateShell("shell:settings_members")}</a>
            </div>
            <p className="text-xs text-zinc-500">{translateShell("shell:refresh_this_page_after_you_ve_been")}</p>
          </>
        )}
        {claimSecret ? (
          <div className="space-y-1 border border-zinc-800 p-3 text-xs text-zinc-400">
            <div className="text-zinc-200">{translateShell("shell:claim_secret")}</div>
            <div className="font-mono break-all">{claimSecret}</div>
            <div className="font-mono break-all">POST /api/agents/claim-api-key</div>
          </div>
        ) : null}
        {onboardingTextUrl ? (
          <div className="text-xs text-zinc-400"><Trans ns="shell" i18nKey="onboarding" components={{ part1: <>{<span className="font-mono break-all">{onboardingTextUrl}</span>}</> }} /></div>
        ) : null}
      </div>
    </div>
  );
}

function AuthScreenPreview({ mode, error }: { mode: "sign_in" | "sign_up"; error?: string }) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="overflow-hidden rounded-(--rad-28) border border-border/70 bg-background shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
      <div className="grid gap-px bg-border/60 md:grid-cols-2">
        <div className="flex min-h-(--sz-420px) flex-col justify-center bg-background px-8 py-10">
          <div className="mx-auto w-full max-w-md">
            <div className="mb-8 flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Paperclip</span>
            </div>
            <h3 className="text-xl font-semibold">
              {mode === "sign_in" ? translateShell("shell:sign_in_to_paperclip") : translateShell("shell:create_your_paperclip_account")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === "sign_in"
                ? translateShell("shell:use_your_email_and_password_to_access")
                : translateShell("shell:create_an_account_for_this_instance_email")}
            </p>
            <div className="mt-6 space-y-4">
              {mode === "sign_up" ? (
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">{translateShell("shell:name")}</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                    defaultValue="Jane Example"
                    readOnly
                  />
                </label>
              ) : null}
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">{translateShell("shell:email")}</span>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  defaultValue="jane@example.com"
                  readOnly
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">{translateShell("shell:password")}</span>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  defaultValue="supersecret"
                  readOnly
                />
              </label>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
              <Button type="button" className="w-full">
                {mode === "sign_in" ? translateShell("shell:sign_in") : translateShell("shell:create_account_0dffe2")}
              </Button>
            </div>
            <div className="mt-5 text-sm text-muted-foreground">
              {mode === "sign_in" ? translateShell("shell:need_an_account") : translateShell("shell:already_have_an_account")}{" "}
              <span className="font-medium text-foreground underline underline-offset-2">
                {mode === "sign_in" ? translateShell("shell:create_one") : translateShell("shell:sign_in_bfd402")}
              </span>
            </div>
          </div>
        </div>
        <div className="hidden min-h-(--sz-420px) items-center justify-center bg-[radial-gradient(circle_at_top,rgba(8,145,178,0.18),transparent_48%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,1))] px-8 py-10 md:flex">
          <div className="max-w-sm space-y-4 text-zinc-200">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-500/[0.08] px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps) text-cyan-200">{translateShell("shell:auth_preview")}</div>
            <div className="text-2xl font-semibold">{translateShell("shell:side_by_side_signup_styling_review")}</div>
            <p className="text-sm leading-6 text-zinc-400">{translateShell("shell:this_frame_mirrors_the_production_auth_surface")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function CompanyInvitesPreview() {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="grid gap-5 xl:grid-cols-(--gtc-38)">
      <Card className="rounded-(--rad-28) shadow-none">
        <CardHeader className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MailPlus className="h-4 w-4" />{translateShell("shell:organization_invites")}</div>
          <div>
            <CardTitle>{translateShell("shell:create_invite")}</CardTitle>
            <CardDescription className="mt-2">{translateShell("shell:generate_a_human_invite_link_and_choose")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{translateShell("shell:choose_a_role")}</legend>
            <div className="rounded-2xl border border-border">
              {inviteRoleOptions.map((option, index) => (
                <label
                  key={option.value}
                  className={cn("flex cursor-default gap-3 px-4 py-4", index > 0 && "border-t border-border")}
                >
                  <input
                    type="radio"
                    readOnly
                    checked={option.value === "operator"}
                    className="mt-1 h-4 w-4 border-border text-foreground"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.value === "operator" ? (
                        <Badge variant="outline" className="border-border text-muted-foreground">{translateShell("shell:default")}</Badge>
                      ) : null}
                    </span>
                    <span className="block max-w-2xl text-sm text-muted-foreground">{option.description}</span>
                    <span className="block text-sm text-foreground">{option.gets}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">{translateShell("shell:each_invite_link_is_single_use_human")}</div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button">{translateShell("shell:create_invite")}</Button>
            <span className="text-sm text-muted-foreground">{translateShell("shell:invite_history_below_keeps_the_audit_trail")}</span>
          </div>

          <div className="space-y-3 rounded-2xl border border-border px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{translateShell("shell:latest_invite_link")}</div>
                <div className="text-sm text-muted-foreground">{translateShell("shell:this_url_includes_the_current_paperclip_domain")}</div>
              </div>
              <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                <Check className="h-3.5 w-3.5" />{translateShell("shell:copied")}</div>
            </div>
            <button
              type="button"
              className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-left text-sm break-all"
            >
              https://paperclip.local/invite/new-token
            </button>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline">
                <ExternalLink className="h-4 w-4" />{translateShell("shell:open_invite")}</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-(--rad-28) shadow-none">
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>{translateShell("shell:invite_history")}</CardTitle>
              <CardDescription className="mt-2">{translateShell("shell:review_invite_status_role_inviter_and_any")}</CardDescription>
            </div>
            <a href="/inbox/requests" className="text-sm underline underline-offset-4">{translateShell("shell:open_join_request_queue")}</a>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-5 py-3 font-medium text-muted-foreground">{translateShell("shell:state")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{translateShell("shell:role")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{translateShell("shell:invited_by")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{translateShell("shell:created_d70b9e")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{translateShell("shell:join_request")}</th>
                  <th className="px-5 py-3 text-right font-medium text-muted-foreground">{translateShell("shell:action")}</th>
                </tr>
              </thead>
              <tbody>
                {inviteHistory.map((invite) => (
                  <tr key={invite.id} className="border-b border-border last:border-b-0">
                    <td className="px-5 py-3 align-top">
                      <Badge variant="outline" className="border-border text-muted-foreground">
                        {invite.state}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 align-top">{invite.humanRole}</td>
                    <td className="px-5 py-3 align-top">
                      <div>{invite.invitedBy}</div>
                      <div className="text-xs text-muted-foreground">{invite.email}</div>
                    </td>
                    <td className="px-5 py-3 align-top text-muted-foreground">{invite.createdAt}</td>
                    <td className="px-5 py-3 align-top">
                      {invite.relatedLabel === "Review request" ? (
                        <a href="/inbox/requests" className="underline underline-offset-4">
                          {invite.relatedLabel}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">{invite.relatedLabel}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right align-top">
                      {invite.action === "Revoke" ? (
                        <Button type="button" size="sm" variant="outline">{translateShell("shell:revoke")}</Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">{translateShell("shell:inactive")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-border p-4">
              <div className="text-sm font-medium">{translateShell("shell:empty_history_state")}</div>
              <div className="mt-2 text-sm text-muted-foreground">{translateShell("shell:no_invites_have_been_created_for_this")}</div>
            </div>
            <div className="rounded-2xl border border-rose-400/40 bg-rose-500/[0.07] p-4">
              <div className="text-sm font-medium text-foreground">{translateShell("shell:permission_error")}</div>
              <div className="mt-2 text-sm text-muted-foreground">{translateShell("shell:you_do_not_have_permission_to_manage")}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function InviteUxLab() {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-(--rad-32) border border-border/70 bg-[linear-gradient(135deg,rgba(8,145,178,0.10),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.10),transparent_44%),var(--background)] shadow-[0_30px_80px_rgba(15,23,42,0.10)]">
        <div className="grid gap-6 lg:grid-cols-(--gtc-39)">
          <div className="p-6 sm:p-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/25 bg-cyan-500/[0.08] px-3 py-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-cyan-700 dark:text-cyan-300">
              <FlaskConical className="h-3.5 w-3.5" />{translateShell("shell:invite_ux_lab")}</div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">{translateShell("shell:invite_and_signup_ux_review_surface")}</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{translateShell("shell:this_page_collects_the_current_invite_landing")}</p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                /tests/ux/invites
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">{translateShell("shell:signup_invite_states")}</Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">{translateShell("shell:fixture_backed_preview")}</Badge>
            </div>
          </div>

          <aside className="border-t border-border/60 bg-background/70 p-6 lg:border-l lg:border-t-0">
            <div className="mb-4 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">{translateShell("shell:covered_states")}</div>
            <div className="space-y-3">
              {[
                translateShell("shell:invite_loading_access_check_missing_token_and"),
                translateShell("shell:inline_account_creation_and_sign_in_variants"),
                translateShell("shell:human_accept_agent_request_and_auto_accept"),
                translateShell("shell:pending_approval_joined_now_claim_secret_and"),
                translateShell("shell:organization_invite_creation_copied_link_history_empty"),
              ].map((highlight) => (
                <div
                  key={highlight}
                  className="rounded-2xl border border-border/70 bg-background/85 px-4 py-3 text-sm text-muted-foreground"
                >
                  {highlight}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      <LabSection
        eyebrow={translateShell("shell:extra_35_top_level_states")}
        title={translateShell("shell:landing_state_coverage")}
        description={translateShell("shell:small_cards_for_the_fast_return_invite")}
        accentClassName="bg-[linear-gradient(180deg,rgba(59,130,246,0.05),transparent_30%),var(--background)]"
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatusCard
            icon={<Loader2 className="h-4 w-4 animate-spin" />}
            title={translateShell("shell:loading_invite")}
            body="Shown while invite summary, deployment mode, or auth session data is still loading."
          />
          <StatusCard
            icon={<Clock3 className="h-4 w-4" />}
            title={translateShell("shell:checking_your_access")}
            body="Shown after sign-in while the app verifies whether the current user already belongs to the invited organization."
          />
          <StatusCard
            icon={<KeyRound className="h-4 w-4" />}
            title={translateShell("shell:invalid_invite_token")}
            body="The token is missing entirely, so the page short-circuits before any invite lookup."
            tone="error"
          />
          <StatusCard
            icon={<Link2 className="h-4 w-4" />}
            title={translateShell("shell:invite_not_available")}
            body="Used for expired, revoked, already-consumed, or otherwise missing invites."
            tone="warn"
          />
          <StatusCard
            icon={<ShieldCheck className="h-4 w-4" />}
            title={translateShell("shell:bootstrap_complete")}
            body="Result screen for bootstrap CEO invites after setup has been accepted successfully."
            tone="success"
          />
          <StatusCard
            icon={<ArrowRight className="h-4 w-4" />}
            title={translateShell("shell:auto_accept_in_progress")}
            body="Signed-in human users skip the extra button click and move straight into join submission."
          />
          <StatusCard
            icon={<Users className="h-4 w-4" />}
            title={translateShell("shell:already_a_member")}
            body="Acceptance stays disabled and the page redirects into the organization once membership is confirmed."
          />
          <StatusCard
            icon={<UserPlus className="h-4 w-4" />}
            title={translateShell("shell:invite_result_surfaces")}
            body="Both pending-approval and joined-now confirmations are included below with claim and onboarding extras."
            tone="success"
          />
        </div>
      </LabSection>

      <LabSection
        eyebrow={translateShell("shell:extra_34_invite_landing")}
        title={translateShell("shell:split_screen_invite_flows")}
        description={translateShell("shell:these_frames_mirror_the_production_invite_surface")}
        accentClassName="bg-[linear-gradient(180deg,rgba(234,179,8,0.06),transparent_28%),var(--background)]"
      >
        <div className="space-y-5">
          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={translateShell("shell:join_acme_robotics")}
                description={translateShell("shell:create_your_paperclip_account_first_if_you")}
                inviteMessage="Welcome aboard."
                requestedAccess={translateShell("shell:operator")}
              />
            }
            right={<InlineAuthPreview mode="sign_up" />}
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={translateShell("shell:join_acme_robotics")}
                description={translateShell("shell:create_your_paperclip_account_first_if_you")}
                inviteMessage="Welcome aboard."
                requestedAccess={translateShell("shell:operator")}
              />
            }
            right={
              <InlineAuthPreview
                mode="sign_in"
                feedback={{
                  tone: "info",
                  text: "An account already exists for jane@example.com. Sign in below to continue with this invite.",
                }}
              />
            }
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={translateShell("shell:join_acme_robotics")}
                description={translateShell("shell:your_account_is_ready_review_the_invite")}
                inviteMessage="Welcome aboard."
                requestedAccess={translateShell("shell:operator")}
                signedInLabel="Jane Example"
              />
            }
            right={<AcceptInvitePreview autoAccept />}
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={translateShell("shell:join_acme_robotics")}
                description={translateShell("shell:review_the_invite_details_then_submit_the")}
                requestedAccess={translateShell("shell:extra_33_agent_join_request")}
              />
            }
            right={<AgentRequestPreview />}
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={translateShell("shell:join_acme_robotics")}
                description={translateShell("shell:your_account_is_ready_review_the_invite")}
                requestedAccess={translateShell("shell:operator")}
                signedInLabel="Jane Example"
              />
            }
            right={<AcceptInvitePreview error={translateShell("shell:extra_32_this_account_already_belongs_to_the_organizat")} isCurrentMember />}
          />
        </div>
      </LabSection>

      <LabSection
        eyebrow={translateShell("shell:extra_31_result_states")}
        title={translateShell("shell:approval_and_completion_screens")}
        description={translateShell("shell:these_are_the_post_submit_states_returned")}
        accentClassName="bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent_30%),var(--background)]"
      >
        <div className="grid gap-5 xl:grid-cols-3">
          <InviteResultPreview
            title={translateShell("shell:request_to_join_acme_robotics")}
            description={translateShell("shell:board_user_must_approve_your_request_to")}
            claimSecret="pcp_claim_secret_demo"
            onboardingTextUrl="/api/invites/pcp_invite_test/onboarding.txt"
          />
          <InviteResultPreview
            title={translateShell("shell:you_joined_the_organization")}
            description={translateShell("shell:your_account_already_matched_the_approved_invite")}
            joinedNow
          />
          <InviteResultPreview
            title={translateShell("shell:request_to_join_acme_robotics")}
            description={translateShell("shell:ask_them_to_visit_settings_members_to")}
          />
        </div>
      </LabSection>

      <LabSection
        eyebrow={translateShell("shell:extra_30_standalone_auth")}
        title={translateShell("shell:auth_page_states")}
        description={translateShell("shell:the_general_auth_page_uses_a_different")}
        accentClassName="bg-[linear-gradient(180deg,rgba(168,85,247,0.06),transparent_28%),var(--background)]"
      >
        <div className="space-y-5">
          <AuthScreenPreview mode="sign_in" error={translateShell("shell:extra_29_invalid_email_or_password")} />
          <AuthScreenPreview mode="sign_up" />
        </div>
      </LabSection>

      <LabSection
        eyebrow={translateShell("shell:settings")}
        title={translateShell("shell:organization_invite_management")}
        description={translateShell("shell:this_section_captures_the_board_side_invite")}
        accentClassName="bg-[linear-gradient(180deg,rgba(244,114,182,0.06),transparent_28%),var(--background)]"
      >
        <CompanyInvitesPreview />
      </LabSection>
    </div>
  );
}
