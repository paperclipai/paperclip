import { githubVerificationText, chatUiErrorMessage, type ChatUiError } from "./chat-copy";
import { Trans } from "react-i18next";
import { i18n, t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type { ChatEndpointSetupState } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatEndpointResource,
} from "@/api/chatEndpoints";
import {
  githubChatApi,
  type GitHubConfigurationRecord,
  type GitHubIdentity,
  type GitHubVerification,
} from "@/api/githubChat";
import { AgentSelect } from "@/components/AgentMultiSelect";
import { GitHubAgentTrustWarning } from "@/components/GitHubAgentTrustWarning";
import { GitHubSetupPrompt } from "./GitHubSetupPrompt";
import {
  SetupWizardNavigation,
  SetupWizardFooter,
} from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/context/ToastContext";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  GitHubAccessEditor,
  GitHubPolicyEditor,
  GitHubToggle,
  githubSelectClass,
} from "./GitHubBotConfiguration";

function githubStepLabels() { return [
  t("chatUi.chatEndpointSetup.chooseAgent"),
  t("sep28Apps.copy107"),
  t("sep28Apps.copy108"),
  t("sep28Apps.copy109"),
  t("sep28Apps.copy110"),
  t("sep28Apps.copy111"),
  t("sep28Apps.copy112"),
  t("chatUi.chatEndpointSetup.tryIt"),
]; }
const stages: NonNullable<ChatEndpointSetupState["github"]>["stage"][] = [
  "connect",
  "connect",
  "install",
  "repositories",
  "verify",
  "identity",
  "behavior",
  "test",
];
export function GitHubChatSetup() {
  const { t } = useTranslation();
  const steps = githubStepLabels();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [secretCopy, setSecretCopy] = useState<"idle" | "copied" | "failed">("idle");
  const identityOnly = params.get("stage") === "identity";
  const reconnecting = params.get("reconnect") === "1";
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [endpoint, setEndpoint] = useState<ChatEndpoint | null>(null);
  const [agentId, setAgentId] = useState(params.get("agentId") ?? "");
  const [step, setStep] = useState(0);
  const [availableStep, setAvailableStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ChatUiError>("");
  const [name, setName] = useState("Paperclip Review");
  const [existing, setExisting] = useState(reconnecting);
  const [credentials, setCredentials] = useState({
    appId: "",
    privateKey: "",
    webhookSecret: "",
  });
  const [registration, setRegistration] = useState<Awaited<
    ReturnType<typeof githubChatApi.registration>
  > | null>(null);
  const [resources, setResources] = useState<ChatEndpointResource[]>([]);
  const [record, setRecord] = useState<GitHubConfigurationRecord | null>(null);
  const [verification, setVerification] = useState<GitHubVerification | null>(
    null,
  );
  const [personalConnectionId, setPersonalConnectionId] = useState("");
  const [identity, setIdentity] = useState<GitHubIdentity | null>(null);
  const [copied, setCopied] = useState(false);
  const resume = params.get("resume");
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
    refetchIntervalInBackground: false,
  });
  const accounts = useQuery({
    queryKey: ["github-personal-connections", endpoint?.id],
    queryFn: () => githubChatApi.personalConnections(endpoint!.id),
    enabled: !!endpoint && step === 5,
  });
  const test = useQuery({
    queryKey: ["github-test-status", endpoint?.id],
    queryFn: () => chatEndpointsApi.setupTestStatus(endpoint!.id),
    enabled: !!endpoint && step === 7,
    refetchInterval: 3000,
  });
  const selectedAgent = agents.data?.find((agent) => agent.id === agentId);
  useEffect(() => {
    setBreadcrumbs([
      { label: t("localizationConnections.connectors16"), href: "/apps" },
      { label: t("oct5Apps.copy059") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);
  useEffect(() => {
    if (!current.data) return;
    setEndpoint(current.data);
    setAgentId(current.data.assignedAgentId);
    if (availableStep === 0) {
      const next = identityOnly
        ? 5
        : reconnecting
          ? 1
          : current.data.setup?.github?.stage
            ? Math.max(1, stages.indexOf(current.data.setup.github.stage))
            : current.data.status === "active"
              ? 6
              : 1;
      setStep(next);
      setAvailableStep(next);
      if (identityOnly) return;
      void Promise.all([
        chatEndpointsApi.listResources(current.data.id),
        githubChatApi.configuration(current.data.id),
      ])
        .then(([resources, config]) => {
          setResources(resources);
          setRecord(config);
        })
        .catch((error) =>
          setError(
            error instanceof Error ? error.message : { key: "sep28Apps.copy114" },
          ),
        );
    }
  }, [current.data, availableStep, params]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : { key: "sep28Apps.copy115" },
      );
    } finally {
      setBusy(false);
    }
  }
  async function go(next: number, bot = endpoint) {
    if (bot && next > 0)
      setEndpoint(await githubChatApi.progress(bot.id, stages[next]!));
    setStep(next);
    setAvailableStep((value) => Math.max(value, next));
  }
  async function saveConfiguration() {
    if (!endpoint || !record) return;
    const saved = await githubChatApi.save(
      endpoint.id,
      record.revision,
      record.configuration,
    );
    setRecord(saved);
  }
  const exit = () =>
    void run(async () => {
      if (step === 6) await saveConfiguration();
      if (endpoint && step > 0 && !identityOnly)
        await githubChatApi.progress(endpoint.id, stages[step]!);
      navigate("/apps");
    });
  const footer = (
    label: string,
    action: () => Promise<void>,
    disabled = false,
    extra?: React.ReactNode,
  ) => (
    <SetupWizardFooter onSaveExit={exit}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {step > 0 && !identityOnly && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setStep(step - 1)}
          >{t("pages.secrets.actions.back")}</Button>
        )}
        {extra}
        <Button disabled={busy || disabled} onClick={() => void run(action)}>
          {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
          {label}
        </Button>
      </div>
    </SetupWizardFooter>
  );
  const publicHttps = !!endpoint?.setup?.webhookUrl?.startsWith("https://");
  const mention = `@${endpoint?.botUsername?.replace(/\[bot\]$/, "") ?? "your-bot"} review this pull request`;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      <SetupWizardNavigation
        labels={identityOnly ? [t("sep28Apps.copy111")] : steps}
        step={identityOnly ? 0 : step}
        availableStep={identityOnly ? 0 : availableStep}
        onSelect={identityOnly ? () => {} : setStep}
        disabled={busy}
        takeover
      />
      <div>
        <p className="text-xs text-muted-foreground">
          {identityOnly
            ? t("sep28Apps.copy116")
            : t("sep28Apps.githubStep", { step: step + 1, total: steps.length })}
        </p>
        <h1 className="mt-2 text-2xl font-semibold">{steps[step]}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("sep28Apps.copy117")}</p>
      </div>
      {(error || current.error || agents.error) && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm"
        >
          {chatUiErrorMessage(error) || t("sep28Apps.copy118")}
        </p>
      )}
      {step === 0 && (
        <>
          <GitHubSetupPrompt />
          <p className="text-sm">{t("sep28Apps.copy119")}</p>
          {endpoint ? (
            <Input
              aria-label={t("sep28Apps.copy120")}
              value={
                endpoint.assignedAgentName ?? selectedAgent?.name ?? agentId
              }
              readOnly
            />
          ) : (
            <AgentSelect
              agents={(agents.data ?? []).filter(
                (agent) => !["terminated", "archived"].includes(agent.status),
              )}
              value={agentId}
              onChange={setAgentId}
              placeholder={t("sep12Connections.chooseAgent")}
              emptyMessage={t("sep28Apps.copy121")}
            />
          )}
          <GitHubAgentTrustWarning agent={selectedAgent} />
          {footer(
            t("pages.inviteLanding.actions.continue"),
            async () => {
              const bot =
                endpoint ??
                (await chatEndpointsApi.create(selectedCompanyId!, {
                  provider: "github",
                  assignedAgentId: agentId,
                }));
              setEndpoint(bot);
              setParams(
                { provider: "github", resume: bot.id },
                { replace: true },
              );
              setRecord(await githubChatApi.configuration(bot.id));
              await go(1, bot);
            },
            !agentId || !selectedCompanyId,
          )}
        </>
      )}
      {step === 1 && endpoint && (
        <>
          {!publicHttps && (
            <div
              role="alert"
              className="rounded-lg border border-(--status-task-todo)/30 bg-(--status-task-todo)/10 p-4 text-sm"
            >{t("sep28Apps.copy122")} {" "}
              <a className="underline" href="https://docs.paperclip.ing/reference/deploy/https/" target="_blank" rel="noreferrer">{t("sep28Apps.copy123")}</a>
            </div>
          )}
          <p className="text-sm">
            <Trans i18nKey="sep28Apps.createDedicatedApp" values={{ agent: selectedAgent?.name ?? endpoint.assignedAgentName }} components={{ agent: <span /> }} />
          </p>
          {reconnecting && (
            <p className="text-sm text-muted-foreground">{t("sep28Apps.copy124")}</p>
          )}
          <div className="flex gap-2">
            <Button
              variant={!existing ? "default" : "outline"}
              onClick={() => setExisting(false)}
            >{t("sep28Apps.copy125")}</Button>
            <Button
              variant={existing ? "default" : "outline"}
              onClick={() => setExisting(true)}
            >{t("sep28Apps.copy126")}</Button>
          </div>
          {existing ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="github-app-id">{t("sep28Apps.copy127")}</Label>
                <Input
                  id="github-app-id"
                  value={credentials.appId}
                  onChange={(e) =>
                    setCredentials({ ...credentials, appId: e.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">{t("sep28Apps.copy128")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="github-private-key">{t("localizationOperations.ui_Private_key")}</Label>
                <Textarea
                  id="github-private-key"
                  autoComplete="off"
                  value={credentials.privateKey}
                  onChange={(e) =>
                    setCredentials({
                      ...credentials,
                      privateKey: e.target.value,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">{t("sep28Apps.copy129")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="github-webhook-secret">{t("localizationRoutines.webhookSecret")}</Label>
                <Input
                  id="github-webhook-secret"
                  type="password"
                  autoComplete="off"
                  value={credentials.webhookSecret}
                  onChange={(e) =>
                    setCredentials({
                      ...credentials,
                      webhookSecret: e.target.value,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">{t("sep28Apps.copy130")}</p>
                {!reconnecting && <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
                    const generated = await chatEndpointsApi.generateSetupSecret(endpoint.id);
                    setCredentials(current => ({ ...current, webhookSecret: generated.webhookSecret }));
                    setSecretCopy("idle");
                  })}>{t("chatUi.chatEndpointSetup.generateWebhookSecret")}</Button>
                  {credentials.webhookSecret && <Button variant="outline" onClick={async () => {
                    try { await copyTextToClipboard(credentials.webhookSecret); setSecretCopy("copied"); }
                    catch { setSecretCopy("failed"); pushToast({ title: t("chatUi.chatEndpointSetup.couldnTCopyToClipboard"), body: t("chatUi.chatEndpointSetup.selectAndCopyTheValueManually"), tone: "error" }); }
                  }}>{secretCopy === "copied" ? t("sep28Apps.copy131") : secretCopy === "failed" ? t("sep28Apps.copy132") : t("chatUi.chatEndpointSetup.copyWebhookSecret")}</Button>}
                </div>}

              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Label htmlFor="github-app-name">{t("sep28Apps.copy133")}</Label>
              <Input
                id="github-app-name"
                maxLength={34}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setRegistration(null);
                }}
              />
              <p className="text-xs text-muted-foreground">{t("sep28Apps.copy134")}</p>
              {registration && (
                <form
                  action={registration.registrationUrl}
                  method="POST"
                >
                  <input
                    type="hidden"
                    name="manifest"
                    value={JSON.stringify(registration.manifest)}
                  />
                  <Button type="submit">{t("sep28Apps.copy135")}<ExternalLink className="ml-2 size-4" />
                  </Button>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("sep28Apps.registrationExpires", { date: new Date(registration.expiresAt).toLocaleTimeString(i18n.resolvedLanguage ?? i18n.language) })}
                  </p>
                </form>
              )}
            </div>
          )}
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm">{t("sep28Apps.copy136")}</summary>
            <p className="mt-3 text-sm">{t("sep28Apps.copy137")}</p>
            <p className="mt-2 break-all text-xs">
              {endpoint.setup?.webhookUrl ?? t("sep28Apps.copy138")}
            </p>
            {endpoint.setup?.webhookUrl && <Button variant="outline" size="sm" className="mt-2" onClick={() => void run(async () => { await copyTextToClipboard(endpoint.setup!.webhookUrl!); pushToast({ title: t("sep28Apps.copy139"), tone: "success" }); })}>{t("sep28Apps.copy140")}</Button>}
            {registration && (
              <pre className="mt-3 overflow-auto text-xs">
                {JSON.stringify(registration.manifest, null, 2)}
              </pre>
            )}
          </details>
          {footer(
            reconnecting
              ? t("sep28Apps.copy141")
              : endpoint.setup?.github?.appSlug
                ? t("sep28Apps.copy142")
                : existing
                  ? t("sep28Apps.copy143")
                  : t("sep28Apps.copy144"),
            async () => {
              if (reconnecting) {
                const saved = await chatEndpointsApi.setup(endpoint.id, {
                  action: "reconnect",
                  ...(credentials.privateKey
                    ? {
                        credentials: {
                          appId: credentials.appId || endpoint.botExternalId!,
                          privateKey: credentials.privateKey,
                        },
                      }
                    : {}),
                });
                setEndpoint(saved);
                setCredentials({
                  appId: "",
                  privateKey: "",
                  webhookSecret: "",
                });
                await go(4, saved);
              } else if (endpoint.setup?.github?.appSlug) await go(2);
              else if (existing) {
                const saved = await githubChatApi.connectApp(
                  endpoint.id,
                  credentials,
                );
                setEndpoint(saved);
                setCredentials({
                  appId: "",
                  privateKey: "",
                  webhookSecret: "",
                });
                await go(2, saved);
              } else
                setRegistration(
                  await githubChatApi.registration(endpoint.id, name),
                );
            },
            !publicHttps ||
              (existing &&
                !reconnecting &&
                (!credentials.appId ||
                  !credentials.privateKey ||
                  !credentials.webhookSecret) &&
                !endpoint.setup?.github?.appSlug),
          )}
        </>
      )}
      {step === 2 && endpoint && (
        <>
          <p className="text-sm">{t("sep28Apps.copy145")}</p>
          <p className="text-sm text-muted-foreground">{t("sep28Apps.copy146")}</p>
          {endpoint.setup?.github?.installationUrl && (
            <Button asChild>
              <a
                href={endpoint.setup.github.installationUrl}
                target="_blank"
                rel="noreferrer"
              >{t("sep28Apps.copy147")}<ExternalLink className="ml-2 size-4" />
              </a>
            </Button>
          )}
          {footer(t("sep28Apps.copy148"), async () => {
            setResources(await githubChatApi.refreshRepositories(endpoint.id));
            await go(3);
          })}
        </>
      )}
      {step === 3 && endpoint && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setResources(
                    await githubChatApi.refreshRepositories(endpoint.id),
                  );
                  setEndpoint(await chatEndpointsApi.get(endpoint.id));
                })
              }
            >
              <RefreshCw className="mr-2 size-4" />{t("localizationApps.refreshAccess387")}</Button>
            <Button variant="outline" asChild>
              <a
                href={
                  endpoint.setup?.github?.managementUrl ??
                  "https://github.com/settings/installations"
                }
                target="_blank"
                rel="noreferrer"
              >{t("sep28Apps.copy149")}<ExternalLink className="ml-2 size-4" />
              </a>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t("sep28Apps.copy150")}</p>
          <div className="divide-y divide-border rounded-lg border border-border">
            {resources.length === 0 && (
              <p className="p-4 text-sm">{t("sep28Apps.copy151")}</p>
            )}
            {resources.map((resource) => (
              <div key={resource.id} className="p-4">
                <GitHubToggle
                  label={resource.label}
                  description={
                    resource.availability !== "available"
                      ? t("sep28Apps.copy152")
                      : t("sep28Apps.copy153")
                  }
                  checked={
                    resource.enabled && resource.availability === "available"
                  }
                  onChange={(enabled) =>
                    setResources(
                      resources.map((row) =>
                        row.id === resource.id
                          ? {
                              ...row,
                              enabled:
                                enabled && row.availability === "available",
                            }
                          : row,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </div>
          {footer(
            t("sep28Apps.copy154"),
            async () => {
              await chatEndpointsApi.updateResources(
                endpoint.id,
                resources.map((resource) => ({
                  id: resource.id,
                  enabled: resource.enabled,
                })),
              );
              await chatEndpointsApi.update(endpoint.id, {
                allowGroupChats: true,
              });
              const configured = await chatEndpointsApi.setup(endpoint.id, {
                action:
                  endpoint.status === "draft" || endpoint.status === "attention"
                    ? "configure"
                    : "reconnect",
              });
              setEndpoint(configured);
              await go(4, configured);
            },
            !resources.some(
              (resource) =>
                resource.enabled && resource.availability === "available",
            ),
          )}
        </>
      )}
      {step === 4 && endpoint && (
        <>
          <p className="text-sm">{t("sep28Apps.copy155")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setVerification(await githubChatApi.verify(endpoint.id)),
                )
              }
            >{t("sep28Apps.copy156")}</Button>
            <Button
              variant="outline"
              disabled={busy || !record}
              onClick={() =>
                void run(async () => {
                  if (!record) return;
                  setRecord(
                    await githubChatApi.save(endpoint.id, record.revision, {
                      ...record.configuration,
                      toolsEnabled: true,
                    }),
                  );
                  setVerification(await githubChatApi.verify(endpoint.id));
                })
              }
            >{t("sep28Apps.copy157")}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("sep28Apps.copy158")}</p>
          <div className="divide-y divide-border rounded-lg border border-border">
            {verification?.checks.map((check) => (
              <div key={check.key} className="flex gap-3 p-4">
                {check.ok ? (
                  <CheckCircle2 className="mt-1 size-4 shrink-0 text-(--status-task-done)" />
                ) : (
                  <XCircle className="mt-1 size-4 shrink-0 text-destructive" />
                )}
                <div>
                  <p className="text-sm font-medium">{githubVerificationText(check.label)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {githubVerificationText(check.detail)}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <GitHubAgentTrustWarning agent={selectedAgent} />
          {footer(t("pages.inviteLanding.actions.continue"), () => go(5), !verification?.ready)}
        </>
      )}
      {step === 5 && endpoint && (
        <>
          <p className="text-sm">{t("sep28Apps.copy159")}</p>
          <div className="space-y-2">
            <Label htmlFor="github-personal-account">{t("sep28Apps.copy160")}</Label>
            <select
              id="github-personal-account"
              className={githubSelectClass}
              value={personalConnectionId}
              onChange={(e) => {
                setPersonalConnectionId(e.target.value);
                setIdentity(null);
              }}
            >
              <option value="">{t("sep28Apps.copy161")}</option>
              {accounts.data?.map((account) => (
                <option
                  key={account.connectionId}
                  value={account.connectionId}
                  disabled={!account.enabled || account.status !== "active"}
                >
                  {account.name}
                  {account.login ? ` · @${account.login}` : ""}
                  {account.status !== "active" ? t("sep28Apps.copy162") : ""}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t("sep28Apps.copy163")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!personalConnectionId || busy}
              onClick={() =>
                void run(async () =>
                  setIdentity(
                    await githubChatApi.identity(
                      endpoint.id,
                      personalConnectionId,
                    ),
                  ),
                )
              }
            >{t("sep28Apps.copy164")}</Button>
            <Button variant="ghost" onClick={() => void accounts.refetch()}>{t("sep28Apps.copy165")}</Button>
            <Link className="self-center text-sm underline" to="/apps/connect?source=github">{t("localizationProjectRepositories.connectGithub")}</Link>
          </div>
          {accounts.error && (
            <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy166")}</p>
          )}
          {identity && (
            <div className="rounded-lg border border-border p-4">
              <p className="font-medium">@{identity.login}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("sep28Apps.githubConfirmId", { id: identity.githubUserId })}
              </p>
            </div>
          )}
          {footer(
            t("sep28Apps.copy167"),
            async () => {
              await githubChatApi.identity(
                endpoint.id,
                personalConnectionId,
                identity!.githubUserId,
              );
              if (identityOnly) navigate("/apps");
              else await go(6);
            },
            !identity,
          )}
        </>
      )}
      {step === 6 && endpoint && record && (
        <>
          <GitHubAccessEditor
            endpointId={endpoint.id}
            companyId={endpoint.companyId}
            configuration={record.configuration}
            onChange={(configuration) =>
              setRecord({ ...record, configuration })
            }
          />
          <GitHubPolicyEditor
            policy={record.configuration.defaults}
            onChange={(defaults) =>
              setRecord({
                ...record,
                configuration: { ...record.configuration, defaults },
              })
            }
          />
          {footer(t("sep28Apps.copy168"), async () => {
            await saveConfiguration();
            await go(7);
          })}
        </>
      )}
      {step === 7 && endpoint && (
        <>
          <p className="text-sm">
            <Trans i18nKey="sep28Apps.githubTest" values={{ agent: selectedAgent?.name ?? endpoint.assignedAgentName }} components={{ agent: <span /> }} />
          </p>
          <div className="flex items-center gap-3 rounded-lg border border-border p-4">
            <code className="min-w-0 flex-1 break-all text-sm">{mention}</code>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("sep28Apps.copy169")}
              onClick={() =>
                void copyTextToClipboard(mention).then(() => setCopied(true))
              }
            >
              <Copy className="size-4" />
            </Button>
          </div>
          {copied && (
            <p role="status" className="text-xs text-muted-foreground">{t("sep28Apps.copy170")}</p>
          )}
          <p role="status" className="text-sm">
            {test.data?.messageReceivedAt
              ? t("sep28Apps.copy171")
              : t("sep28Apps.copy172")}
          </p>
          <Link
            className="text-sm underline"
            to={`/apps/chat/${endpoint.id}/conversations`}
          >{t("sep28Apps.copy173")}</Link>
          {footer(
            t("sep28Apps.copy174"),
            async () => {
              await chatEndpointsApi.test(endpoint.id);
              navigate(`/apps/chat/${endpoint.id}/settings`);
            },
            !test.data?.messageReceivedAt,
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await chatEndpointsApi.finishSlackSetup(endpoint.id);
                  navigate(`/apps/chat/${endpoint.id}/settings`);
                })
              }
            >{t("sep28Apps.copy175")}</Button>,
          )}
        </>
      )}
    </div>
  );
}
