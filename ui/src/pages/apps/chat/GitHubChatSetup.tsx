import { githubVerificationText } from "./chat-copy";
import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import type { GitHubAppWizardState } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { githubChatApi } from "@/api/githubChat";
import { projectsApi } from "@/api/projects";
import { toolsApi } from "@/api/tools";
import { AgentSelect } from "@/components/AgentMultiSelect";
import { GitHubAgentTrustWarning } from "@/components/GitHubAgentTrustWarning";
import {
  SetupWizardNavigation,
  SetupWizardFooter,
} from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { buildPermissionsForTrustPreset } from "@/lib/trust-policy-ui";
import { queryKeys } from "@/lib/queryKeys";
import { GitHubAppRecovery } from "./GitHubConnectionRecovery";
import type { GitHubConnectionCompleteLocationState } from "./GitHubConnectionComplete";

/** Restrict native manifest submission to GitHub registration endpoints. */
export function gitHubAppManifestAction(
  registration: NonNullable<GitHubAppWizardState["registration"]>,
) {
  const url = new URL(registration.registrationUrl);
  if (
    url.origin !== "https://github.com" ||
    url.username || url.password || url.hash ||
    !/^\/(settings|organizations\/[A-Za-z0-9-]+\/settings)\/apps\/new$/.test(
      url.pathname,
    )
  )
    throw new Error(t("oct19Apps.invalidGitHubRegistration"));
  return url.toString();
}
function GitHubAppManifestForm({
  registration, onSaveExit, disabled, autoSubmit, onSubmit,
}: {
  registration: NonNullable<GitHubAppWizardState["registration"]>;
  onSaveExit: () => void;
  disabled: boolean;
  autoSubmit: boolean;
  onSubmit: () => void;
}) {
  useTranslation();
  const form = useRef<HTMLFormElement>(null);
  const requested = useRef(false);
  useEffect(() => {
    if (!autoSubmit) requested.current = false;
    if (autoSubmit && !disabled && !requested.current && form.current) {
      requested.current = true;
      form.current.requestSubmit();
    }
  }, [autoSubmit, disabled]);
  return (
    <form
      ref={form}
      method="post"
      action={gitHubAppManifestAction(registration)}
      onSubmit={onSubmit}
    >
      <input type="hidden" name="manifest" value={JSON.stringify(registration.manifest)} />
      <SetupWizardFooter onSaveExit={onSaveExit} disabled={disabled}>
        <Button type="submit" disabled={disabled}>{t("localizationConnections.continueToGitHub149")}</Button>
      </SetupWizardFooter>
    </form>
  );
}
export function GitHubChatSetup() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const resume = params.get("resume");
  const identityOnly = params.get("stage") === "identity";
  const reconnect = params.get("reconnect") === "1";
  const [agentId, setAgentId] = useState(params.get("agentId") ?? "");
  const [ownerType, setOwnerType] = useState<"personal" | "organization">(
    "personal",
  );
  const [ownerLogin, setOwnerLogin] = useState("");
  const [customOrganization, setCustomOrganization] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitManifest, setSubmitManifest] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState(params.get("reconnect") === "1");
  const [appNotCreated, setAppNotCreated] = useState(false);
  const [legacyAccount, setLegacyAccount] = useState("");
  const [identityLinked, setIdentityLinked] = useState(false);
  const [legacyIdentity, setLegacyIdentity] = useState<Awaited<
    ReturnType<typeof githubChatApi.identity>
  > | null>(null);
  const agents = useQuery({
    queryKey: ["github-setup-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !identityOnly,
  });
  const current = useQuery({
    queryKey: ["github-setup", resume],
    queryFn: () => chatEndpointsApi.get(resume!),
    enabled: !!resume,
    refetchInterval: 3000,
  });
  const bot = current.data;
  const progress = useQuery({
    queryKey: ["github-wizard", resume],
    queryFn: () => githubChatApi.advance(resume!),
    enabled: !!bot && !existing && !identityOnly,
    refetchInterval: (query) =>
      ["connected", "create", "identity", "enrollment", "recovery"].includes(
        query.state.data?.state ?? "",
      )
        ? false
        : 5000,
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ["github-personal-connections", resume],
    queryFn: () => githubChatApi.personalConnections(resume!),
    enabled: !!bot && (identityOnly || progress.data?.state === "identity"),
  });
  const selectedAgent = agents.data?.find(
    (agent) => agent.id === (bot?.assignedAgentId ?? agentId),
  );
  const state = identityOnly ? undefined : progress.data;
  const choosingAccount = !!bot && !identityOnly && !existing && state?.state === "create";
  const repositories = useQuery({
    queryKey: ["project-repositories", selectedCompanyId],
    queryFn: () => projectsApi.repositoryOptions(selectedCompanyId!),
    enabled: !!selectedCompanyId && choosingAccount,
    staleTime: 30_000,
  });
  const connectedBots = useQuery({
    queryKey: queryKeys.chatEndpoints.list(selectedCompanyId!),
    queryFn: () => chatEndpointsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && choosingAccount,
    staleTime: 30_000,
  });
  const organizations = new Map<string, string>();
  for (const repository of repositories.data?.repositories ?? []) {
    if (repository.ownerType !== "organization") continue;
    const login = repository.fullName.split("/")[0];
    organizations.set(login.toLowerCase(), login);
  }
  for (const endpoint of connectedBots.data ?? []) {
    const github = endpoint.setup?.github;
    if (endpoint.provider === "github" && ["active", "paused"].includes(endpoint.status) &&
        github?.ownerType === "organization" && github.ownerLogin) {
      organizations.set(github.ownerLogin.toLowerCase(), github.ownerLogin);
    }
  }
  const knownOrganizations = [...organizations.values()].sort((a, b) => a.localeCompare(b));
  const knownOwner = organizations.get(ownerLogin.toLowerCase());
  const accountChoice = ownerType === "personal" ? "personal"
    : !customOrganization && knownOwner ? `organization:${knownOwner}` : "organization";
  const deliveryVerifiedWhileChecking =
    state?.state === "verify" &&
    !!bot?.setup?.webhookVerifiedAt &&
    state.verification?.checks.some(
      (check) => !check.ok && ["webhook", "delivery"].includes(check.key),
    );
  const existingIdentityMethod =
    identityOnly || state?.identityMethod === "existing_connection";
  const connected = state?.state === "connected" && !existing;
  useEffect(() => {
    if (!connected || !bot) return;
    queryClient.setQueryData(queryKeys.chatEndpoints.detail(bot.id), bot);
    if (selectedAgent) queryClient.setQueryData(queryKeys.agents.detail(selectedAgent.id), selectedAgent);
    navigate(`/apps/chat/${bot.id}/settings`, {
      replace: true,
      state: {
        githubConnectionComplete: { endpointId: bot.id, runtimeChecks: state.runtimeChecks },
      } satisfies GitHubConnectionCompleteLocationState,
    });
  }, [connected, bot, selectedAgent, state, queryClient, navigate]);
  useEffect(() => {
    setBreadcrumbs([
      { label: t("localizationConnections.connectors16"), href: "/apps" },
      { label: t("oct5Apps.copy059") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);
  useEffect(() => {
    if (bot) {
      setAgentId(bot.assignedAgentId);
      if (bot.setup?.github?.ownerType)
        setOwnerType(bot.setup.github.ownerType);
      setOwnerLogin(bot.setup?.github?.ownerLogin ?? "");
      setCustomOrganization(false);
      if (bot.setup?.github?.appName) setName(bot.setup.github.appName);
    }
  }, [
    bot?.id,
    bot?.setup?.github?.ownerType,
    bot?.setup?.github?.ownerLogin,
    bot?.setup?.github?.appName,
  ]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t("oct19Apps.githubConnectFailed"),
      );
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const verification = !identityOnly ? await progress.refetch() : undefined;
    const updated = await current.refetch();
    if (verification?.error) throw verification.error;
    if (updated.error) throw updated.error;
  }
  const appInput = () => ({
    name: (
      name ||
      selectedAgent?.name ||
      bot?.assignedAgentName ||
      "GitHub Reviewer"
    ).slice(0, 34),
    ownerType,
    ...(ownerType === "organization" ? { ownerLogin: ownerLogin.trim() } : {}),
  });
  const exit = () =>
    void run(async () => {
      if (
        !identityOnly &&
        !reconnect &&
        bot &&
        !bot.botExternalId &&
        !state?.registration &&
        state?.state !== "recovery"
      ) {
        await githubChatApi.saveDraft(bot.id, appInput());
        await current.refetch();
      }
      navigate("/apps");
    });
  const footer = (
    label?: string,
    action?: () => Promise<void>,
    disabled = false,
  ) => (
    <SetupWizardFooter onSaveExit={exit} disabled={busy}>
      {label && action && (
        <Button disabled={busy || disabled} onClick={() => void run(action)}>
          {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
          {label}
        </Button>
      )}
    </SetupWizardFooter>
  );
  if (resume && !bot)
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        <h1 className="text-2xl font-semibold">{t("oct19Apps.resumeGitHub")}</h1>
        {current.error ? (
          <p role="alert" className="text-sm text-destructive">
            {t("oct19Apps.githubDraftLoadFailed")}</p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t("oct19Apps.loadingDraft")}</p>
        )}
        {footer(current.error ? t("localizationProjectRepositories.retry") : undefined, async () => {
          await current.refetch();
        })}
      </div>
    );
  if (connected) return null;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      {!identityOnly && (
        <SetupWizardNavigation
          labels={reconnect ? [t("oct26Finish.reconnectGithub")] : [t("chatUi.chatEndpointSetup.chooseAgent"), t("localizationProjectRepositories.connectGithub")]}
          step={reconnect ? 0 : bot ? 1 : 0}
          availableStep={reconnect ? 0 : bot ? 1 : 0}
          onSelect={() => {}}
          disabled
          takeover
        />
      )}
      <h1 className="text-2xl font-semibold">
        {!bot
          ? t("chatUi.chatEndpointSetup.chooseAgent")
          : identityOnly || state?.state === "identity"
              ? t("sep28Apps.copy111")
              : reconnect && existing ? t("oct26Finish.reconnectGithub") : t("localizationProjectRepositories.connectGithub")}
      </h1>
      {(error || (!identityOnly && !existing && progress.error) || accounts.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ||
            (accounts.error instanceof Error
              ? accounts.error.message
              : undefined) ||
            (progress.error instanceof Error
              ? progress.error.message
              : t("oct19Apps.githubSetupCheckFailed"))}
        </p>
      )}
      {!bot ? (
        <>
          <AgentSelect
            agents={agents.data ?? []}
            value={agentId}
            onChange={setAgentId}
          />
          {selectedAgent && (
            <GitHubAgentTrustWarning
              agent={selectedAgent}
              disabled={busy}
              onChangeToLowTrust={() =>
                void run(async () => {
                  const permissions = buildPermissionsForTrustPreset(
                    selectedAgent.permissions,
                    "low_trust_review",
                  );
                  await agentsApi.updatePermissions(
                    selectedAgent.id,
                    {
                      ...permissions,
                      canCreateAgents: false,
                      canCreateSkills: false,
                      canAssignTasks:
                        typeof selectedAgent.permissions.canAssignTasks ===
                        "boolean"
                          ? selectedAgent.permissions.canAssignTasks
                          : true,
                    },
                    selectedCompanyId!,
                  );
                  await queryClient.invalidateQueries({
                    queryKey: ["github-setup-agents", selectedCompanyId],
                  });
                })
              }
            />
          )}
          {footer(
            t("pages.inviteLanding.actions.continue"),
            async () => {
              const created = await chatEndpointsApi.create(
                selectedCompanyId!,
                { provider: "github", assignedAgentId: agentId },
              );
              setName((selectedAgent?.name ?? "GitHub Reviewer").slice(0, 34));
              const next = new URLSearchParams(params);
              next.set("resume", created.id);
              setParams(next, { replace: true });
              queryClient.setQueryData(["github-setup", created.id], created);
            },
            !agentId || !selectedCompanyId,
          )}
        </>
      ) : !identityOnly && !existing && progress.isPending ? (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {t("oct19Apps.checkingGitHub")}</p>
          {footer()}
        </>
      ) : existing ? (
        <GitHubAppRecovery
          key={bot.id}
          endpoint={bot}
          reconnect={reconnect}
          onExit={exit}
          onConnect={async (credentials) => {
            if (reconnect || ["active", "paused", "revoked"].includes(bot.status)) {
              await chatEndpointsApi.setup(bot.id, {
                action: "reconnect",
                ...(credentials ? { credentials: { appId: credentials.appId.trim(), privateKey: credentials.privateKey } } : {}),
              });
            } else if (credentials) {
              await githubChatApi.connectApp(bot.id, credentials);
            }
            queryClient.removeQueries({ queryKey: ["github-wizard", bot.id] });
            await queryClient.invalidateQueries({ queryKey: queryKeys.chatEndpoints.detail(bot.id) });
            await queryClient.invalidateQueries({ queryKey: queryKeys.chatEndpoints.list(bot.companyId) });
            await refresh();
            setExisting(false);
          }}
        />
      ) : state?.state === "identity" || identityOnly ? (
        <>
          {identityOnly && identityLinked ? (
            <>
              <p role="status" className="text-sm">
                <Trans i18nKey="oct19Apps.githubLinked" values={{ login: legacyIdentity?.login }} components={{ account: <strong /> }} />
              </p>
              {footer()}
            </>
          ) : state?.identity ? (
            <>
              <p className="text-sm">
                <Trans i18nKey="oct19Apps.githubConfirmAccount" values={{ login: state.identity.login }} components={{ account: <strong /> }} />
              </p>
              {footer(t("oct19Apps.confirmMyAccount"), async () => {
                await githubChatApi.confirmIdentity(
                  bot.id,
                  state.identity!.githubUserId,
                );
                await refresh();
              })}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t("oct19Apps.githubLinkPermissions")}</p>
              {(accounts.data?.length ?? 0) > 0 && (
                <>
                  <Label htmlFor="github-personal-account">
                    {t("oct19Apps.existingGitHubConnection")}</Label>
                  <select
                    id="github-personal-account"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={legacyAccount}
                    onChange={(event) => {
                      setLegacyAccount(event.target.value);
                      setLegacyIdentity(null);
                      setIdentityLinked(false);
                    }}
                  >
                    <option value="">{t("oct19Apps.chooseAccount")}</option>
                    {accounts.data
                      ?.filter(
                        (account) =>
                          account.status === "active" && account.enabled,
                      )
                      .map((account) => (
                        <option
                          key={account.connectionId}
                          value={account.connectionId}
                        >
                          {account.login ?? account.name}
                        </option>
                      ))}
                  </select>
                  {legacyIdentity && (
                    <p className="text-sm">
                      {t("oct19Apps.githubAccountLabel")} <strong>{legacyIdentity.login}</strong>
                    </p>
                  )}
                </>
              )}
              {existingIdentityMethod && !legacyAccount && (
                <Link
                  className="text-sm underline"
                  to="/apps/connect?source=github"
                >
                  {t("oct19Apps.addPersonalGitHub")}</Link>
              )}
              {footer(
                legacyAccount
                  ? legacyIdentity
                    ? t("oct19Apps.confirmMyAccount")
                    : t("oct19Apps.checkMyAccount")
                  : t("oct19Apps.connectMyGitHub"),
                async () => {
                  if (legacyAccount) {
                    const observed = await githubChatApi.identity(
                      bot.id,
                      legacyAccount,
                      legacyIdentity?.githubUserId,
                    );
                    setLegacyIdentity(observed);
                    if (legacyIdentity) {
                      setIdentityLinked(true);
                      await refresh();
                    }
                  } else {
                    const result = await githubChatApi.startIdentity(bot.id);
                    window.location.assign(result.authorizationUrl);
                  }
                },
                existingIdentityMethod && !legacyAccount,
              )}
            </>
          )}
        </>
      ) : state?.state === "install" ? (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {t("oct19Apps.waitingGitHubInstall")}</p>
          {state.installationUrl && (
            <a
              className="inline-flex items-center gap-1 text-sm underline"
              href={state.installationUrl}
            >
              {t("oct19Apps.continueGitHubInstall")}<ExternalLink className="size-3" />
            </a>
          )}
          {footer()}
        </>
      ) : state?.state === "enrollment" ? (
        <>
          <p className="text-sm">
            {t("oct19Apps.githubCloudEvents")}</p>
          {footer(t("oct19Apps.connectPaperclipCloud"), async () => {
            const result = await toolsApi.startCloudConnectorEnrollment(
              selectedCompanyId!,
              undefined,
              `/apps/chat/connect${window.location.search}`,
            );
            if (!result.verificationUrl)
              throw new Error(t("oct19Apps.cloudEnrollmentFailed"));
            window.location.assign(result.verificationUrl);
          })}
        </>
      ) : state?.state === "recovery" ? (
        <>
          <p role="status" className="text-sm">
            {state.message}
          </p>
          <Button variant="ghost" onClick={() => setExisting(true)}>
            {t("oct19Apps.useAppCredentials")}</Button>
          {state.restartableRegistrationId && (
            <div className="flex items-center gap-2">
              <Checkbox id="github-app-not-created" checked={appNotCreated} disabled={busy}
                onCheckedChange={(checked) => setAppNotCreated(checked === true)} />
              <Label htmlFor="github-app-not-created">{t("oct19Apps.appNotCreated")}</Label>
            </div>
          )}
          {state.restartableRegistrationId
            ? footer(t("localizationConnections.continueToGitHub149"), async () => {
                const result = await githubChatApi.restartRegistration(bot.id, state.restartableRegistrationId!);
                setAppNotCreated(false);
                queryClient.setQueryData(["github-wizard", bot.id], result);
                if (result.registration) setSubmitManifest(true);
              }, !appNotCreated)
            : footer(t("localizationProjectRepositories.retry"), refresh)}
        </>
      ) : state?.state === "verify" ? (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {deliveryVerifiedWhileChecking
              ? t("oct19Apps.githubVerifiedCheckingAccess")
              : state.message ?? t("oct19Apps.checkingGitHubAccess")}
          </p>
          {state.verification?.checks
            .filter(
              (check) =>
                !check.ok &&
                !(deliveryVerifiedWhileChecking && ["webhook", "delivery"].includes(check.key)),
            )
            .map((check) => (
              <p key={check.key} className="text-sm">
                {githubVerificationText(check.detail)}
              </p>
            ))}
          <Link
            className="text-sm underline"
            to={`/apps/chat/${bot.id}/settings`}
          >
            {t("sep28Apps.copy1")}</Link>
          {footer(t("localizationProjectRepositories.retry"), refresh)}
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="github-owner-type">{t("localizationApps.githubAccount")}</Label>
            <select
              id="github-owner-type"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={accountChoice}
              disabled={busy || !!state?.registration}
              onChange={(event) => {
                const choice = event.target.value;
                setOwnerType(choice === "personal" ? "personal" : "organization");
                setCustomOrganization(choice === "organization");
                if (choice.startsWith("organization:")) setOwnerLogin(choice.slice("organization:".length));
                else if (choice === "organization") setOwnerLogin("");
              }}
            >
              <option value="personal">{t("sep28Apps.copy299")}</option>
              {knownOrganizations.map((login) => (
                <option key={login.toLowerCase()} value={`organization:${login}`}>{login}</option>
              ))}
              <option value="organization">{t("oct19Apps.anotherOrganization")}</option>
            </select>
            {(repositories.isError || connectedBots.isError) && (
              <p role="alert" className="text-sm text-destructive">
                {t("oct19Apps.githubAccountsLoadFailed")}</p>
            )}
          </div>
          {accountChoice === "organization" && (
            <div className="space-y-2">
              <Label htmlFor="github-owner-login">{t("nav.company")}</Label>
              <Input
                id="github-owner-login"
                disabled={busy || !!state?.registration}
                value={ownerLogin}
                onChange={(event) => setOwnerLogin(event.target.value)}
                placeholder={t("oct19Apps.githubOrganizationName")}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="github-app-name">{t("pages.apps.detail.appNameAria")}</Label>
            <Input
              id="github-app-name"
              disabled={busy || !!state?.registration}
              maxLength={34}
              value={
                name ||
                selectedAgent?.name?.slice(0, 34) ||
                bot.assignedAgentName?.slice(0, 34) ||
                "GitHub Reviewer"
              }
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <button
            className="text-sm text-muted-foreground underline"
            onClick={() => setExisting(true)}
          >
            {t("oct19Apps.alreadyHaveApp")}</button>
          {state?.registration ? (
            <GitHubAppManifestForm registration={state.registration} onSaveExit={exit}
              disabled={busy} autoSubmit={submitManifest} onSubmit={() => setSubmitManifest(false)} />
          ) : footer(
            t("localizationConnections.continueToGitHub149"),
            async () => {
              const result = await githubChatApi.registration(bot.id, appInput());
              queryClient.setQueryData(["github-wizard", bot.id], result);
              if (result.registration) setSubmitManifest(true);
            },
            progress.isPending || (ownerType === "organization" && !ownerLogin.trim()),
          )}
        </>
      )}
    </div>
  );
}
