import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import type { AgentAdapterType, JoinRequest } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { t, useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { Link, useNavigate, useParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { companiesListQueryOptions } from "../api/companies-query";
import { healthApi } from "../api/health";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { clearPendingInviteToken, rememberPendingInviteToken } from "../lib/invite-memory";
import { queryKeys } from "../lib/queryKeys";
import { formatDate } from "../lib/utils";

type AuthMode = "sign_in" | "sign_up";
type AuthFeedback = { tone: "error" | "info"; message: string };

const joinAdapterOptions: AgentAdapterType[] = [...AGENT_ADAPTER_TYPES];
const ENABLED_INVITE_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
]);

function readNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

const fieldClassName =
  "w-full border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500";
const panelClassName = "border border-zinc-800 bg-zinc-950/95 p-6";
const modeButtonBaseClassName =
  "flex-1 border px-3 py-2 text-sm transition-colors";

function formatHumanRole(role: string | null | undefined) {
  if (!role) return null;
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function getAuthErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}

function getAuthErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return null;
  const message = error.message.trim();
  return message.length > 0 ? message : null;
}

function mapInviteAuthFeedback(
  error: unknown,
  authMode: AuthMode,
  email: string,
): AuthFeedback {
  const code = getAuthErrorCode(error);
  const message = getAuthErrorMessage(error);
  const emailLabel =
    email.trim().length > 0
      ? email.trim()
      : t("pages.inviteLanding.thatEmailFallback", { defaultValue: "that email" });

  if (code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
    return {
      tone: "info",
      message: t("pages.inviteLanding.accountAlreadyExistsSignIn", {
        email: emailLabel,
        defaultValue:
          "An account already exists for {{email}}. Sign in below to continue with this invite.",
      }),
    };
  }

  if (code === "INVALID_EMAIL_OR_PASSWORD") {
    return {
      tone: "error",
      message: t("pages.inviteLanding.invalidEmailOrPassword", {
        defaultValue:
          "That email and password did not match an existing Paperclip account. Check both fields, or create an account first if you are new here.",
      }),
    };
  }

  if (authMode === "sign_in" && message === "Request failed: 401") {
    return {
      tone: "error",
      message: t("pages.inviteLanding.invalidEmailOrPassword", {
        defaultValue:
          "That email and password did not match an existing Paperclip account. Check both fields, or create an account first if you are new here.",
      }),
    };
  }

  if (authMode === "sign_up" && message === "Request failed: 422") {
    return {
      tone: "info",
      message: t("pages.inviteLanding.accountMayExistTrySignIn", {
        email: emailLabel,
        defaultValue: "An account may already exist for {{email}}. Try signing in instead.",
      }),
    };
  }

  return {
    tone: "error",
    message:
      message ?? t("pages.inviteLanding.authenticationFailed", { defaultValue: "Authentication failed" }),
  };
}

function isBootstrapAcceptancePayload(payload: unknown) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "bootstrapAccepted" in (payload as Record<string, unknown>),
  );
}

function isApprovedHumanJoinPayload(payload: unknown, showsAgentForm: boolean) {
  if (!payload || typeof payload !== "object" || showsAgentForm) return false;
  const status = (payload as { status?: unknown }).status;
  return status === "approved";
}

type AwaitingJoinApprovalPanelProps = {
  companyDisplayName: string;
  companyLogoUrl: string | null;
  companyBrandColor: string | null;
  invitedByUserName: string | null;
  claimSecret?: string | null;
  claimApiKeyPath?: string | null;
  onboardingTextUrl?: string | null;
};

function InviteCompanyLogo({
  companyDisplayName,
  companyLogoUrl,
  companyBrandColor,
  className,
}: {
  companyDisplayName: string;
  companyLogoUrl: string | null;
  companyBrandColor: string | null;
  className?: string;
}) {
  return (
    <CompanyPatternIcon
      companyName={companyDisplayName}
      logoUrl={companyLogoUrl}
      brandColor={companyBrandColor}
      logoFit="contain"
      className={className}
    />
  );
}

function AwaitingJoinApprovalPanel({
  companyDisplayName,
  companyLogoUrl,
  companyBrandColor,
  invitedByUserName,
  claimSecret = null,
  claimApiKeyPath = null,
  onboardingTextUrl = null,
}: AwaitingJoinApprovalPanelProps) {
  const { t } = useTranslation();
  const approvalUrl = `${window.location.origin}/company/settings/members`;
  const approverLabel =
    invitedByUserName ??
    t("pages.inviteLanding.aCompanyAdmin", { defaultValue: "A company admin" });

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-md border border-zinc-800 bg-zinc-950 p-6" data-testid="invite-pending-approval">
        <div className="flex items-center gap-3">
          <InviteCompanyLogo
            companyDisplayName={companyDisplayName}
            companyLogoUrl={companyLogoUrl}
            companyBrandColor={companyBrandColor}
            className="h-12 w-12 border border-zinc-800 rounded-none"
          />
          <h1 className="text-lg font-semibold">
            {t("pages.inviteLanding.requestToJoin", {
              company: companyDisplayName,
              defaultValue: "Request to join {{company}}",
            })}
          </h1>
        </div>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-zinc-400">
            {t("pages.inviteLanding.awaitingApprovalBody", {
              approver: approverLabel,
              defaultValue:
                "Your request is still awaiting approval. {{approver}} must approve your request to join.",
            })}
          </p>
          <div className="border border-zinc-800 p-3">
            <p className="text-xs text-zinc-500 mb-1">
              {t("pages.inviteLanding.approvalPage", { defaultValue: "Approval page" })}
            </p>
            <a
              href={approvalUrl}
              className="text-sm text-zinc-200 underline underline-offset-2 hover:text-zinc-100"
            >
              {t("pages.inviteLanding.companySettingsMembers", {
                defaultValue: "Company Settings → Members",
              })}
            </a>
          </div>
          <p className="text-sm text-zinc-400">
            {t("pages.inviteLanding.askThemToVisit", { defaultValue: "Ask them to visit" })}{" "}
            <a href={approvalUrl} className="text-zinc-200 underline underline-offset-2 hover:text-zinc-100">
              {t("pages.inviteLanding.companySettingsMembers", {
                defaultValue: "Company Settings → Members",
              })}
            </a>{" "}
            {t("pages.inviteLanding.toApproveYourRequest", { defaultValue: "to approve your request." })}
          </p>
          <p className="text-xs text-zinc-500">
            {t("pages.inviteLanding.refreshAfterApproval", {
              defaultValue:
                "Refresh this page after you've been approved — you'll be redirected automatically.",
            })}
          </p>
        </div>
        {claimSecret && claimApiKeyPath ? (
          <div className="mt-4 space-y-1 border border-zinc-800 p-3 text-xs text-zinc-400">
            <div className="text-zinc-200">
              {t("pages.inviteLanding.claimSecret", { defaultValue: "Claim secret" })}
            </div>
            <div className="font-mono break-all">{claimSecret}</div>
            <div className="font-mono break-all">POST {claimApiKeyPath}</div>
          </div>
        ) : null}
        {onboardingTextUrl ? (
          <div className="mt-4 text-xs text-zinc-400">
            {t("pages.inviteLanding.onboardingLabel", { defaultValue: "Onboarding:" })}{" "}
            <span className="font-mono break-all">{onboardingTextUrl}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function InviteLandingPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { setSelectedCompanyId } = useCompany();
  const params = useParams();
  const token = (params.token ?? "").trim();
  const [authMode, setAuthMode] = useState<AuthMode>("sign_up");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agentName, setAgentName] = useState("");
  const [adapterType, setAdapterType] = useState<AgentAdapterType>("claude_local");
  const [capabilities, setCapabilities] = useState("");
  const [result, setResult] = useState<{ kind: "bootstrap" | "join"; payload: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authFeedback, setAuthFeedback] = useState<AuthFeedback | null>(null);
  const [autoAcceptStarted, setAutoAcceptStarted] = useState(false);
  const authErrorId = "invite-auth-error";

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const inviteQuery = useQuery({
    queryKey: queryKeys.access.invite(token),
    queryFn: () => accessApi.getInvite(token),
    enabled: token.length > 0,
    retry: false,
  });

  const companiesQuery = useQuery({
    ...companiesListQueryOptions,
    enabled: !!sessionQuery.data && !!inviteQuery.data?.companyId,
  });
  const companyList = companiesQuery.data?.companies ?? [];

  useEffect(() => {
    if (token) rememberPendingInviteToken(token);
  }, [token]);

  useEffect(() => {
    setAutoAcceptStarted(false);
  }, [token]);

  useEffect(() => {
    const list = companiesQuery.data?.companies;
    if (!list || !inviteQuery.data?.companyId) return;
    if (list.some((c) => c.id === inviteQuery.data!.companyId)) {
      clearPendingInviteToken(token);
    }
  }, [companiesQuery.data, inviteQuery.data, token]);

  const invite = inviteQuery.data;
  const isCheckingExistingMembership =
    Boolean(sessionQuery.data) &&
    Boolean(invite?.companyId) &&
    companiesQuery.isLoading;
  const isCurrentMember =
    Boolean(invite?.companyId) &&
    companyList.some((company) => company.id === invite?.companyId);
  const companyName = invite?.companyName?.trim() || null;
  const companyDisplayName =
    companyName ||
    t("pages.inviteLanding.thisPaperclipCompany", { defaultValue: "this Paperclip company" });
  const companyLogoUrl = invite?.companyLogoUrl?.trim() || null;
  const companyBrandColor = invite?.companyBrandColor?.trim() || null;
  const invitedByUserName = invite?.invitedByUserName?.trim() || null;
  const inviteMessage = invite?.inviteMessage?.trim() || null;
  const requestedHumanRole = formatHumanRole(invite?.humanRole);
  const inviteJoinRequestStatus = invite?.joinRequestStatus ?? null;
  const inviteJoinRequestType = invite?.joinRequestType ?? null;
  const canCompleteAcceptedHumanInvite =
    inviteJoinRequestType === "human" &&
    (inviteJoinRequestStatus === "pending_approval" || inviteJoinRequestStatus === "approved");
  const requiresHumanAccount =
    healthQuery.data?.deploymentMode === "authenticated" &&
    !sessionQuery.data &&
    invite?.allowedJoinTypes !== "agent";
  const showsAgentForm = invite?.inviteType !== "bootstrap_ceo" && invite?.allowedJoinTypes === "agent";
  const shouldAutoAcceptHumanInvite =
    Boolean(sessionQuery.data) &&
    !showsAgentForm &&
    invite?.inviteType !== "bootstrap_ceo" &&
    (!inviteJoinRequestStatus || canCompleteAcceptedHumanInvite) &&
    !isCheckingExistingMembership &&
    !isCurrentMember &&
    !result &&
    error === null;
  const sessionLabel =
    sessionQuery.data?.user.name?.trim() ||
    sessionQuery.data?.user.email?.trim() ||
    t("pages.inviteLanding.thisAccount", { defaultValue: "this account" });

  const authCanSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (authMode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  const acceptMutation = useMutation({
    mutationFn: async () => {
      if (!invite) throw new Error("Invite not found");
      if (isCheckingExistingMembership) {
        throw new Error("Checking your company access. Try again in a moment.");
      }
      if (isCurrentMember) {
        throw new Error("This account already belongs to the company.");
      }
      if (invite.inviteType === "bootstrap_ceo" || invite.allowedJoinTypes !== "agent") {
        return accessApi.acceptInvite(token, { requestType: "human" });
      }
      return accessApi.acceptInvite(token, {
        requestType: "agent",
        agentName: agentName.trim(),
        adapterType,
        capabilities: capabilities.trim() || null,
      });
    },
    onSuccess: async (payload) => {
      setError(null);
      clearPendingInviteToken(token);
      const asBootstrap = isBootstrapAcceptancePayload(payload);
      setResult({ kind: asBootstrap ? "bootstrap" : "join", payload });
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      if (invite?.companyId && isApprovedHumanJoinPayload(payload, showsAgentForm)) {
        setSelectedCompanyId(invite.companyId, { source: "manual" });
        navigate("/", { replace: true });
      }
    },
    onError: (err) => {
      setError(
        err instanceof Error
          ? err.message
          : t("pages.inviteLanding.failedToAcceptInvite", { defaultValue: "Failed to accept invite" }),
      );
    },
  });

  useEffect(() => {
    if (!shouldAutoAcceptHumanInvite || autoAcceptStarted || acceptMutation.isPending) return;
    setAutoAcceptStarted(true);
    setError(null);
    acceptMutation.mutate();
  }, [acceptMutation, autoAcceptStarted, shouldAutoAcceptHumanInvite]);

  const authMutation = useMutation({
    mutationFn: async () => {
      if (authMode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setAuthFeedback(null);
      rememberPendingInviteToken(token);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
      const { companies: freshCompanies } = await queryClient.fetchQuery(companiesListQueryOptions);

      if (invite?.companyId && freshCompanies.some((company) => company.id === invite.companyId)) {
        clearPendingInviteToken(token);
        setSelectedCompanyId(invite.companyId, { source: "manual" });
        navigate("/", { replace: true });
        return;
      }

      if (!invite || invite.inviteType !== "bootstrap_ceo") {
        return;
      }

      try {
        const payload = await acceptMutation.mutateAsync();
        if (isBootstrapAcceptancePayload(payload)) {
          navigate("/", { replace: true });
        }
      } catch {
        return;
      }
    },
    onError: (err) => {
      const nextFeedback = mapInviteAuthFeedback(err, authMode, email);
      if (getAuthErrorCode(err) === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
        setAuthMode("sign_in");
        setPassword("");
      }
      setAuthFeedback(nextFeedback);
    },
  });

  const joinButtonLabel = useMemo(() => {
    if (!invite) return t("pages.inviteLanding.continue", { defaultValue: "Continue" });
    if (isCurrentMember) return t("pages.inviteLanding.openCompany", { defaultValue: "Open company" });
    if (invite.inviteType === "bootstrap_ceo")
      return t("pages.inviteLanding.acceptInvite", { defaultValue: "Accept invite" });
    if (showsAgentForm) return t("pages.inviteLanding.submitRequest", { defaultValue: "Submit request" });
    return sessionQuery.data
      ? t("pages.inviteLanding.acceptInvite", { defaultValue: "Accept invite" })
      : t("pages.inviteLanding.continue", { defaultValue: "Continue" });
  }, [invite, isCurrentMember, sessionQuery.data, showsAgentForm, t]);

  if (!token) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {t("pages.inviteLanding.invalidInviteToken", { defaultValue: "Invalid invite token." })}
      </div>
    );
  }

  if (inviteQuery.isLoading || healthQuery.isLoading || sessionQuery.isLoading) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
        {t("pages.inviteLanding.loadingInvite", { defaultValue: "Loading invite..." })}
      </div>
    );
  }

  if (isCheckingExistingMembership) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
        {t("pages.inviteLanding.checkingYourAccess", { defaultValue: "Checking your access..." })}
      </div>
    );
  }

  if (inviteQuery.error || !invite) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="border border-border bg-card p-6" data-testid="invite-error">
          <h1 className="text-lg font-semibold">
            {t("pages.inviteLanding.inviteNotAvailable", { defaultValue: "Invite not available" })}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("pages.inviteLanding.inviteExpiredRevokedUsed", {
              defaultValue: "This invite may be expired, revoked, or already used.",
            })}
          </p>
        </div>
      </div>
    );
  }

  if (
    inviteJoinRequestStatus === "approved" &&
    inviteJoinRequestType === "human" &&
    isCurrentMember
  ) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
        {t("pages.inviteLanding.openingCompany", { defaultValue: "Opening company..." })}
      </div>
    );
  }

  if (inviteJoinRequestStatus === "pending_approval" && !canCompleteAcceptedHumanInvite) {
    return (
      <AwaitingJoinApprovalPanel
        companyDisplayName={companyDisplayName}
        companyLogoUrl={companyLogoUrl}
        companyBrandColor={companyBrandColor}
        invitedByUserName={invitedByUserName}
      />
    );
  }

  if (inviteJoinRequestStatus && !canCompleteAcceptedHumanInvite) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="border border-border bg-card p-6" data-testid="invite-error">
          <h1 className="text-lg font-semibold">
            {t("pages.inviteLanding.inviteNotAvailable", { defaultValue: "Invite not available" })}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {inviteJoinRequestStatus === "rejected"
              ? t("pages.inviteLanding.joinRequestNotApproved", {
                  defaultValue: "This join request was not approved.",
                })
              : t("pages.inviteLanding.inviteAlreadyUsed", {
                  defaultValue: "This invite has already been used.",
                })}
          </p>
        </div>
      </div>
    );
  }

  if (result?.kind === "bootstrap") {
    return (
      <div className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
        <div className="mx-auto max-w-md border border-zinc-800 bg-zinc-950 p-6">
          <h1 className="text-lg font-semibold">
            {t("pages.inviteLanding.bootstrapComplete", { defaultValue: "Bootstrap complete" })}
          </h1>
          <div className="mt-4">
            <Button asChild className="rounded-none">
              <Link to="/">{t("pages.inviteLanding.openBoard", { defaultValue: "Open board" })}</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (result?.kind === "join") {
    const payload = result.payload as JoinRequest & {
      claimSecret?: string;
      claimApiKeyPath?: string;
      onboarding?: Record<string, unknown>;
    };
    const claimSecret = typeof payload.claimSecret === "string" ? payload.claimSecret : null;
    const claimApiKeyPath = typeof payload.claimApiKeyPath === "string" ? payload.claimApiKeyPath : null;
    const onboardingTextUrl = readNestedString(payload.onboarding, ["textInstructions", "url"]);
    const joinedNow = !showsAgentForm && payload.status === "approved";

    return (
      joinedNow ? (
        <div className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
          <div className="mx-auto max-w-md border border-zinc-800 bg-zinc-950 p-6">
            <div className="flex items-center gap-3">
              <InviteCompanyLogo
                companyDisplayName={companyDisplayName}
                companyLogoUrl={companyLogoUrl}
                companyBrandColor={companyBrandColor}
                className="h-12 w-12 border border-zinc-800 rounded-none"
              />
              <h1 className="text-lg font-semibold">
                {t("pages.inviteLanding.youJoinedTheCompany", { defaultValue: "You joined the company" })}
              </h1>
            </div>
            <div className="mt-4">
              <Button asChild className="w-full rounded-none">
                <Link to="/">{t("pages.inviteLanding.openBoard", { defaultValue: "Open board" })}</Link>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <AwaitingJoinApprovalPanel
          companyDisplayName={companyDisplayName}
          companyLogoUrl={companyLogoUrl}
          companyBrandColor={companyBrandColor}
          invitedByUserName={invitedByUserName}
          claimSecret={claimSecret}
          claimApiKeyPath={claimApiKeyPath}
          onboardingTextUrl={onboardingTextUrl}
        />
      )
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-5xl">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <section className={`${panelClassName} space-y-6`}>
            <div className="flex items-start gap-4">
              <InviteCompanyLogo
                companyDisplayName={companyDisplayName}
                companyLogoUrl={companyLogoUrl}
                companyBrandColor={companyBrandColor}
                className="h-16 w-16 rounded-none border border-zinc-800"
              />
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">
                  {t("pages.inviteLanding.youveBeenInvited", {
                    defaultValue: "You've been invited to join Paperclip",
                  })}
                </p>
                <h1 className="mt-2 text-2xl font-semibold">
                  {invite.inviteType === "bootstrap_ceo"
                    ? t("pages.inviteLanding.setUpPaperclip", { defaultValue: "Set up Paperclip" })
                    : t("pages.inviteLanding.joinCompany", {
                        company: companyDisplayName,
                        defaultValue: "Join {{company}}",
                      })}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">
                  {showsAgentForm
                    ? t("pages.inviteLanding.reviewSubmitAgentInfo", {
                        defaultValue:
                          "Review the invite details, then submit the agent information below to start the join request.",
                      })
                    : requiresHumanAccount
                      ? t("pages.inviteLanding.createAccountFirst", {
                          defaultValue:
                            "Create your Paperclip account first. If you already have one, switch to sign in and continue the invite with the same email.",
                        })
                      : t("pages.inviteLanding.accountReadyReview", {
                          defaultValue:
                            "Your account is ready. Review the invite details, then accept it to continue.",
                        })}
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border border-zinc-800 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                  {t("pages.inviteLanding.company", { defaultValue: "Company" })}
                </div>
                <div className="mt-1 text-sm text-zinc-100">{companyDisplayName}</div>
              </div>
              <div className="border border-zinc-800 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                  {t("pages.inviteLanding.invitedBy", { defaultValue: "Invited by" })}
                </div>
                <div className="mt-1 text-sm text-zinc-100">
                  {invitedByUserName ??
                    t("pages.inviteLanding.paperclipBoard", { defaultValue: "Paperclip board" })}
                </div>
              </div>
              <div className="border border-zinc-800 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                  {t("pages.inviteLanding.requestedAccess", { defaultValue: "Requested access" })}
                </div>
                <div className="mt-1 text-sm text-zinc-100">
                  {showsAgentForm
                    ? t("pages.inviteLanding.agentJoinRequest", { defaultValue: "Agent join request" })
                    : requestedHumanRole ??
                      t("pages.inviteLanding.companyAccess", { defaultValue: "Company access" })}
                </div>
              </div>
              <div className="border border-zinc-800 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                  {t("pages.inviteLanding.inviteExpires", { defaultValue: "Invite expires" })}
                </div>
                <div className="mt-1 text-sm text-zinc-100">{formatDate(invite.expiresAt)}</div>
              </div>
            </div>

            {inviteMessage ? (
              <div className="border border-amber-500/40 bg-amber-500/10 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-amber-200/80">
                  {t("pages.inviteLanding.messageFromInviter", { defaultValue: "Message from inviter" })}
                </div>
                <p className="mt-2 text-sm leading-6 text-amber-50">{inviteMessage}</p>
              </div>
            ) : null}

            {sessionQuery.data ? (
              <div className="border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-50">
                {t("pages.inviteLanding.signedInAsPrefix", { defaultValue: "Signed in as" })}{" "}
                <span className="font-medium">{sessionLabel}</span>
                {t("pages.inviteLanding.signedInAsSuffix", { defaultValue: "." })}
              </div>
            ) : null}
          </section>

          <section className={`${panelClassName} h-fit`}>
            {showsAgentForm ? (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">
                    {t("pages.inviteLanding.submitAgentDetails", { defaultValue: "Submit agent details" })}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    {t("pages.inviteLanding.inviteCreatesAgentApproval", {
                      company: companyDisplayName,
                      defaultValue:
                        "This invite will create an approval request for a new agent in {{company}}.",
                    })}
                  </p>
                </div>
                <label className="block text-sm">
                  <span className="mb-1 block text-zinc-400">
                    {t("pages.inviteLanding.agentName", { defaultValue: "Agent name" })}
                  </span>
                  <input
                    className={fieldClassName}
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-zinc-400">
                    {t("pages.inviteLanding.adapterType", { defaultValue: "Adapter type" })}
                  </span>
                  <select
                    className={fieldClassName}
                    value={adapterType}
                    onChange={(event) => setAdapterType(event.target.value as AgentAdapterType)}
                  >
                    {joinAdapterOptions.map((type) => (
                      <option key={type} value={type} disabled={!ENABLED_INVITE_ADAPTERS.has(type)}>
                        {getAdapterLabel(type)}
                        {!ENABLED_INVITE_ADAPTERS.has(type)
                          ? t("pages.inviteLanding.comingSoonSuffix", { defaultValue: " (Coming soon)" })
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-zinc-400">
                    {t("pages.inviteLanding.capabilities", { defaultValue: "Capabilities" })}
                  </span>
                  <textarea
                    className={fieldClassName}
                    rows={4}
                    value={capabilities}
                    onChange={(event) => setCapabilities(event.target.value)}
                  />
                </label>
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
                <Button
                  className="w-full rounded-none"
                  disabled={acceptMutation.isPending || agentName.trim().length === 0}
                  onClick={() => acceptMutation.mutate()}
                >
                  {acceptMutation.isPending
                    ? t("pages.inviteLanding.working", { defaultValue: "Working..." })
                    : joinButtonLabel}
                </Button>
              </div>
            ) : requiresHumanAccount ? (
              <div className="space-y-5">
                <div>
                  <h2 className="text-lg font-semibold">
                    {authMode === "sign_up"
                      ? t("pages.inviteLanding.createYourAccount", { defaultValue: "Create your account" })
                      : t("pages.inviteLanding.signInToContinue", { defaultValue: "Sign in to continue" })}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    {authMode === "sign_up"
                      ? t("pages.inviteLanding.startWithAccount", {
                          company: companyDisplayName,
                          defaultValue:
                            "Start with a Paperclip account. After that, you'll come right back here to accept the invite for {{company}}.",
                        })
                      : t("pages.inviteLanding.useMatchingAccount", {
                          defaultValue:
                            "Use the Paperclip account that already matches this invite. If you do not have one yet, switch back to create account.",
                        })}
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    className={`${modeButtonBaseClassName} ${
                      authMode === "sign_up"
                        ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                        : "border-zinc-800 text-zinc-300 hover:border-zinc-600"
                    }`}
                    onClick={() => {
                      setAuthFeedback(null);
                      setAuthMode("sign_up");
                    }}
                  >
                    {t("pages.inviteLanding.createAccount", { defaultValue: "Create account" })}
                  </button>
                  <button
                    type="button"
                    className={`${modeButtonBaseClassName} ${
                      authMode === "sign_in"
                        ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                        : "border-zinc-800 text-zinc-300 hover:border-zinc-600"
                    }`}
                    onClick={() => {
                      setAuthFeedback(null);
                      setAuthMode("sign_in");
                    }}
                  >
                    {t("pages.inviteLanding.iAlreadyHaveAccount", {
                      defaultValue: "I already have an account",
                    })}
                  </button>
                </div>

                <form
                  className="space-y-4"
                  method="post"
                  action={authMode === "sign_up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email"}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (authMutation.isPending) return;
                    if (!authCanSubmit) {
                      setAuthFeedback({
                        tone: "error",
                        message: t("pages.inviteLanding.fillRequiredFields", {
                          defaultValue: "Please fill in all required fields.",
                        }),
                      });
                      return;
                    }
                    authMutation.mutate();
                  }}
                  data-testid="invite-inline-auth"
                >
                  {authMode === "sign_up" ? (
                    <label className="block text-sm" htmlFor="invite-name">
                      <span className="mb-1 block text-zinc-400">
                        {t("pages.inviteLanding.name", { defaultValue: "Name" })}
                      </span>
                      <input
                        id="invite-name"
                        name="name"
                        className={fieldClassName}
                        value={name}
                        onChange={(event) => {
                          setName(event.target.value);
                          setAuthFeedback(null);
                        }}
                        autoComplete="name"
                        required
                        aria-required="true"
                        aria-invalid={authFeedback?.tone === "error" ? true : undefined}
                        aria-describedby={authFeedback ? authErrorId : undefined}
                        autoFocus
                      />
                    </label>
                  ) : null}
                  <label className="block text-sm" htmlFor="invite-email">
                    <span className="mb-1 block text-zinc-400">
                      {t("pages.inviteLanding.email", { defaultValue: "Email" })}
                    </span>
                    <input
                      id="invite-email"
                      name="email"
                      type="email"
                      className={fieldClassName}
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        setAuthFeedback(null);
                      }}
                      autoComplete="username"
                      required
                      aria-required="true"
                      aria-invalid={authFeedback?.tone === "error" ? true : undefined}
                      aria-describedby={authFeedback ? authErrorId : undefined}
                      autoFocus={authMode === "sign_in"}
                    />
                  </label>
                  <label className="block text-sm" htmlFor="invite-password">
                    <span className="mb-1 block text-zinc-400">
                      {t("pages.inviteLanding.password", { defaultValue: "Password" })}
                    </span>
                    <input
                      id="invite-password"
                      name="password"
                      type="password"
                      className={fieldClassName}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setAuthFeedback(null);
                      }}
                      autoComplete={authMode === "sign_in" ? "current-password" : "new-password"}
                      required
                      aria-required="true"
                      aria-invalid={authFeedback?.tone === "error" ? true : undefined}
                      aria-describedby={authFeedback ? authErrorId : undefined}
                    />
                  </label>
                  {authFeedback ? (
                    <p
                      id={authErrorId}
                      role="alert"
                      className={`text-xs ${
                        authFeedback.tone === "info" ? "text-amber-300" : "text-red-400"
                      }`}
                    >
                      {authFeedback.message}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    className="w-full rounded-none"
                    disabled={authMutation.isPending}
                    aria-disabled={!authCanSubmit || authMutation.isPending}
                  >
                    {authMutation.isPending
                      ? t("pages.inviteLanding.working", { defaultValue: "Working..." })
                      : authMode === "sign_in"
                        ? t("pages.inviteLanding.signInAndContinue", {
                            defaultValue: "Sign in and continue",
                          })
                        : t("pages.inviteLanding.createAccountAndContinue", {
                            defaultValue: "Create account and continue",
                          })}
                  </Button>
                </form>

                <p className="text-xs leading-5 text-zinc-500">
                  {authMode === "sign_up"
                    ? t("pages.inviteLanding.alreadySignedUpHint", {
                        defaultValue:
                          "Already signed up before? Use the existing-account option instead so the invite lands on the right Paperclip user.",
                      })
                    : t("pages.inviteLanding.noAccountYetHint", {
                        defaultValue:
                          "No account yet? Switch back to create account so you can accept the invite with a new login.",
                      })}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">
                    {isCurrentMember
                      ? t("pages.inviteLanding.alreadyInThisCompany", {
                          defaultValue: "Already in this company",
                        })
                      : shouldAutoAcceptHumanInvite
                      ? t("pages.inviteLanding.completingCompanyAccess", {
                          defaultValue: "Completing company access",
                        })
                      : invite.inviteType === "bootstrap_ceo"
                        ? t("pages.inviteLanding.acceptBootstrapInvite", {
                            defaultValue: "Accept bootstrap invite",
                          })
                        : t("pages.inviteLanding.acceptCompanyInvite", {
                            defaultValue: "Accept company invite",
                          })}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    {shouldAutoAcceptHumanInvite
                      ? t("pages.inviteLanding.grantingYourAccess", {
                          company: companyDisplayName,
                          defaultValue: "Granting your access to {{company}}.",
                        })
                      : isCurrentMember
                      ? t("pages.inviteLanding.accountAlreadyBelongs", {
                          company: companyDisplayName,
                          defaultValue: "This account already belongs to {{company}}.",
                        })
                      : invite.inviteType === "bootstrap_ceo"
                        ? t("pages.inviteLanding.willFinishSetup", {
                            defaultValue: "This will finish setting up Paperclip.",
                          })
                        : t("pages.inviteLanding.willGrantAccess", {
                            company: companyDisplayName,
                            defaultValue:
                              "This will grant or complete your access to {{company}}.",
                          })}
                  </p>
                </div>
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
                {shouldAutoAcceptHumanInvite ? (
                  <div className="text-sm text-zinc-400">
                    {acceptMutation.isPending
                      ? t("pages.inviteLanding.submittingRequest", {
                          defaultValue: "Submitting request...",
                        })
                      : t("pages.inviteLanding.finishingSignIn", {
                          defaultValue: "Finishing sign-in...",
                        })}
                  </div>
                ) : (
                  <Button
                    className="w-full rounded-none"
                    disabled={acceptMutation.isPending}
                    onClick={() => {
                      if (isCurrentMember && invite.companyId) {
                        clearPendingInviteToken(token);
                        setSelectedCompanyId(invite.companyId, { source: "manual" });
                        navigate("/", { replace: true });
                        return;
                      }
                      acceptMutation.mutate();
                    }}
                  >
                    {acceptMutation.isPending
                      ? t("pages.inviteLanding.working", { defaultValue: "Working..." })
                      : joinButtonLabel}
                  </Button>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
