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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { buildPermissionsForTrustPreset } from "@/lib/trust-policy-ui";
import { queryKeys } from "@/lib/queryKeys";
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
    throw new Error("GitHub returned an invalid registration address");
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
        <Button type="submit" disabled={disabled}>Continue to GitHub</Button>
      </SetupWizardFooter>
    </form>
  );
}
export function GitHubChatSetup() {
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
  const [credentials, setCredentials] = useState({
    appId: "",
    privateKey: "",
    webhookSecret: "",
  });
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
      { label: "Connectors", href: "/apps" },
      { label: "GitHub Code Review Bot" },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);
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
        describeError(error).body,
      );
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    await current.refetch();
    if (!identityOnly) await progress.refetch();
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
        <h1 className="text-2xl font-semibold">Resume GitHub setup</h1>
        {currentView.kind === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load this connection. Try again to resume your draft.
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Loading your draft…
          </p>
        )}
        {footer(currentView.kind === "error" ? "Try again" : undefined, async () => {
          await current.refetch();
        })}
      </div>
    );
  if (connected) return null;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      {!identityOnly && (
        <SetupWizardNavigation
          labels={["Choose agent", "Connect GitHub"]}
          step={bot ? 1 : 0}
          availableStep={bot ? 1 : 0}
          onSelect={() => {}}
          disabled
          takeover
        />
      )}
      <h1 className="text-2xl font-semibold">
        {!bot
          ? "Choose agent"
          : identityOnly || state?.state === "identity"
              ? "Connect your account"
              : "Connect GitHub"}
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
            "Continue",
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
          <p role="status" className="text-sm text-muted-foreground">
            Checking your GitHub connection…
          </p>
          {footer()}
        </>
      ) : existing ? (
        <>
          <p className="text-sm text-muted-foreground">
            {reconnect
              ? "Leave these blank to reuse this App’s stored credentials, or enter both fields to repair them."
              : "Use the credentials from this App’s GitHub settings."}
          </p>
          <Label htmlFor="github-app-id">App ID</Label>
          <Input
            id="github-app-id"
            value={credentials.appId}
            onChange={(event) =>
              setCredentials({ ...credentials, appId: event.target.value })
            }
          />
          <Label htmlFor="github-private-key">Private key</Label>
          <Textarea
            id="github-private-key"
            value={credentials.privateKey}
            onChange={(event) =>
              setCredentials({ ...credentials, privateKey: event.target.value })
            }
          />
          {!reconnect &&
            !["active", "paused", "revoked"].includes(bot.status) && (
              <>
                <Label htmlFor="github-webhook-secret">Webhook secret</Label>
                <Input
                  id="github-webhook-secret"
                  type="password"
                  value={credentials.webhookSecret}
                  onChange={(event) =>
                    setCredentials({
                      ...credentials,
                      webhookSecret: event.target.value,
                    })
                  }
                />
              </>
            )}
          {footer(
            reconnect ? "Reconnect App" : "Connect existing App",
            async () => {
              if (
                reconnect ||
                ["active", "paused", "revoked"].includes(bot.status)
              )
                await chatEndpointsApi.setup(bot.id, {
                  action: "reconnect",
                  ...(credentials.appId.trim() || credentials.privateKey.trim()
                    ? {
                        credentials: {
                          appId: credentials.appId,
                          privateKey: credentials.privateKey,
                        },
                      }
                    : {}),
                });
              else await githubChatApi.connectApp(bot.id, credentials);
              setCredentials({ appId: "", privateKey: "", webhookSecret: "" });
              setExisting(false);
              await refresh();
            },
            reconnect
              ? !!(credentials.appId.trim() || credentials.privateKey.trim()) &&
                  (!credentials.appId.trim() || !credentials.privateKey.trim())
              : !credentials.appId.trim() ||
                  !credentials.privateKey.trim() ||
                  (!["active", "paused", "revoked"].includes(bot.status) &&
                    !credentials.webhookSecret.trim()),
          )}
        </>
      ) : state?.state === "identity" || identityOnly ? (
        <>
          {identityOnly && identityLinked ? (
            <>
              <p role="status" className="text-sm">
                GitHub account <strong>{legacyIdentity?.login}</strong>{" "}
                connected. You can now mention this bot on GitHub.
              </p>
              {footer()}
            </>
          ) : state?.identity ? (
            <>
              <p className="text-sm">
                Connect GitHub account <strong>{state.identity.login}</strong>{" "}
                to your Paperclip account.
              </p>
              {footer("Confirm my account", async () => {
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
                Link your GitHub account so your mentions use your Paperclip
                permissions.
              </p>
              {(accounts.data?.length ?? 0) > 0 && (
                <>
                  <Label htmlFor="github-personal-account">
                    Existing GitHub connection
                  </Label>
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
                    <option value="">Choose an account</option>
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
                      GitHub account: <strong>{legacyIdentity.login}</strong>
                    </p>
                  )}
                </>
              )}
              {existingIdentityMethod && !legacyAccount && (
                <Link
                  className="text-sm underline"
                  to="/apps/connect?source=github"
                >
                  Add a personal GitHub connection, then return to this draft
                </Link>
              )}
              {footer(
                legacyAccount
                  ? legacyIdentity
                    ? "Confirm my account"
                    : "Check my account"
                  : "Connect my GitHub account",
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
            Waiting for GitHub installation or administrator approval…
          </p>
          {state.installationUrl && (
            <a
              className="inline-flex items-center gap-1 text-sm underline"
              href={state.installationUrl}
            >
              Continue installation on GitHub
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
          {footer("Connect Paperclip Cloud", async () => {
            const result = await toolsApi.startCloudConnectorEnrollment(
              selectedCompanyId!,
              undefined,
              `/apps/chat/connect${window.location.search}`,
            );
            if (!result.verificationUrl)
              throw new Error("Cloud enrollment could not be started");
            window.location.assign(result.verificationUrl);
          })}
        </>
      ) : state?.state === "recovery" ? (
        <>
          <p role="status" className="text-sm">
            {state.message}
          </p>
          <Button variant="ghost" onClick={() => setExisting(true)}>
            Use existing App credentials
          </Button>
          {state.restartableRegistrationId && (
            <div className="flex items-center gap-2">
              <Checkbox id="github-app-not-created" checked={appNotCreated} disabled={busy}
                onCheckedChange={(checked) => setAppNotCreated(checked === true)} />
              <Label htmlFor="github-app-not-created">I haven't created this App on GitHub.</Label>
            </div>
          )}
          {state.restartableRegistrationId
            ? footer("Continue to GitHub", async () => {
                const result = await githubChatApi.restartRegistration(bot.id, state.restartableRegistrationId!);
                setAppNotCreated(false);
                queryClient.setQueryData(["github-wizard", bot.id], result);
                if (result.registration) setSubmitManifest(true);
              }, !appNotCreated)
            : footer("Try again", refresh)}
        </>
      ) : state?.state === "verify" ? (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {deliveryVerifiedWhileChecking
              ? "GitHub delivery verified. Checking App and repository access…"
              : state.message ?? "Checking GitHub access…"}
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
          >
            Connection settings
          </Link>
          {footer("Try again", refresh)}
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="github-owner-type">GitHub account</Label>
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
              <option value="personal">My account</option>
              {knownOrganizations.map((login) => (
                <option key={login.toLowerCase()} value={`organization:${login}`}>{login}</option>
              ))}
              <option value="organization">Another organization</option>
            </select>
            {(repositoriesView.kind === "error" || connectedBotsView.kind === "error") && (
              <p role="alert" className="text-sm text-destructive">
                Could not load some connected GitHub accounts. Choose Another organization to enter a name.
              </p>
            )}
          </div>
          {accountChoice === "organization" && (
            <div className="space-y-2">
              <Label htmlFor="github-owner-login">Organization</Label>
              <Input
                id="github-owner-login"
                disabled={busy || !!state?.registration}
                value={ownerLogin}
                onChange={(event) => setOwnerLogin(event.target.value)}
                placeholder="GitHub organization name"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="github-app-name">App name</Label>
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
            I already have an App
          </button>
          {state?.registration ? (
            <GitHubAppManifestForm registration={state.registration} onSaveExit={exit}
              disabled={busy} autoSubmit={submitManifest} onSubmit={() => setSubmitManifest(false)} />
          ) : footer(
            "Continue to GitHub",
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
