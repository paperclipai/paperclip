import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { xChatApi } from "@/api/xChat";
import { AgentSelect } from "@/components/AgentMultiSelect";
import {
  SetupWizardFooter,
  SetupWizardNavigation,
} from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useNavigate, useSearchParams } from "@/lib/router";
import { copyTextToClipboard } from "@/lib/clipboard";

const steps = [
  "Choose agent",
  "Configure X app",
  "Authorize bot account",
  "Configure delivery",
  "Link your account",
  "Try it",
];
export function XChatSetup() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [endpoint, setEndpoint] = useState<ChatEndpoint | null>(null);
  const [agentId, setAgentId] = useState(params.get("agentId") ?? "");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  const [copied, setCopied] = useState("");
  const resume = params.get("resume");
  const confirmationId = params.get("confirmation");
  const agents = useQuery({
    queryKey: ["x-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const saved = useQuery({
    queryKey: ["x-setup", resume],
    queryFn: () => chatEndpointsApi.get(resume!),
    enabled: !!resume,
    refetchInterval: step === 3 ? 3000 : false,
  });
  const confirmation = useQuery({
    queryKey: ["x-confirmation", confirmationId],
    queryFn: () => xChatApi.confirmation(confirmationId!),
    enabled: !!confirmationId,
  });
  const identity = useQuery({
    queryKey: ["x-identity", endpoint?.id],
    queryFn: () => xChatApi.identityStatus(endpoint!.id),
    enabled: !!endpoint && step === 4,
  });
  const test = useQuery({
    queryKey: ["x-test", endpoint?.id],
    queryFn: () => chatEndpointsApi.setupTestStatus(endpoint!.id),
    enabled: !!endpoint && step === 5,
    refetchInterval: 3000,
  });
  useEffect(() => {
    setBreadcrumbs([
      { label: "Connectors", href: "/apps" },
      { label: "Connect X bot" },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);
  useEffect(() => {
    if (!saved.data) return;
    setEndpoint(saved.data);
    setStep(
      (previous) =>
        previous ||
        (confirmationId
          ? 4
          : params.get("stage") === "identity"
            ? 4
            : params.get("reconnect")
              ? 1
              : (saved.data.setup?.x?.stage ??
                (saved.data.botExternalId ? 3 : 1))),
    );
  }, [saved.data, confirmationId, params]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete this step");
    } finally {
      setBusy(false);
    }
  }
  async function advance(next: number) {
    if (endpoint) setEndpoint(await xChatApi.progress(endpoint.id, next));
    setStep(next);
  }
  async function identityFinished() {
    if (endpoint?.status === "active" || endpoint?.status === "paused")
      navigate(`/apps/chat/${endpoint.id}`);
    else await advance(5);
  }
  async function exit() {
    const draft =
      endpoint ??
      (selectedCompanyId && agentId
        ? await chatEndpointsApi.create(selectedCompanyId, {
            provider: "x",
            assignedAgentId: agentId,
          })
        : null);
    if (draft) {
      setEndpoint(draft);
      if (step === 1 && (client.clientId || client.clientSecret)) {
        await xChatApi.authorize(draft.id, "bot", client);
        setClient({ clientId: "", clientSecret: "" });
      }
      await xChatApi.progress(draft.id, Math.max(1, step));
    }
    navigate("/apps");
  }
  async function copy(value: string, label: string) {
    await copyTextToClipboard(value);
    setCopied(label);
  }
  const webhook = endpoint?.setup?.webhookUrl ?? "";
  const redirect = webhook
    ? new URL("/api/x/oauth/callback", webhook).toString()
    : "";
  const maximumStep = confirmationId
    ? 4
    : Math.max(step, endpoint?.setup?.x?.stage ?? 0);
  const footer = (
    label: string,
    action: () => Promise<void>,
    disabled = false,
  ) => (
    <SetupWizardFooter onSaveExit={() => void run(exit)} disabled={busy}>
      {step > 0 && (
        <Button
          variant="outline"
          onClick={() => setStep(step - 1)}
          disabled={busy}
        >
          Back
        </Button>
      )}
      <Button onClick={() => void run(action)} disabled={busy || disabled}>
        {busy ? "Working…" : label}
      </Button>
    </SetupWizardFooter>
  );
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <SetupWizardNavigation
        labels={steps}
        step={step}
        availableStep={maximumStep}
        disabled={busy}
        onSelect={setStep}
        takeover
      />
      <h1 className="text-xl font-semibold">{steps[step]}</h1>
      {(error ||
        saved.error ||
        confirmation.error ||
        identity.error ||
        agents.error ||
        test.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ||
            String(
              saved.error ??
                confirmation.error ??
                identity.error ??
                agents.error ??
                test.error,
            )}
        </p>
      )}
      {step === 0 && (
        <div className="space-y-4">
          <p>
            Mention this bot on X to start work with one assigned agent. The
            assigned agent stays fixed for this connection.
          </p>
          <AgentSelect
            agents={agents.data ?? []}
            value={endpoint?.assignedAgentId ?? agentId}
            onChange={setAgentId}
            disabled={!!endpoint}
          />
          {footer(
            "Continue",
            async () => {
              const created =
                endpoint ??
                (await chatEndpointsApi.create(selectedCompanyId!, {
                  provider: "x",
                  assignedAgentId: agentId,
                }));
              setEndpoint(created);
              setParams({ provider: "x", resume: created.id });
              setStep(1);
            },
            !selectedCompanyId || (!agentId && !endpoint),
          )}
        </div>
      )}
      {step === 1 && (
        <div className="space-y-4">
          <p>
            Create a customer-owned app in the{" "}
            <a
              className="underline"
              href="https://console.x.com"
              target="_blank"
              rel="noreferrer"
            >
              X developer console
            </a>
            . Enable OAuth 2.0 for a confidential Web App with read and write
            access.
          </p>
          <p className="text-sm text-muted-foreground">
            X requires prior written approval for AI reply bots. Identify the
            account as automated in its profile and explain how to opt out with
            @bot stop and resume with @bot start.{" "}
            <a
              className="underline"
              href="https://help.x.com/en/rules-and-policies/x-automation"
              target="_blank"
              rel="noreferrer"
            >
              Automation rules
            </a>
          </p>
          <p className="text-sm text-muted-foreground">
            X API usage is billed separately. Review your credits and spending
            controls before enabling delivery.{" "}
            <a
              className="underline"
              href="https://docs.x.com/x-api/getting-started/pricing"
              target="_blank"
              rel="noreferrer"
            >
              X spending information
            </a>
          </p>
          {!redirect && (
            <p role="alert">
              Configure a public HTTPS Paperclip URL before connecting X.
            </p>
          )}
          <Label htmlFor="x-redirect">OAuth callback URL</Label>
          <Input id="x-redirect" value={redirect} readOnly />
          <Button
            variant="outline"
            disabled={!redirect}
            onClick={() => void run(() => copy(redirect, "callback"))}
          >
            {copied === "callback" ? "Copied" : "Copy callback URL"}
          </Button>
          <Label htmlFor="x-client-id">OAuth 2.0 Client ID</Label>
          {endpoint?.setup?.x?.clientConfigured && (
            <p className="text-sm text-muted-foreground">
              X app credentials are saved. Leave these fields blank to keep
              them.
            </p>
          )}
          <Input
            id="x-client-id"
            autoComplete="off"
            value={client.clientId}
            onChange={(event) =>
              setClient({ ...client, clientId: event.target.value })
            }
          />
          <Label htmlFor="x-client-secret">OAuth 2.0 Client Secret</Label>
          <Input
            id="x-client-secret"
            type="password"
            autoComplete="new-password"
            value={client.clientSecret}
            onChange={(event) =>
              setClient({ ...client, clientSecret: event.target.value })
            }
          />
          {footer(
            "Save app & continue",
            async () => {
              if (client.clientId || client.clientSecret)
                await xChatApi.authorize(endpoint!.id, "bot", client);
              setClient({ clientId: "", clientSecret: "" });
              await advance(2);
            },
            !redirect ||
              (!(client.clientId && client.clientSecret) &&
                !endpoint?.setup?.x?.clientConfigured),
          )}
        </div>
      )}
      {step === 2 && (
        <div className="space-y-4">
          <p>
            Sign into the X account that will act as the bot. Grant tweet.read,
            tweet.write, users.read and offline.access. Paperclip stores and
            refreshes these credentials securely.
          </p>
          {endpoint?.botUsername && (
            <p>Currently connected: @{endpoint.botUsername}</p>
          )}
          {footer("Authorize bot account on X", async () => {
            const result = await xChatApi.authorize(endpoint!.id, "bot");
            window.location.assign(result.url);
          })}
        </div>
      )}
      {step === 3 && (
        <div className="space-y-4">
          <p>
            Register this public HTTPS webhook in X’s console, then subscribe
            the authorized bot account to <code>post.mention.create</code> and{" "}
            <code>post.reply.create</code>.
          </p>
          <Input aria-label="X webhook URL" value={webhook} readOnly />
          <Button
            variant="outline"
            onClick={() => void run(() => copy(webhook, "webhook"))}
          >
            {copied === "webhook" ? "Copied" : "Copy webhook URL"}
          </Button>
          <p className="text-sm text-muted-foreground">
            X sends a GET challenge and signed POST events. Public mentions and
            direct replies are supported; protected posts and DMs are
            unavailable.
          </p>
          <p role="status">
            {endpoint?.setup?.webhookVerifiedAt
              ? "Webhook callback observed"
              : "Waiting for X’s webhook callback…"}
          </p>
          {footer(
            "Continue",
            () => advance(4),
            !endpoint?.setup?.webhookVerifiedAt,
          )}
        </div>
      )}
      {step === 4 && (
        <div className="space-y-4">
          <p>
            Connect your personal X account to your signed-in Paperclip account.
            This separate authorization is read-only; it never publishes a
            linking token or replaces the bot account.
          </p>
          {confirmation.data ? (
            <div className="space-y-3">
              <p>
                Confirm that @{confirmation.data.identity.username} is your X
                account.
              </p>
              <Button
                onClick={() =>
                  void run(async () => {
                    await xChatApi.confirm(confirmationId!);
                    setParams({ provider: "x", resume: endpoint!.id });
                    await identityFinished();
                  })
                }
                disabled={busy}
              >
                Confirm my X account
              </Button>
            </div>
          ) : (
            <Button
              onClick={() =>
                void run(async () => {
                  const result = await xChatApi.authorize(
                    endpoint!.id,
                    "identity",
                  );
                  window.location.assign(result.url);
                })
              }
              disabled={busy}
            >
              Link my X account
            </Button>
          )}
          {identity.data?.linked && (
            <p role="status">Your X account is linked.</p>
          )}
          {footer(
            "Continue",
            identityFinished,
            !identity.data?.linked || !!confirmationId,
          )}
        </div>
      )}
      {step === 5 && (
        <div className="space-y-4">
          <p>
            Only linked Paperclip users can invoke this bot by default. You can
            permit anyone on X; public participants run with restricted guest
            access.
          </p>
          <Label htmlFor="x-access">Who can start work?</Label>
          <select
            id="x-access"
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
            value={endpoint?.allowUnlinkedPeople ? "anyone" : "linked"}
            disabled={busy}
            onChange={(event) =>
              void run(async () => {
                setEndpoint(
                  await chatEndpointsApi.update(endpoint!.id, {
                    allowUnlinkedPeople: event.target.value === "anyone",
                  }),
                );
              })
            }
          >
            <option value="linked">Linked Paperclip users</option>
            <option value="anyone">Anyone on X</option>
          </select>
          <p>
            Optionally post <strong>@{endpoint?.botUsername} hello</strong>,
            then reply to the bot’s response. Independent mentions create
            separate tasks. Only the agent’s explicit reply tool publishes a
            public answer.
          </p>
          <p role="status">
            {test.data?.messageReceivedAt
              ? "Test message received. Check Activity for reply delivery."
              : "No test message received yet. This test is optional."}
          </p>
          {footer("Finish setup", async () => {
            await xChatApi.finish(endpoint!.id);
            navigate(`/apps/chat/${endpoint!.id}`);
          })}
        </div>
      )}
    </div>
  );
}
