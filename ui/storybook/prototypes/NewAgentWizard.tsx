import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Plus, RotateCcw, Settings2, Users } from "lucide-react";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { AdapterMark as AgentAdapterMark } from "@/components/new-agent/AgentBasicsDialog";
import { setupEfforts, SETUP_CREDENTIAL_KEYS, SETUP_LOGIN_HINTS } from "@/lib/agent-setup-fields";
import { isNewAgentAdapterAllowed } from "@/lib/new-agent-adapters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PillGuy } from "@/components/onboarding/PillGuy";
import { cn } from "@/lib/utils";
import { ProviderConnectionPreview, type ConnectionMethod, type ConnectionProvider } from "./ProviderConnectionPreview";

import { RuntimeTestCard } from "./RuntimeTestCard";
import { ModelDropdown } from "@/components/AgentConfigForm";
import { OnboardingCard, OnboardingHeading } from "@/components/onboarding/OnboardingPrimitives";
import { Field } from "@/components/agent-config-primitives";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { useDialog } from "@/context/DialogContext";
import { useCompany } from "@/context/CompanyContext";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { agentsApi } from "@/api/agents";
import type { AdapterEnvironmentTestResult, Agent } from "@paperclipai/shared";
import { storybookAgents, storybookHiredAgent } from "../fixtures/paperclipData";
import { PREVIEW_AGENT_ID, PREVIEW_COMPANY_ID, runtimeTestResult, useNewAgentFixtures, type TestOutcome, type TestState } from "./new-agent-fixtures";
import { stepMotion } from "@/components/onboarding/onboarding-motion";
import { models as claudeModels } from "@paperclipai/adapter-claude-local";
import { models as codexModels } from "@paperclipai/adapter-codex-local";
import { models as openCodeModels } from "@paperclipai/adapter-opencode-local";
import { models as cursorModels } from "@paperclipai/adapter-cursor-local";
import { models as geminiModels } from "@paperclipai/adapter-gemini-local";
import { models as grokModels } from "@paperclipai/adapter-grok-local";
import { models as kimiModels } from "@paperclipai/adapter-kimi-local";

const modelLists = {
  claude_local: claudeModels, codex_local: codexModels, opencode_local: openCodeModels,
  cursor: cursorModels, gemini_local: geminiModels, grok_local: grokModels, kimi_local: kimiModels,
  cursor_cloud: [], pi_local: [], hermes_local: [],
};

// Review-only flow. All edits and the simulated hire live in React state;
// importing this from Storybook never creates an agent or contacts a provider.
export const NEW_AGENT_ADAPTERS = [
  "claude_local", "codex_local", "cursor", "cursor_cloud", "gemini_local",
  "grok_local", "kimi_local", "opencode_local", "pi_local", "hermes_local", "paperclip_runner",
] as const;
export type NewAgentAdapter = typeof NEW_AGENT_ADAPTERS[number];
export type NewAgentScreen = "name" | "adapter" | "connect" | "runtime" | "saved";

export type RunnerProvider = "Codex (app server)" | "OpenCode" | "Claude (ACPX)";

type RuntimeDraft = {
  model: string; effort: string; repoUrl: string; branch: string; apiKey: string; kimiModel: string;
};
function defaultRuntime(): RuntimeDraft {
  return { model: "", effort: "Auto", repoUrl: "", branch: "", apiKey: "", kimiModel: "" };
}

function AdapterMark({ adapter }: { adapter: NewAgentAdapter }) {
  return <AgentAdapterMark type={adapter} />;
}

function TextField({ label, hint, value, onChange, placeholder, required, invalid, readOnly, type = "text" }: {
  label: string; hint?: string; value: string; onChange: (value: string) => void;
  placeholder?: string; required?: boolean; invalid?: boolean; readOnly?: boolean; type?: string;
}) {
  const id = useId();
  return <div className="flex flex-col gap-2">
    <label htmlFor={id} className="text-sm font-medium">{label}{required && <span className="text-muted-foreground"> (required)</span>}</label>
    <Input id={id} type={type} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder}
      required={required} readOnly={readOnly} aria-invalid={invalid || undefined} aria-describedby={hint ? `${id}-hint` : undefined} />
    {hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
  </div>;
}

function SelectField({ label, value, onChange, options, hint, hideLabel = false }: {
  label: string; value: string; onChange: (value: string) => void; options: string[]; hint?: string; hideLabel?: boolean;
}) {
  const control = <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}
    className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
    {options.map(option => <option key={option}>{option}</option>)}
  </select>;
  return hideLabel ? control : <Field label={label} hint={hint}>{control}</Field>;
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="flex flex-col gap-5">
    <div className="flex flex-col gap-1"><h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}</div>
    {children}
  </section>;
}

export function NewAgentWizard({ initialScreen = "name", initialAdapter = null, initialName = "", initialOpen = true, cloud = false, nativeRunnerEnabled = true,
  initialRunnerProvider = "Codex (app server)", initialConnectionMethod = "subscription", initialConnectionWaiting = false, initialTestState = "idle", testOutcome = "pass", testDelayMs = 1200,
}: {
  cloud?: boolean; nativeRunnerEnabled?: boolean;
  initialScreen?: NewAgentScreen; initialAdapter?: NewAgentAdapter | null; initialName?: string; initialOpen?: boolean;
  initialRunnerProvider?: RunnerProvider; initialConnectionMethod?: ConnectionMethod; initialConnectionWaiting?: boolean;
  initialTestState?: TestState; testOutcome?: TestOutcome; testDelayMs?: number;
}) {
  const { openNewIssue, closeNewIssue } = useDialog();
  const { setSelectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [taskCreated, setTaskCreated] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>(initialTestState);
  const [testResult, setTestResult] = useState<AdapterEnvironmentTestResult | null>(() => initialTestState === "pass" || initialTestState === "fail"
    ? runtimeTestResult(initialAdapter ?? "claude_local", initialTestState, "", "Organization default") : null);
  const testRun = useRef(0);
  const resetTest = () => { testRun.current++; setTestState("idle"); setTestResult(null); };
  const [screen, setScreen] = useState<NewAgentScreen>(initialScreen);
  const [name, setName] = useState(initialName);
  const [adapter, setAdapter] = useState<NewAgentAdapter | null>(initialAdapter);
  const [open, setOpen] = useState(initialOpen);
  const [drafts, setDrafts] = useState<Record<string, RuntimeDraft>>({});
  const [environments, setEnvironments] = useState<Partial<Record<NewAgentAdapter, string>>>({});
  const [runnerProvider, setRunnerProvider] = useState<RunnerProvider>(initialRunnerProvider);
  const [connections, setConnections] = useState<Record<string, ConnectionMethod | undefined>>(() => {
    if (initialScreen !== "runtime" && initialScreen !== "saved") return {};
    const key = initialAdapter === "paperclip_runner" ? `${initialAdapter}/${initialRunnerProvider}` : initialAdapter ?? "claude_local";
    return { [key]: initialConnectionMethod };
  });
  const [modelOpen, setModelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const nameId = useId();
  const modal = screen === "name" || screen === "adapter";
  const selected = adapter ?? "claude_local";
  const display = getAdapterDisplay(selected);
  const environment = environments[selected] ?? "Organization default";
  const isRunner = selected === "paperclip_runner";
  const isAcpx = isRunner && runnerProvider === "Claude (ACPX)";
  const usesOpenCode = selected === "opencode_local" || (isRunner && runnerProvider === "OpenCode");
  // Preserve model choices independently for each runner provider.
  const draftKey = isRunner ? `${selected}/${runnerProvider}` : selected;
  const connectionProvider: ConnectionProvider | null = selected === "claude_local" || isAcpx ? "Claude"
    : selected === "codex_local" || (isRunner && runnerProvider === "Codex (app server)") ? "OpenAI" : null;
  const connectionKey = draftKey;
  const connectedMethod = connections[connectionKey];
  const brandAdapter = isRunner ? isAcpx ? "claude_local" : runnerProvider === "OpenCode" ? "opencode_local" : "codex_local" : selected;
  const models = modelLists[brandAdapter as keyof typeof modelLists];
  const draft = drafts[draftKey] ?? defaultRuntime();
  const setDraft = (patch: Partial<RuntimeDraft>) => {
    setDrafts(previous => ({ ...previous, [draftKey]: { ...(previous[draftKey] ?? defaultRuntime()), ...patch } }));
    setError(null); resetTest();
  };
  const go = (next: NewAgentScreen) => { setError(null); setScreen(next); };
  useEffect(() => { if (!modal) heading.current?.focus(); }, [screen, modal]);

  function validateRuntime() {
    if (selected === "cursor_cloud" && !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/.test(draft.repoUrl.trim())) {
      setError("Enter the GitHub repository URL for this Cursor Cloud agent.");
      return false;
    }
    if (selected === "cursor_cloud" && !draft.apiKey.trim()) {
      setError("Enter a Cursor API key.");
      return false;
    }
    return true;
  }

  const adapterConfig = {
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.effort !== "Auto" ? { [isRunner ? "thinkingEffort" : selected === "codex_local" ? "modelReasoningEffort" : "thinkingEffort"]: draft.effort.toLowerCase() } : {}),
    ...(isRunner ? { provider: isAcpx ? "acpx" : runnerProvider === "OpenCode" ? "opencode" : "codex", ...(isAcpx ? { acpxAgent: "claude" } : {}) } : {}),
    ...(selected === "cursor_cloud" ? { repoUrl: draft.repoUrl, repoStartingRef: draft.branch } : {}),
  };
  const previewAgent: Agent = { ...storybookHiredAgent, id: PREVIEW_AGENT_ID, name: name || "Darnold", adapterType: selected, adapterConfig };
  useNewAgentFixtures(previewAgent, testOutcome, testDelayMs, setTaskCreated);
  useEffect(() => () => {
    testRun.current++; closeNewIssue();
    queryClient.setQueryData<Agent[]>(queryKeys.agents.list(PREVIEW_COMPANY_ID), previous => previous?.filter(agent => agent.id !== PREVIEW_AGENT_ID));
  }, [closeNewIssue, queryClient]);
  async function runTest() {
    if (!validateRuntime()) return;
    const run = ++testRun.current;
    setTestState("running"); setTestResult(null); setError(null);
    try {
      const result = await agentsApi.testEnvironment(PREVIEW_COMPANY_ID, selected, {
        adapterConfig,
        environmentId: environment === "Paperclip Computer" ? "environment-storybook-sandbox"
          : environment === "Local machine" ? "environment-storybook-local" : null,
      });
      if (testRun.current !== run) return;
      setTestResult(result); setTestState(result.status === "pass" ? "pass" : "fail");
    } catch (cause) {
      if (testRun.current !== run) return;
      setTestState("fail"); setError(cause instanceof Error ? cause.message : "Runtime test failed. Try again.");
    }
  }
  useEffect(() => { if (initialTestState === "running") void runTest(); }, []);
  function assignTask() {
    setSelectedCompanyId(PREVIEW_COMPANY_ID);
    queryClient.setQueryData(queryKeys.agents.list(PREVIEW_COMPANY_ID), [...storybookAgents, previewAgent]);
    openNewIssue({ assigneeAgentId: PREVIEW_AGENT_ID, status: "todo" });
  }
  const steps: { screen: NewAgentScreen; label: string }[] = [
    ...(connectionProvider ? [{ screen: "connect" as const, label: "Connect" }] : []),
    { screen: "runtime", label: "Configure" }, { screen: "saved", label: "Confirmation" },
  ];
  const currentStep = steps.findIndex(step => step.screen === screen);

  return <MotionConfig reducedMotion="user">
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-3">
        <span className="text-xs text-muted-foreground">Design preview · Changes stay in this story</span>
        <Button size="sm" variant="ghost" onClick={() => {
          resetTest(); setTaskCreated(null); setName(""); setAdapter(null); setDrafts({}); setEnvironments({}); setRunnerProvider("Codex (app server)"); setConnections({}); go("name"); setOpen(true);
        }}><RotateCcw className="size-3.5" />Start over</Button>
      </div>

      {modal ? <>
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-10">
          <div className="flex items-center justify-between"><div className="flex flex-col gap-1">
            <h1 className="text-xl font-bold">Agents</h1><p className="text-sm text-muted-foreground">The people behind your company.</p>
          </div>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild><Button><Plus className="size-4" />New agent</Button></DialogTrigger>
              <DialogContent className={cn("flex max-h-(--sz-calc-18) flex-col gap-0 overflow-hidden p-0 sm:max-w-(--sz-640px)", screen === "name" && "sm:max-w-(--sz-560px)")}>
                <div className="flex items-center gap-2 px-6 py-5 text-xs text-muted-foreground" aria-label="New agent progress">
                  <span className={cn(screen === "name" && "text-foreground font-medium")}>1. Name</span><ChevronRight className="size-3" />
                  <span className={cn(screen === "adapter" && "text-foreground font-medium")}>2. Adapter</span>
                </div>
                <form className="flex min-h-0 flex-col" onSubmit={event => {
                  event.preventDefault();
                  if (!name.trim()) return;
                  if (screen === "name") go("adapter");
                  else if (adapter) { setName(name.trim()); setOpen(false); go(connectionProvider ? "connect" : "runtime"); }
                }}>
                  <div className="flex min-h-0 flex-col gap-7 overflow-y-auto px-6 pb-8 sm:px-10">
                    <div className="flex flex-col items-center gap-4 text-center">
                      <PillGuy state="dormant" className="size-16" />
                      <div className="flex flex-col gap-2">
                        <DialogTitle className="text-3xl font-semibold tracking-tight">{screen === "name" ? "Meet your next agent" : "Choose an adapter"}</DialogTitle>
                        <DialogDescription className="text-base">
                          {screen === "name" ? "Start with a name. Make them your own." : `How should ${name.trim() || "your agent"} work?`}
                        </DialogDescription>
                      </div>
                    </div>
                    {screen === "name" ? <div className="flex flex-col gap-2">
                      <label htmlFor={nameId} className="text-sm font-medium">Agent name</label>
                      <Input id={nameId} autoFocus maxLength={100} placeholder="e.g. Darnold" value={name} onChange={event => setName(event.target.value)} className="h-12 text-base" />
                    </div> : <fieldset className="flex flex-col gap-3">
                      <legend className="sr-only">Adapter</legend>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {NEW_AGENT_ADAPTERS.filter(type => isNewAgentAdapterAllowed(type, { cloud, nativeRunnerEnabled })).map(type => {
                          const info = getAdapterDisplay(type);
                          return <label key={type} className="relative cursor-pointer">
                            <input type="radio" name="new-agent-adapter" value={type} checked={adapter === type} onChange={() => setAdapter(type)} className="peer sr-only" />
                            <span className={cn("flex h-full flex-col items-center gap-2 rounded-lg border px-3 py-4 text-center peer-focus-visible:ring-2 peer-focus-visible:ring-ring hover:bg-accent/40", adapter === type ? "border-foreground/40 bg-accent" : "border-border bg-card")}>
                              <span aria-hidden="true"><AdapterMark adapter={type} /></span>
                              <span className="text-sm font-medium">{info.label}</span>
                              {adapter === type && <Check className="absolute right-2 top-2 size-3.5" />}
                            </span>
                          </label>;
                        })}
                      </div>
                      {adapter === "paperclip_runner" && <SelectField label="Runner" value={runnerProvider}
                        options={["Codex (app server)", "Claude (ACPX)", "OpenCode"]} onChange={value => setRunnerProvider(value as RunnerProvider)} />}
                    </fieldset>}
                  </div>
                  <div className="flex items-center justify-between gap-4 border-t border-border px-6 py-4">
                    <Button type="button" variant="ghost" onClick={() => screen === "name" ? setOpen(false) : go("name")}>
                      {screen === "name" ? "Cancel" : <><ArrowLeft className="size-4" />Back</>}
                    </Button>
                    <Button type="submit" disabled={!name.trim() || (screen === "adapter" && !adapter)}>
                      {screen === "name" ? "Choose adapter" : "Create agent"}<ArrowRight className="size-4" />
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
          <div className="flex items-center gap-4 rounded-lg border border-border p-5"><Users className="size-8 text-muted-foreground" />
            <div className="flex flex-col gap-1"><p className="text-sm font-medium">Build your team</p><p className="text-sm text-muted-foreground">Create a new agent to get started.</p></div>
          </div>
        </div>
      </> : <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>Agents</span><ChevronRight className="size-3" /><span>{name || "Darnold"}</span><ChevronRight className="size-3" /><span className="text-foreground">{screen === "connect" ? "Connect" : screen === "saved" ? "Confirmation" : "Configuration"}</span></div>
          <div className="flex items-start gap-4">
            <PillGuy state="dormant" className="size-14 shrink-0" />
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3"><h1 ref={heading} tabIndex={-1} className="break-words text-2xl font-semibold tracking-tight outline-none">{name || "Darnold"}</h1><Badge variant="outline">{screen === "saved" ? "Configured" : "Setup in progress"}</Badge></div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><AdapterMark adapter={brandAdapter} /><span>{getAdapterDisplay(brandAdapter).label}</span>{isRunner && <Badge variant="outline">{runnerProvider === "Codex (app server)" ? "Native app server runner" : runnerProvider === "Claude (ACPX)" ? "ACPX runner" : "Paperclip Runner"}</Badge>}</div>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-8 md:flex-row">
          <nav aria-label="Agent setup steps" className="shrink-0 md:w-44">
            <ol className="flex flex-wrap gap-2 md:flex-col">{steps.map((step, index) => <li key={step.screen} className="flex-1">
              <button type="button" aria-current={index === currentStep ? "step" : undefined} disabled={index > currentStep || testState === "running"}
                onClick={() => go(step.screen)} className={cn("flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm disabled:cursor-default", index === currentStep ? "bg-accent font-medium" : "text-muted-foreground")}>
                <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border text-xs", index === currentStep ? "border-foreground bg-foreground text-background" : "border-border")}>{index + 1}</span>
                {step.label}
              </button>
            </li>)}</ol>
          </nav>
          <div className="min-w-0 flex-1">
        <AnimatePresence mode="wait" initial={false}><motion.div key={screen} {...stepMotion}>
        {screen === "connect" && connectionProvider ? <OnboardingCard className="mx-auto">
          <div className="mb-8"><OnboardingHeading title="Connect a model" lede={`Connect ${name || "Darnold"} to ${connectionProvider}.`} center /></div>
          <ProviderConnectionPreview provider={connectionProvider} initialMethod={connectedMethod ?? initialConnectionMethod} initialWaiting={initialConnectionWaiting}
            onConnected={method => { resetTest(); setConnections(previous => ({ ...previous, [connectionKey]: method })); go("runtime"); }} />
        </OnboardingCard> : screen === "saved" ? <div className="flex max-w-2xl flex-col gap-6">
          <div className="flex flex-col gap-6 rounded-lg border border-border p-6">
            <div className="flex items-center gap-3"><Check className="size-5" /><h2 className="text-lg font-semibold">Your agent is ready</h2></div>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <dt className="text-muted-foreground">Adapter</dt><dd>{display.label}</dd>
              {selected !== "cursor_cloud" && <><dt className="text-muted-foreground">Model</dt><dd className="break-all font-mono text-xs">{draft.model || "Default"}</dd></>}
              {isRunner && <><dt className="text-muted-foreground">Provider</dt><dd>{runnerProvider}</dd></>}
              {connectionProvider && <><dt className="text-muted-foreground">Connection</dt><dd>{connectionProvider} · {connectedMethod === "api" ? "API key" : connectedMethod === "subscription" ? "Subscription" : "Not connected"}</dd></>}
              <dt className="text-muted-foreground">Environment</dt><dd>{selected === "cursor_cloud" ? "Cursor Cloud" : environment}</dd>
            </dl>
            <p className="text-sm text-muted-foreground">Your agent has not started running.</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="outline" onClick={() => go("runtime")}><Settings2 className="size-4" />Edit configuration</Button>
            <Button onClick={assignTask}>Assign {name || "Darnold"} a Task<ArrowRight className="size-4" /></Button>
          </div>
          {taskCreated && <p role="status" className="text-sm text-muted-foreground">Task created: {taskCreated}</p>}
        </div> : <form className="flex min-w-0 flex-col gap-8" onSubmit={event => {
          event.preventDefault();
          if (testState !== "running" && testState !== "fail" && (!connectionProvider || connectedMethod) && validateRuntime()) go("saved");
        }}>
          <h2 className="text-xl font-semibold">Configure your agent</h2>
          <fieldset disabled={testState === "running"} className="flex min-w-0 flex-col gap-8">
          <Section title="Runtime">
            {selected === "cursor_cloud" && <div className="grid gap-5 sm:grid-cols-2">
              <TextField label="GitHub repository" required value={draft.repoUrl} onChange={repoUrl => setDraft({ repoUrl })} placeholder="https://github.com/your-org/your-repo" />
              <TextField label="Branch" value={draft.branch} onChange={branch => setDraft({ branch })} placeholder="Repository default" />
            </div>}
            <div className="grid gap-5 sm:grid-cols-2">
              {selected !== "cursor_cloud" && !(selected === "kimi_local" && draft.apiKey) && <div className="flex flex-col gap-2">
                <ModelDropdown models={models} value={draft.model} onChange={model => setDraft({ model })}
                  open={modelOpen} onOpenChange={setModelOpen} allowDefault required={false} groupByProvider={usesOpenCode}
                  creatable defaultLabel="Default" />
              </div>}
              {!isRunner && setupEfforts(selected, draft.model).length > 0 && <SelectField label="Thinking effort" value={draft.effort} onChange={effort => setDraft({ effort })} options={["Auto", ...setupEfforts(selected, draft.model)]} />}
            </div>
            {SETUP_LOGIN_HINTS[selected] && <p className="text-sm text-muted-foreground">{SETUP_LOGIN_HINTS[selected]}</p>}
            {SETUP_CREDENTIAL_KEYS[selected] && <>
              <TextField type="password" label={SETUP_CREDENTIAL_KEYS[selected]} required={selected === "cursor_cloud"} value={draft.apiKey} onChange={apiKey => setDraft({ apiKey })} />
              {selected === "cursor_cloud" && <a href="https://cursor.com/dashboard/api?section=user-keys#user-api-keys" target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">get api key</a>}
              <p className="text-xs text-muted-foreground">New keys are saved as organization secrets when you finish setup.</p>
            </>}
            {selected === "kimi_local" && draft.apiKey && <TextField label="Kimi API model name" value={draft.kimiModel} onChange={kimiModel => setDraft({ kimiModel })} placeholder="kimi-for-coding" required />}
          </Section>
          {selected !== "cursor_cloud" && <Section title="Environment">
            <SelectField label="Environment" hideLabel value={environment} onChange={value => { setEnvironments(previous => ({ ...previous, [selected]: value })); resetTest(); }} options={["Organization default", "Paperclip Computer", "Local machine"]} />
          </Section>}
          </fieldset>
          <RuntimeTestCard state={testState} result={testResult} error={error} onTest={() => void runTest()} />
          {error && testState !== "fail" && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-between border-t border-border py-5">
            {connectionProvider ? <Button type="button" variant="ghost" disabled={testState === "running"} onClick={() => go("connect")}><ArrowLeft className="size-4" />Connection</Button> : <span />}
            <Button type="submit" disabled={testState === "running" || testState === "fail" || !!connectionProvider && !connectedMethod}>Finish setup<Check className="size-4" /></Button>
          </div>
        </form>}
        </motion.div></AnimatePresence>
          </div>
        </div>
      </div>}
      <NewIssueDialog />
    </div>
  </MotionConfig>;
}
