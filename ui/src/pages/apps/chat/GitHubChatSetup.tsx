import { useTranslation, t as translate } from "@/i18n";
import { useAuthorizationWindow } from "@/hooks/useAuthorizationWindow";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
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
import { GITHUB_APP_CREDENTIAL_FIELDS, GitHubAppRecovery } from "./GitHubConnectionRecovery";
import type { GitHubConnectionCompleteLocationState } from "./GitHubConnectionComplete";
import { describeError } from "@/api/errors";

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
    throw new Error(translate("connections:github_returned_an_invalid_registration_address_d156091"));
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
  const { t } = useTranslation("connections");
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
        <Button type="submit" disabled={disabled}>{t("continue_to_github_3e2dc4d")}</Button>
      </SetupWizardFooter>
    </form>
  );
}
export function GitHubChatSetup() {
  const { t } = useTranslation("connections");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const resume = params.get("resume");
  const identityOnly = params.get("stage") === "identity";
  const rotateWebhookSecret = params.get("rotateSecret") === "1";
  const reconnect = params.get("reconnect") === "1" || rotateWebhookSecret;
  const credentialFields = reconnect && !rotateWebhookSecret && params.get("stage") === "credentials"
    ? GITHUB_APP_CREDENTIAL_FIELDS.filter(field => !params.has("credentialFields") || params.get("credentialFields")!.split(",").includes(field))
    : undefined;
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
  const [existing, setExisting] = useState(reconnect || params.get("stage") === "credentials");
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
  const currentView = useQueryView(current);
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
  });
  const progressView = useQueryView(progress);
  const accounts = useQuery({
    queryKey: ["github-personal-connections", resume],
    queryFn: () => githubChatApi.personalConnections(resume!),
    enabled: !!bot && (identityOnly || progress.data?.state === "identity"),
  });
  const accountsView = useQueryView(accounts);
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
  const repositoriesView = useQueryView(repositories);
  const connectedBots = useQuery({
    queryKey: queryKeys.chatEndpoints.list(selectedCompanyId!),
    queryFn: () => chatEndpointsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && choosingAccount,
    staleTime: 30_000,
  });
  const connectedBotsView = useQueryView(connectedBots);
  const setupReadFailure = accountsView.kind === "error" ? accountsView
    : !identityOnly && progressView.kind === "error" ? progressView : null;
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
      { label: t("connectors_4b1e950"), href: "/apps" },
      { label: t("github_code_review_bot_f2e2bc9") },
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
  const authorization = useAuthorizationWindow();
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      authorization.cancel();
      setError(
        describeError(error).body,
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
        <h1 className="text-2xl font-semibold">{t("resume_github_setup_ca47a0e")}</h1>
        {currentView.kind === "error" ? (
          <p role="alert" className="text-sm text-destructive">{t("could_not_load_this_connection_try_again_37e16ac")}</p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">{t("loading_your_draft_3bc6859")}</p>
        )}
        {footer(currentView.kind === "error" ? t("try_again_042c862") : undefined, async () => {
          await current.refetch();
        })}
      </div>
    );
  if (connected) return null;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      {authorization.fallback}
      {!identityOnly && (
        <SetupWizardNavigation
          labels={reconnect ? ["Reconnect GitHub"] : ["Choose agent", "Connect GitHub"]}
          step={reconnect ? 0 : bot ? 1 : 0}
          availableStep={reconnect ? 0 : bot ? 1 : 0}
          onSelect={() => {}}
          disabled
          takeover
        />
      )}
      <h1 className="text-2xl font-semibold">
        {!bot
          ? t("choose_agent_08bb320")
          : identityOnly || state?.state === "identity"
              ? t("connect_your_account_9f431f7")
              : reconnect && existing ? t("reconnect_github_4b320de") : t("connect_github_ab6f5ed")}
      </h1>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : setupReadFailure ? (
        <QueryErrorState
          size="inline"
          error={setupReadFailure.error}
          action="check GitHub setup"
          onRetry={setupReadFailure.retry}
          retrying={setupReadFailure.isFetching}
        />
      ) : null}
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
            t("continue_2e02623"),
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
      ) : !identityOnly && !existing && (progress.isPending || progressView.kind === "reconnecting") ? (
        <>
          <p role="status" className="text-sm text-muted-foreground">{t("checking_your_github_connection_88c4eaa")}</p>
          {footer()}
        </>
      ) : existing ? (
        <GitHubAppRecovery
          key={`${bot.id}:${rotateWebhookSecret ? params.get("afterRotationId") ?? "unspecified" : credentialFields?.join(",") ?? "credentials"}`}
          endpoint={bot}
          reconnect={reconnect}
          credentialFields={credentialFields}
          requireAllCredentialFields={params.get("credentialMode") === "all"}
          rotateWebhookSecret={rotateWebhookSecret}
          rotationAlreadyCommitted={params.has("afterRotationId") && !!bot.setup?.credentialRotationId && bot.setup.credentialRotationId !== params.get("afterRotationId")}
          onExit={exit}
          onConnect={async (credentials) => {
            if (reconnect || ["active", "paused", "revoked"].includes(bot.status)) {
              await chatEndpointsApi.setup(bot.id, {
                action: "reconnect",
                ...(credentials ? { credentials: Object.fromEntries(Object.entries(credentials).filter(([field, value]) =>
                  value?.trim() && (!credentialFields || credentialFields.some(requested => requested === field) || (field === "appId" && !!credentials.privateKey.trim() && credentialFields.includes("privateKey"))),
                ).map(([field, value]) => [field, field === "appId" ? value!.trim() : value])) } : {}),
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
              <p role="status" className="text-sm">{t("github_account_5131af3")}<strong>{legacyIdentity?.login}</strong>{" "}{t("connected_you_can_now_mention_this_bot_3d34169")}</p>
              {footer()}
            </>
          ) : state?.identity ? (
            <>
              <p className="text-sm">{t("connect_github_account_99c0ba3")}<strong>{state.identity.login}</strong>{" "}{t("to_your_paperclip_account_32209ba")}</p>
              {footer(t("confirm_my_account_a168c29"), async () => {
                await githubChatApi.confirmIdentity(
                  bot.id,
                  state.identity!.githubUserId,
                );
                await refresh();
              })}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t("link_your_github_account_so_your_mentions_4cb0377")}</p>
              {(accounts.data?.length ?? 0) > 0 && (
                <>
                  <Label htmlFor="github-personal-account">{t("existing_github_connection_2fa1cfa")}</Label>
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
                    <option value="">{t("choose_an_account_dc4922c")}</option>
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
                    <p className="text-sm">{t("github_account_5715720")}<strong>{legacyIdentity.login}</strong>
                    </p>
                  )}
                </>
              )}
              {existingIdentityMethod && !legacyAccount && (
                <Link
                  className="text-sm underline"
                  to="/apps/connect?source=github"
                >{t("add_a_personal_github_connection_then_return_0adf1df")}</Link>
              )}
              {footer(
                legacyAccount
                  ? legacyIdentity
                    ? t("confirm_my_account_a168c29")
                    : t("check_my_account_00b7867")
                  : t("connect_my_github_account_52bb807"),
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
                    authorization.reserve();
                    const result = await githubChatApi.startIdentity(bot.id);
                    await authorization.open(result.authorizationUrl);
                  }
                },
                existingIdentityMethod && !legacyAccount,
              )}
            </>
          )}
        </>
      ) : state?.state === "install" ? (
        <>
          <p role="status" className="text-sm text-muted-foreground">{t("waiting_for_github_installation_or_administrator_approval_9b69b8b")}</p>
          {state.installationUrl && (
            <a
              className="inline-flex items-center gap-1 text-sm underline"
              href={state.installationUrl} target="_blank" rel="noopener noreferrer"
            >
              {t("continue_installation_on_github_96e47f1")}
              <ExternalLink className="size-3" />
            </a>
          )}
          {footer()}
        </>
      ) : state?.state === "enrollment" ? (
        <>
          <p className="text-sm">
            Paperclip Cloud receives GitHub events and securely delivers them to
            this instance.
          </p>
          {footer(t("connect_paperclip_cloud_dde4d6e"), async () => {
            authorization.reserve();
            const result = await toolsApi.startCloudConnectorEnrollment(
              selectedCompanyId!,
              undefined,
              `/apps/chat/connect${window.location.search}`,
            );
            if (!result.verificationUrl)
              throw new Error(t("cloud_enrollment_could_not_be_started_39966f0"));
            await authorization.open(result.verificationUrl);
          })}
        </>
      ) : state?.state === "recovery" ? (
        <>
          <p role="status" className="text-sm">
            {state.message}
          </p>
          <Button variant="ghost" onClick={() => setExisting(true)}>{t("use_existing_app_credentials_d4b0167")}</Button>
          {state.restartableRegistrationId && (
            <div className="flex items-center gap-2">
              <Checkbox id="github-app-not-created" checked={appNotCreated} disabled={busy}
                onCheckedChange={(checked) => setAppNotCreated(checked === true)} />
              <Label htmlFor="github-app-not-created">{t("i_haven_t_created_this_app_on_b7891cf")}</Label>
            </div>
          )}
          {state.restartableRegistrationId
            ? footer(t("continue_to_github_3e2dc4d"), async () => {
                const result = await githubChatApi.restartRegistration(bot.id, state.restartableRegistrationId!);
                setAppNotCreated(false);
                queryClient.setQueryData(["github-wizard", bot.id], result);
                if (result.registration) setSubmitManifest(true);
              }, !appNotCreated)
            : footer(t("try_again_042c862"), refresh)}
        </>
      ) : state?.state === "verify" ? (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {deliveryVerifiedWhileChecking
              ? t("github_delivery_verified_checking_app_and_repository_814d551")
              : state.message ?? t("checking_github_access_fc6baa7")}
          </p>
          {state.verification?.checks
            .filter(
              (check) =>
                !check.ok &&
                !(deliveryVerifiedWhileChecking && ["webhook", "delivery"].includes(check.key)),
            )
            .map((check) => (
              <p key={check.key} className="text-sm">
                {check.detail}
              </p>
            ))}
          <Link
            className="text-sm underline"
            to={`/apps/chat/${bot.id}/settings`}
          >{t("connection_settings_1ca0f44")}</Link>
          {footer(t("try_again_042c862"), refresh)}
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="github-owner-type">{t("github_account_de64997")}</Label>
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
              <option value="personal">{t("my_account_6190981")}</option>
              {knownOrganizations.map((login) => (
                <option key={login.toLowerCase()} value={`organization:${login}`}>{login}</option>
              ))}
              <option value="organization">{t("another_organization_683a21e")}</option>
            </select>
            {(repositoriesView.kind === "error" || connectedBotsView.kind === "error") && (
              <p role="alert" className="text-sm text-destructive">{t("could_not_load_some_connected_github_accounts_0741518")}</p>
            )}
          </div>
          {accountChoice === "organization" && (
            <div className="space-y-2">
              <Label htmlFor="github-owner-login">{t("organization_519255a")}</Label>
              <Input
                id="github-owner-login"
                disabled={busy || !!state?.registration}
                value={ownerLogin}
                onChange={(event) => setOwnerLogin(event.target.value)}
                placeholder={t("github_organization_name_4ecde31")}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="github-app-name">{t("app_name_c877cbb")}</Label>
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
          >{t("i_already_have_an_app_7660f18")}</button>
          {state?.registration ? (
            <GitHubAppManifestForm registration={state.registration} onSaveExit={exit}
              disabled={busy} autoSubmit={submitManifest} onSubmit={() => setSubmitManifest(false)} />
          ) : footer(
            t("continue_to_github_3e2dc4d"),
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
