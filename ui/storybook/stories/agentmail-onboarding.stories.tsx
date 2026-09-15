import { useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Mail,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { expect, userEvent, within } from "storybook/test";
import { AccessStep } from "@/features/connections/ConnectionSetupFlow";
import { ConnectorCard } from "@/pages/apps/Browse";
import { AppLogo } from "@/pages/apps/AppLogo";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/SearchableSelect";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import type { AgentPermissions } from "@paperclipai/shared";
import { TrustPresetSection } from "@/components/TrustPresetSection";
import {
  buildPermissionsForTrustPreset,
  getTrustPreset,
  getLowTrustBoundary,
  lowTrustBoundaryHasScope,
  setSingleLowTrustBoundaryTarget,
} from "@/lib/trust-policy-ui";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { storybookAgents } from "../fixtures/paperclipData";

// An interactive design proposal. State is local: no credentials or inboxes are created.
type Screen =
  | "catalog"
  | "access"
  | "key"
  | "connected"
  | "permissions"
  | "agent"
  | "address"
  | "review"
  | "ready";
const COMPANY = "company-storybook";
const agents = storybookAgents.map((agent, i) => ({
  ...agent,
  name: ["Support", "Operations", "Research"][i] ?? agent.name,
}));
const selectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const connectionSteps = ["Access", "API key", "Connected"];
const addressSteps = ["Agent", "Email address", "Review"];

function NumberedSteps({
  labels,
  current,
  onBack,
}: {
  labels: string[];
  current: number;
  onBack: (step: number) => void;
}) {
  return (
    <nav aria-label="Setup progress">
      <ol className="flex gap-3 sm:gap-6">
        {labels.map((label, i) => (
          <li key={label} className="flex flex-1 items-center gap-2">
            <button
              type="button"
              disabled={i > current}
              onClick={() => i < current && onBack(i)}
              aria-current={i === current ? "step" : undefined}
              aria-label={`Step ${i + 1}: ${label}`}
              className={cn(
                "flex items-center gap-2 text-sm disabled:cursor-default",
                i > current && "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                  i <= current
                    ? "border-foreground bg-foreground text-background"
                    : "border-border",
                )}
              >
                {i < current ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className={cn(i === current && "font-semibold")}>
                {label}
              </span>
            </button>
            {i < labels.length - 1 && (
              <span className="hidden h-px flex-1 bg-border sm:block" />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}
function AgentMailJourney({
  initial = "catalog",
  existing = false,
  advanced = false,
  invalidKey = false,
  senderStatus = "anyone",
  trustDefault = "standard",
  policyUnknown = false,
}: {
  initial?: Screen;
  existing?: boolean;
  advanced?: boolean;
  invalidKey?: boolean;
  senderStatus?: "managed" | "anyone";
  trustDefault?: "standard" | "low_trust_review" | "unscoped";
  policyUnknown?: boolean;
}) {
  const client = useMemo(() => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    queryClient.setQueryData(queryKeys.agents.list(COMPANY), agents);
    return queryClient;
  }, []);
  const initialPermissions = () =>
    trustDefault === "standard"
      ? buildPermissionsForTrustPreset({}, "standard")
      : trustDefault === "unscoped"
        ? buildPermissionsForTrustPreset({}, "low_trust_review")
        : setSingleLowTrustBoundaryTarget(
            buildPermissionsForTrustPreset({}, "low_trust_review"),
            COMPANY,
            { type: "project", id: "email-work" },
          );
  const [permissions, setPermissions] = useState<
    Record<string, Partial<AgentPermissions>>
  >(() =>
    Object.fromEntries(agents.map((agent) => [agent.id, initialPermissions()])),
  );
  const [trustDialog, setTrustDialog] = useState(false);
  const [draftPermissions, setDraftPermissions] = useState<
    Partial<AgentPermissions>
  >({});
  const [screen, setScreen] = useState<Screen>(initial);
  const [connected, setConnected] = useState(
    !["catalog", "access", "key"].includes(initial),
  );
  const [humanAccess, setHumanAccess] = useState<
    "user" | "organization" | "agent"
  >("user");
  const [agentAccess, setAgentAccess] = useState<"specific" | "all">(
    "specific",
  );
  const [selectedAgents, setSelectedAgents] = useState(
    new Set([agents[0]!.id]),
  );
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState(
    invalidKey
      ? "This key couldn’t be verified. Check that it’s an active AgentMail API key and try again."
      : "",
  );
  const [agentId, setAgentId] = useState(agents[0]!.id);
  const [addressMode, setAddressMode] = useState(existing ? "existing" : "new");
  const [username, setUsername] = useState("support");
  const [domain, setDomain] = useState("agentmail.to");
  const [existingAddress, setExistingAddress] = useState(
    "support-team@agentmail.to",
  );
  const [receiveMode, setReceiveMode] = useState("websocket");
  const [copied, setCopied] = useState(false);
  const [hasInbox, setHasInbox] = useState(initial === "ready");
  const chosenAgent = agents.find((agent) => agent.id === agentId) ?? agents[0];
  const [addedAgentName, setAddedAgentName] = useState<string | null>(null);
  const address =
    addressMode === "existing" ? existingAddress : `${username}@${domain}`;
  const wizard = ["agent", "address", "review"].includes(screen);
  const agentPermissions = permissions[agentId];
  const lowTrust = getTrustPreset(agentPermissions) === "low_trust_review";
  const scoped = lowTrustBoundaryHasScope(
    getLowTrustBoundary(agentPermissions),
  );
  const openTrust = () => {
    setDraftPermissions(agentPermissions ?? {});
    setTrustDialog(true);
  };
  const senderSummary = policyUnknown
    ? "Not verified"
    : senderStatus === "anyone"
      ? "Unrestricted"
      : "Managed in AgentMail";
  const canActivate = !lowTrust || scoped;
  const trustNotice = (
    <div
      className="space-y-3 rounded-lg border border-border bg-muted/30 p-4"
      role={lowTrust && scoped ? undefined : "alert"}
    >
      <div className="flex items-start gap-2">
        {lowTrust && scoped ? (
          <ShieldCheck className="size-4 shrink-0" />
        ) : (
          <AlertTriangle className="size-4 shrink-0 text-(--status-agent-paused)" />
        )}
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {lowTrust
              ? scoped
                ? "Low-trust review configured"
                : "Low trust needs a work boundary"
              : `${chosenAgent?.name} is not a low-trust agent`}
          </p>
          <p className="text-sm text-muted-foreground">
            {lowTrust
              ? scoped
                ? "Email tasks must stay inside this agent’s configured work boundary. Output is quarantined for trusted review."
                : "Choose a project or task boundary before activating email."
              : "Email can contain malicious instructions. We recommend Low-trust review to limit the agent’s access to Paperclip work."}
          </p>
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={openTrust}>
        {lowTrust ? "Review trust settings" : "Configure low trust"}
      </Button>
    </div>
  );
  const inboxNotice = (
    <div
      className="space-y-3 rounded-lg border border-border bg-muted/30 p-4"
      role={policyUnknown || senderStatus === "anyone" ? "alert" : undefined}
    >
      <div className="flex items-start gap-2">
        {senderStatus === "managed" && !policyUnknown ? (
          <ShieldCheck className="size-4 shrink-0" />
        ) : (
          <AlertTriangle className="size-4 shrink-0 text-(--status-agent-paused)" />
        )}
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {policyUnknown
              ? "Sender restrictions haven’t been verified"
              : senderStatus === "anyone"
                ? "Anyone can email this agent"
                : "Sender restrictions are managed in AgentMail"}
          </p>
          <p className="text-sm text-muted-foreground">
            {senderStatus === "anyone" || policyUnknown
              ? "Unrestricted email can create tasks and trigger agent work. Set up an allowlist in AgentMail to limit who can contact this inbox."
              : "Review your inbox’s allowlists and blocklists in AgentMail. Allowed email can still contain malicious instructions."}
          </p>
          <p className="text-xs text-muted-foreground">
            AgentMail controls new messages and replies separately. Check both
            lists.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <a
          className="underline underline-offset-4"
          href="https://console.agentmail.to"
          target="_blank"
          rel="noreferrer"
        >
          Open AgentMail ↗
        </a>
        <a
          className="text-muted-foreground underline underline-offset-4"
          href="https://docs.agentmail.to/knowledge-base/allowlists-blocklists"
          target="_blank"
          rel="noreferrer"
        >
          Set up allowlists ↗
        </a>
      </div>
    </div>
  );
  const humanLabel =
    humanAccess === "organization" ? "Any human in the company" : "Just me";
  const agentLabel =
    agentAccess === "all"
      ? "Any agent"
      : agents
          .filter((agent) => selectedAgents.has(agent.id))
          .map((agent) => agent.name)
          .join(", ");
  const validAddress =
    addressMode === "existing"
      ? !!existingAddress
      : /^[a-z0-9][a-z0-9._-]*$/.test(username);
  const go = (next: Screen) => {
    setError("");
    setScreen(next);
  };
  const beginAddress = () => {
    if (chosenAgent) {
      setAgentId(chosenAgent.id);
      setUsername(chosenAgent.name.toLowerCase());
    }
    go("agent");
  };
  const footer = (
    back: Screen,
    next: Screen,
    label = "Continue",
    disabled = false,
  ) => (
    <div className="flex items-center justify-between border-t border-border pt-5">
      <Button variant="ghost" onClick={() => go(back)}>
        <ArrowLeft className="size-4" />
        Back
      </Button>
      <Button disabled={disabled} onClick={() => go(next)}>
        {label}
        <ArrowRight className="size-4" />
      </Button>
    </div>
  );

  return (
    <QueryClientProvider client={client}>
      <div className="min-h-screen bg-background text-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-6 py-3 text-xs text-muted-foreground">
          <span>
            Design preview · sample data · nothing is connected or sent
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConnected(false);
              setHasInbox(false);
              setScreen("catalog");
              setError("");
              setApiKey("");
              setHumanAccess("user");
              setAgentAccess("specific");
              setSelectedAgents(new Set([agents[0]!.id]));
              setAgentId(agents[0]!.id);
              setUsername("support");
              setAddressMode("new");
              setDomain("agentmail.to");
              setReceiveMode("websocket");
              setExistingAddress("support-team@agentmail.to");
              setCopied(false);
              setAddedAgentName(null);
              setPermissions(
                Object.fromEntries(
                  agents.map((agent) => [agent.id, initialPermissions()]),
                ),
              );
            }}
          >
            Restart walkthrough
          </Button>
        </div>
        <div className="mx-auto max-w-5xl space-y-8 p-6 sm:p-8">
          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          >
            <button
              onClick={() => go("catalog")}
              className="hover:text-foreground"
            >
              Apps
            </button>
            {screen !== "catalog" && (
              <>
                <ChevronRight className="size-3.5" />
                <button
                  onClick={() => connected && go("permissions")}
                  className="hover:text-foreground"
                >
                  AgentMail
                </button>
                <ChevronRight className="size-3.5" />
                <span className="text-foreground">
                  {wizard || screen === "ready"
                    ? "Email address"
                    : screen === "permissions"
                      ? "Permissions"
                      : "Connect"}
                </span>
              </>
            )}
          </nav>

          {screen === "catalog" ? (
            <div className="space-y-6">
              <header className="space-y-2">
                <h1 className="text-xl font-bold">Apps</h1>
                <p className="text-sm text-muted-foreground">
                  Connect the tools your people and agents use.
                </p>
              </header>
              <div role="list" aria-label="Apps">
                <ConnectorCard
                  row={{
                    key: "agentmail",
                    slug: "agentmail",
                    name: "AgentMail",
                    description:
                      "Give agents email addresses. Turn email conversations into tasks.",
                    brandKey: "agentmail",
                    entry: null,
                    applications: [],
                    connections: [],
                    chatEndpoints: [],
                  }}
                  allConnections={[]}
                  userProfileById={new Map()}
                  onNavigate={() => go(connected ? "permissions" : "access")}
                  onRequestRemove={() => {}}
                  chatConnectorsEnabled
                />
              </div>
            </div>
          ) : screen === "permissions" ? (
            <div className="space-y-7">
              <header className="flex items-center gap-3">
                <AppLogo name="AgentMail" brandKey="agentmail" />
                <div>
                  <h1 className="text-xl font-bold">AgentMail</h1>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Check className="size-3.5" />
                    Connected · Company email
                  </p>
                </div>
              </header>
              <div className="border-b border-border pb-3 text-sm font-semibold">
                Permissions
              </div>
              <section className="flex flex-col items-start gap-5 rounded-xl border border-border p-6 sm:flex-row sm:items-center">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Mail className="size-5" />
                </div>
                <div className="flex-1 space-y-1">
                  <h2 className="text-lg font-semibold">
                    {hasInbox
                      ? "Give another agent an inbox"
                      : "Your connection is ready. Give an agent an inbox."}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Each agent gets an address. Each email conversation becomes
                    a task.
                  </p>
                </div>
                <Button
                  size="lg"
                  onClick={beginAddress}
                  disabled={!agents.length}
                >
                  <Plus className="size-4" />
                  Give an agent an email address
                </Button>
              </section>
              {hasInbox && (
                <section className="space-y-3">
                  <h2 className="text-sm font-semibold">Email addresses</h2>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
                    <div>
                      <p className="text-sm font-medium">{address}</p>
                      <p className="text-xs text-muted-foreground">
                        {chosenAgent?.name} ·{" "}
                        {receiveMode === "websocket"
                          ? "Live connection"
                          : "Webhook"}
                      </p>
                    </div>
                    <span className="flex items-center gap-1.5 text-sm">
                      <Check className="size-4" />
                      Receiving email
                    </span>
                  </div>
                  <dl className="divide-y divide-border">
                    <Fact label="New email from">{senderSummary}</Fact>
                    <Fact label="Agent trust">
                      {lowTrust ? "Low-trust review" : "Standard"}
                    </Fact>
                  </dl>
                  {inboxNotice}
                  {!lowTrust && trustNotice}
                </section>
              )}
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Connection access</h2>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => go("access")}
                  >
                    Edit access
                  </Button>
                </div>
                <dl className="divide-y divide-border">
                  <Fact label="Humans">{humanLabel}</Fact>
                  <Fact label="Agents">
                    {agentLabel || "No agents selected"}
                  </Fact>
                  <Fact label="Credential">
                    AgentMail API key · Saved in vault
                  </Fact>
                </dl>
              </section>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-6">
              <header className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <AppLogo name="AgentMail" brandKey="agentmail" />
                    <h1 className="text-xl font-bold">
                      {wizard
                        ? "Give an agent an email address"
                        : screen === "ready"
                          ? "Your agent’s email is ready"
                          : "Connect AgentMail"}
                    </h1>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {wizard
                      ? "Using your saved AgentMail connection."
                      : screen === "ready"
                        ? "New email conversations will become tasks for your agent."
                        : "Connect once, then assign email addresses to your agents."}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => go(connected ? "permissions" : "catalog")}
                >
                  {screen === "ready" ? "Close" : "Cancel"}
                </Button>
              </header>
              {wizard ? (
                <NumberedSteps
                  labels={addressSteps}
                  current={["agent", "address", "review"].indexOf(screen)}
                  onBack={(i) =>
                    go((["agent", "address", "review"] as Screen[])[i]!)
                  }
                />
              ) : (
                screen !== "ready" && (
                  <NumberedSteps
                    labels={connectionSteps}
                    current={["access", "key", "connected"].indexOf(screen)}
                    onBack={(i) => go(i === 0 ? "access" : "key")}
                  />
                )
              )}

              {screen === "access" && (
                <AccessStep
                  companyId={COMPANY}
                  authKind="api_key"
                  grantKinds={["user", "organization"]}
                  grantKind={humanAccess}
                  setGrantKind={setHumanAccess}
                  installChoice={agentAccess}
                  setInstallChoice={setAgentAccess}
                  installAgentIds={selectedAgents}
                  setInstallAgentIds={setSelectedAgents}
                  submitLabel={connected ? "Save access" : "Continue"}
                  onBack={() => go(connected ? "permissions" : "catalog")}
                  onContinue={() => go(connected ? "permissions" : "key")}
                />
              )}
              {screen === "key" && (
                <form
                  className="space-y-6"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!apiKey.trim()) {
                      setError("Enter an API key to continue.");
                      return;
                    }
                    if (apiKey.trim() === "invalid") {
                      setError(
                        "This key couldn’t be verified. Check that it’s an active AgentMail API key and try again.",
                      );
                      return;
                    }
                    setApiKey("");
                    setConnected(true);
                    go("connected");
                  }}
                >
                  <section className="space-y-5 rounded-xl border border-border p-6">
                    <div className="space-y-1">
                      <h2 className="text-lg font-semibold">
                        Add your AgentMail API key
                      </h2>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="preview-api-key">API key</Label>
                      <Input
                        id="preview-api-key"
                        type="password"
                        autoComplete="off"
                        placeholder="Paste your AgentMail API key"
                        value={apiKey}
                        onChange={(e) => {
                          setApiKey(e.target.value);
                          setError("");
                        }}
                        aria-invalid={!!error}
                        aria-describedby={
                          error ? "preview-key-error" : undefined
                        }
                      />
                      {error && (
                        <p
                          id="preview-key-error"
                          role="alert"
                          className="text-sm text-destructive"
                        >
                          {error}
                        </p>
                      )}
                    </div>
                    <a
                      className="text-sm underline underline-offset-4"
                      href="https://console.agentmail.to/dashboard/api-keys"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Get a key in AgentMail ↗
                    </a>
                  </section>
                  <div className="flex items-center justify-between">
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => go("access")}
                    >
                      <ArrowLeft className="size-4" />
                      Back
                    </Button>
                    <Button type="submit">
                      Connect AgentMail
                      <ArrowRight className="size-4" />
                    </Button>
                  </div>
                </form>
              )}
              {screen === "connected" && (
                <section className="space-y-6 rounded-xl border border-border p-6">
                  <div className="flex items-start gap-3">
                    <ShieldCheck className="size-6" />
                    <div className="space-y-1">
                      <h2 className="text-lg font-semibold">
                        AgentMail is connected
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        Your credential is saved. Next, give an agent an email
                        address from Permissions.
                      </p>
                    </div>
                  </div>
                  <dl className="divide-y divide-border">
                    <Fact label="Humans">{humanLabel}</Fact>
                    <Fact label="Agents">{agentLabel}</Fact>
                    <Fact label="Email addresses">None assigned yet</Fact>
                  </dl>
                  <div className="flex justify-end">
                    <Button onClick={() => go("permissions")}>
                      Open permissions
                      <ArrowRight className="size-4" />
                    </Button>
                  </div>
                </section>
              )}
              {screen === "agent" && (
                <>
                  <section className="space-y-5 rounded-xl border border-border p-6">
                    <div className="space-y-1">
                      <h2 className="text-lg font-semibold">
                        Who should handle this inbox?
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        Incoming email will create tasks assigned to this agent.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label>Agent</Label>
                      <SearchableSelect
                        value={chosenAgent?.id ?? ""}
                        placeholder="Choose an agent"
                        searchPlaceholder="Search all agents…"
                        emptyMessage="No agents found."
                        groups={[
                          {
                            id: "agents",
                            options: agents.map((agent) => ({
                              key: agent.id,
                              value: agent.id,
                              label: agent.name,
                              icon: agent.icon,
                            })),
                          },
                        ]}
                        onValueChange={(value, option) => {
                          setAgentId(value);
                          setUsername(option.label.toLowerCase());
                          if (
                            agentAccess !== "all" &&
                            !selectedAgents.has(value)
                          ) {
                            setSelectedAgents(
                              (current) => new Set([...current, value]),
                            );
                            setAddedAgentName(option.label);
                          } else setAddedAgentName(null);
                        }}
                        renderValue={(option) =>
                          option && (
                            <span className="flex items-center gap-2">
                              <Avatar
                                size="sm"
                                role="img"
                                aria-label={`${option.label} avatar`}
                              >
                                <AvatarFallback>
                                  <AgentIcon
                                    icon={option.icon}
                                    className="size-3.5"
                                  />
                                </AvatarFallback>
                              </Avatar>
                              {option.label}
                            </span>
                          )
                        }
                        renderOption={(option) => (
                          <span className="flex items-center gap-2">
                            <Avatar size="sm">
                              <AvatarFallback>
                                <AgentIcon
                                  icon={option.icon}
                                  className="size-3.5"
                                />
                              </AvatarFallback>
                            </Avatar>
                            {option.label}
                          </span>
                        )}
                      />
                    </div>
                    <p
                      role={addedAgentName ? "status" : undefined}
                      className="text-xs text-muted-foreground"
                    >
                      {addedAgentName
                        ? `${addedAgentName} added to this connection’s allowed agents.`
                        : "Choosing an agent also gives them access to this connection."}
                    </p>
                  </section>
                  {trustNotice}
                  {footer(
                    "permissions",
                    "address",
                    "Continue",
                    !chosenAgent || (lowTrust && !scoped),
                  )}
                </>
              )}
              {screen === "address" && (
                <>
                  <section className="space-y-5 rounded-xl border border-border p-6">
                    <div className="space-y-1">
                      <h2 className="text-lg font-semibold">
                        Choose {chosenAgent?.name}’s email address
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        Create an address or attach an inbox already in
                        AgentMail.
                      </p>
                    </div>
                    <RadioCardGroup
                      ariaLabel="Email address source"
                      value={addressMode}
                      onValueChange={setAddressMode}
                      className="sm:grid-cols-2"
                      options={[
                        {
                          value: "new",
                          title: "Create a new address",
                          description: "Ready to use. No domain setup.",
                        },
                        {
                          value: "existing",
                          title: "Use an existing inbox",
                          description: "Bring an address you already have.",
                        },
                      ]}
                    />
                    {addressMode === "new" ? (
                      <div className="space-y-2">
                        <Label htmlFor="preview-address-name">
                          Email address
                        </Label>
                        <div className="flex items-center overflow-hidden rounded-md border border-input focus-within:ring-1 focus-within:ring-ring">
                          <Input
                            id="preview-address-name"
                            value={username}
                            onChange={(e) =>
                              setUsername(e.target.value.toLowerCase())
                            }
                            className="min-w-0 border-0 shadow-none focus-visible:ring-0"
                          />
                          <span className="shrink-0 pr-3 text-sm text-muted-foreground">
                            @{domain}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Suggested from the agent’s name. You can change it.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label htmlFor="preview-existing-inbox">
                          Available inbox
                        </Label>
                        <select
                          className={selectClass}
                          id="preview-existing-inbox"
                          value={existingAddress}
                          onChange={(e) => setExistingAddress(e.target.value)}
                        >
                          <option>support-team@agentmail.to</option>
                          <option>hello@acme.example.test</option>
                          <option disabled>
                            operations@agentmail.to — already assigned
                          </option>
                        </select>
                        <p className="text-xs text-muted-foreground">
                          Only unassigned inboxes accessible to this credential
                          are available.
                        </p>
                      </div>
                    )}
                    <details
                      open={advanced || undefined}
                      className="border-t border-border pt-4"
                    >
                      <summary className="cursor-pointer text-sm text-muted-foreground">
                        Advanced options
                      </summary>
                      <div className="space-y-5 pt-5">
                        {addressMode === "new" && (
                          <div className="space-y-2">
                            <Label htmlFor="preview-email-domain">Domain</Label>
                            <select
                              className={selectClass}
                              id="preview-email-domain"
                              value={domain}
                              onChange={(e) => setDomain(e.target.value)}
                            >
                              <option value="agentmail.to">
                                agentmail.to — ready to use
                              </option>
                              <option value="acme.example.test">
                                acme.example.test — verified
                              </option>
                            </select>
                            <a
                              className="text-xs text-muted-foreground underline underline-offset-4"
                              href="https://docs.agentmail.to/custom-domains"
                              target="_blank"
                              rel="noreferrer"
                            >
                              Set up another domain in AgentMail ↗
                            </a>
                          </div>
                        )}
                        <RadioCardGroup
                          ariaLabel="Receiving mode"
                          value={receiveMode}
                          onValueChange={setReceiveMode}
                          options={[
                            {
                              value: "websocket",
                              title: "Live connection (recommended)",
                              description:
                                "Works locally. No public URL needed.",
                            },
                            {
                              value: "webhook",
                              title: "Webhook",
                              description:
                                "For a Paperclip server with a public HTTPS address.",
                            },
                          ]}
                        />
                        {receiveMode === "webhook" && (
                          <p className="text-xs text-muted-foreground">
                            Paperclip registers and verifies the webhook at your
                            server’s public address. This preview assumes HTTPS
                            is configured.
                          </p>
                        )}
                      </div>
                    </details>
                  </section>
                  {inboxNotice}
                  {footer(
                    "agent",
                    "review",
                    "Review email address",
                    !validAddress,
                  )}
                </>
              )}
              {screen === "review" && (
                <>
                  {inboxNotice}
                  {trustNotice}
                  <section className="space-y-5 rounded-xl border border-border p-6">
                    <div className="space-y-1">
                      <h2 className="text-lg font-semibold">
                        Ready to start receiving email?
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {addressMode === "new"
                          ? "We’ll create this inbox in AgentMail and assign it to your agent."
                          : "We’ll attach this inbox to your agent. Existing mail stays in AgentMail."}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-4">
                      <Mail className="size-5 shrink-0" />
                      <p className="break-all text-lg font-semibold">
                        {address}
                      </p>
                    </div>
                    <dl className="divide-y divide-border">
                      <Fact label="Assigned agent">{chosenAgent?.name}</Fact>
                      <Fact label="Connection">AgentMail · Company email</Fact>
                      <Fact label="New email from">{senderSummary}</Fact>

                      <Fact label="Agent trust">
                        {lowTrust ? "Low-trust review" : "Standard"}
                      </Fact>
                      <Fact label="Receiving">
                        {receiveMode === "websocket"
                          ? "Live connection"
                          : "Signed webhook"}
                      </Fact>
                    </dl>
                    <div className="space-y-2 text-sm text-muted-foreground">
                      <p>
                        New conversations create tasks. Replies stay in the same
                        task.
                      </p>
                      <p>
                        Task comments stay internal. Sending email is an
                        explicit action.
                      </p>
                      <p>
                        Receiving starts now. Older mail is added only when
                        needed for a new reply.
                      </p>
                    </div>
                  </section>
                  <div className="flex items-center justify-between border-t border-border pt-5">
                    <Button variant="ghost" onClick={() => go("address")}>
                      <ArrowLeft className="size-4" />
                      Back
                    </Button>
                    <Button
                      disabled={!canActivate}
                      onClick={() => {
                        setHasInbox(true);
                        go("ready");
                      }}
                    >
                      {addressMode === "new"
                        ? "Create email address"
                        : "Connect email address"}
                      <ArrowRight className="size-4" />
                    </Button>
                  </div>
                </>
              )}
              {screen === "ready" && (
                <section className="space-y-6 rounded-xl border border-border p-6">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Check className="size-5" />
                    Receiving email for {chosenAgent?.name}
                  </div>
                  {inboxNotice}
                  <p className="text-sm text-muted-foreground">
                    New email: {senderSummary} · Agent trust:{" "}
                    {lowTrust ? "Low-trust review" : "Standard"}
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-4">
                    <p className="break-all text-lg font-semibold">{address}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(address)
                          .then(() => setCopied(true));
                      }}
                    >
                      <Copy className="size-3.5" />
                      {copied ? "Copied" : "Copy address"}
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-sm font-semibold">
                      Try it with a test email
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Send a message from an allowed sender. A new task will
                      appear for {chosenAgent?.name}, ready for an explicit
                      email reply.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      This is a design preview; this sample address hasn’t been
                      created.
                    </p>
                  </div>
                  <Button onClick={() => go("permissions")}>
                    Back to permissions
                    <ArrowRight className="size-4" />
                  </Button>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
      <Dialog open={trustDialog} onOpenChange={setTrustDialog}>
        <DialogContent className="max-h-screen overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Trust settings · {chosenAgent?.name}</DialogTitle>
            <DialogDescription>
              Changes apply to all of this agent’s work. Use a dedicated email
              agent if its other tasks need broader access.
            </DialogDescription>
          </DialogHeader>
          <TrustPresetSection
            permissions={draftPermissions}
            onChange={setDraftPermissions}
            companyId={COMPANY}
            projectCandidates={[{ id: "email-work", label: "Email work" }]}
            issueCandidates={[]}
          />
          <p className="text-xs text-muted-foreground">
            Low trust limits Paperclip access; it does not sandbox the runtime.
            Review filesystem, tool, and secret access separately.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTrustDialog(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                getTrustPreset(draftPermissions) === "low_trust_review" &&
                !lowTrustBoundaryHasScope(getLowTrustBoundary(draftPermissions))
              }
              onClick={() => {
                setPermissions((current) => ({
                  ...current,
                  [agentId]: draftPermissions,
                }));
                setTrustDialog(false);
              }}
            >
              Save trust settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Connections/AgentMail setup",
  component: AgentMailJourney,
  parameters: { layout: "fullscreen" },
  args: { initial: "catalog" },
} satisfies Meta<typeof AgentMailJourney>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Walkthrough: Story = { name: "Start here · Full walkthrough" };
export const CatalogCard: Story = { name: "01 · Apps catalog card" };
export const ConnectionAccess: Story = {
  name: "02 · Humans and agents",
  args: { initial: "access" },
};
export const ApiKey: Story = { name: "03 · API key", args: { initial: "key" } };
export const ConnectionReady: Story = {
  name: "04 · Connection ready",
  args: { initial: "connected" },
};
export const Permissions: Story = {
  name: "05 · Permissions",
  args: { initial: "permissions" },
};
export const ChooseAgent: Story = {
  name: "06 · Choose an agent",
  args: { initial: "agent" },
};
export const ChooseAddress: Story = {
  name: "07 · Choose an address",
  args: { initial: "address" },
};
export const ExistingInbox: Story = {
  name: "07b · Attach existing inbox",
  args: { initial: "address", existing: true },
};
export const AdvancedOptions: Story = {
  name: "07c · Advanced options",
  args: { initial: "address", advanced: true },
};
export const Review: Story = {
  name: "08 · Review and activate",
  args: { initial: "review" },
};
export const Ready: Story = {
  name: "09 · Email address ready",
  args: { initial: "ready" },
};
export const InvalidKey: Story = {
  name: "Error · Invalid API key",
  args: { initial: "key", invalidKey: true },
};
export const TestedWalkthrough: Story = {
  name: "Verification · Complete journey",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Connect AgentMail" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await userEvent.type(
      canvas.getByLabelText("API key", { exact: true }),
      "sample-preview-key",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Connect AgentMail" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Open permissions" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Give an agent an email address" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Review email address" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Create email address" }),
    );
    await expect(
      canvas.getByRole("heading", { name: "Your agent’s email is ready" }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Back to permissions" }),
    );
    await expect(
      canvas.getByText("Receiving email", { exact: true }),
    ).toBeVisible();
  },
};

export const SearchAllAgents: Story = {
  name: "06b · Search and grant agent access",
  args: { initial: "agent" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("combobox"));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.type(
      page.getByPlaceholderText("Search all agents…"),
      "Research",
    );
    await userEvent.click(page.getByRole("option", { name: "Research" }));
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Research added to this connection’s allowed agents.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(canvas.getByText("Support, Research")).toBeVisible();
  },
};

export const PublicInboxWarning: Story = {
  name: "Controls · Public inbox warning",
  args: { initial: "review", senderStatus: "anyone" },
};
export const LowTrustAgent: Story = {
  name: "Controls · Low-trust agent",
  args: { initial: "agent", trustDefault: "low_trust_review" },
};
export const MissingTrustBoundary: Story = {
  name: "Controls · Low trust needs a boundary",
  args: { initial: "agent", trustDefault: "unscoped" },
};
export const UnknownSenderPolicy: Story = {
  name: "Controls · Could not verify restrictions",
  args: { initial: "review", existing: true, policyUnknown: true },
};
export const ManagedSenderPolicy: Story = {
  name: "Controls · Managed in AgentMail",
  args: {
    initial: "review",
    senderStatus: "managed",
    trustDefault: "low_trust_review",
  },
};
export const VerifySenderControls: Story = {
  name: "Verification · Email safety guidance",
  args: { initial: "review" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Anyone can email this agent")).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "Set up allowlists ↗" }),
    ).toHaveAttribute(
      "href",
      "https://docs.agentmail.to/knowledge-base/allowlists-blocklists",
    );
    await expect(
      canvas.getByText("Support is not a low-trust agent"),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Configure low trust" }),
    );
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByText(
        "Changes apply to all of this agent’s work. Use a dedicated email agent if its other tasks need broader access.",
      ),
    ).toBeVisible();
    const dialog = within(page.getByRole("dialog"));
    await userEvent.selectOptions(
      dialog.getAllByRole("combobox")[0]!,
      "low_trust_review",
    );
    await expect(
      dialog.getByRole("button", { name: "Save trust settings" }),
    ).toBeDisabled();
    await userEvent.selectOptions(
      dialog.getAllByRole("combobox")[2]!,
      "email-work",
    );
    await userEvent.click(
      dialog.getByRole("button", { name: "Save trust settings" }),
    );
    await expect(canvas.getByText("Low-trust review configured")).toBeVisible();
    await expect(canvas.getByText("Anyone can email this agent")).toBeVisible();
  },
};
