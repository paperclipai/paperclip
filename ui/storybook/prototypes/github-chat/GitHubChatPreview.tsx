import { GitHubAgentTrustWarning } from "@/components/GitHubAgentTrustWarning";
import { GitHubSetupPrompt } from "@/pages/apps/chat/GitHubSetupPrompt";
import { AccessEditor } from "./AccessEditor";
import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  RefreshCw,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Copy,
  ExternalLink,
  GitPullRequest,
  Loader2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  SetupWizardNavigation,
  SetupWizardFooter,
} from "@/components/SetupWizard";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  steps,
  sections,
  repositories,
  reviewLabels,
  initialDraft,
  type Draft,
  type Section,
  type Scenario,
  type ReviewState,
  type ReviewConfig,
  type PromptKind,
} from "./fixtures";

const selectClass =
  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
function Help({ text }: { text: string }) {
  return (
    <details className="relative inline-block font-normal">
      <summary className="cursor-pointer list-none text-muted-foreground">
        <CircleHelp className="size-3.5" aria-label="Field help" />
      </summary>
      <p className="absolute right-0 z-10 mt-2 w-60 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-sm">
        {text}
      </p>
    </details>
  );
}
function Field({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={label}>{label}</Label>
        <Help text={help} />
      </div>
      {children}
    </div>
  );
}
function Select({
  label,
  value,
  onChange,
  options,
  help,
  disabled = false,
}: {
  disabled?: boolean;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  help: string;
}) {
  return (
    <Field label={label} help={help}>
      <select
        disabled={disabled}
        id={label}
        className={selectClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  );
}
function Toggle({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <ToggleSwitch
        aria-label={label}
        checked={value}
        onCheckedChange={onChange}
      />
    </div>
  );
}
function Notice({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "warning" | "success" | "error";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border p-4 text-sm",
        tone === "muted" && "border-border bg-muted/40",
        tone === "warning" &&
          "border-(--status-task-todo)/30 bg-(--status-task-todo)/10",
        tone === "success" &&
          "border-(--status-task-done)/30 bg-(--status-task-done)/10",
        tone === "error" && "border-destructive/30 bg-destructive/10",
      )}
    >
      {children}
    </div>
  );
}
function CopyValue({ value }: { value: string }) {
  const [status, setStatus] = useState("");
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
        <code className="min-w-0 break-all text-xs">{value}</code>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Copy"
          onClick={() => {
            void copyTextToClipboard(value).then(
              () => setStatus("Copied"),
              () => setStatus("Select and copy the text above."),
            );
          }}
        >
          <Copy className="size-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {status}
      </p>
    </div>
  );
}
function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4 border-t border-border pt-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function ConfigEditor({
  config,
  onChange,
}: {
  config: ReviewConfig;
  onChange: (c: ReviewConfig) => void;
}) {
  const [prompt, setPrompt] = useState<PromptKind>("New PR");
  const update = <K extends keyof ReviewConfig>(
    key: K,
    value: ReviewConfig[K],
  ) => onChange({ ...config, [key]: value });
  const flag = (
    key: keyof ReviewConfig,
    label: string,
    description?: string,
  ) => (
    <Toggle
      key={key}
      label={label}
      description={description}
      value={Boolean(config[key])}
      onChange={(v) => onChange({ ...config, [key]: v })}
    />
  );
  const text = (key: keyof ReviewConfig, label: string, help: string) => (
    <Field key={key} label={label} help={help}>
      <Input
        id={label}
        value={String(config[key])}
        onChange={(e) => onChange({ ...config, [key]: e.target.value })}
      />
    </Field>
  );
  return (
    <div className="space-y-6">
      <Select
        label="Responsible user for automatic events"
        help="This member authorizes unattended work. Human mentions use the linked sender’s current Paperclip permissions."
        value={config.responsible}
        onChange={(v) => update("responsible", v)}
        options={[
          ["Dotta", "Dotta (you)"],
          ["Alex", "Alex Chen"],
        ]}
      />
      <>
        <Select
          label="Review automatically"
          help="This controls unprompted reviews. Authorized mentions can still request reviews."
          value={config.audience}
          onChange={(v) => update("audience", v)}
          options={[
            ["linked", "PRs authored by linked members"],
            ["all", "All allowed authors · sponsored by responsible user"],
            ["manual", "Never · mentions only"],
          ]}
        />
        {config.audience === "all" && (
          <Notice tone="warning">
            Reviews from allowed external authors and fork PRs are sponsored by{" "}
            {config.responsible}. Repository content remains untrusted.
          </Notice>
        )}
        <Group title="When to review">
          <div className="divide-y divide-border">
            {flag("opened", "New pull request")}
            {flag("reopened", "Pull request reopened")}
            {flag("ready", "Marked ready for review")}
            {flag(
              "commits",
              "New commits",
              "Rapid pushes combine into a review of the latest head.",
            )}
            {flag("drafts", "Review draft PRs")}
            {flag("bots", "Review bot-authored PRs")}
          </div>
        </Group>
        <Group title="Comments and PR checks">
          <div className="divide-y divide-border">
            {flag("summary", "Post a review summary")}
            {flag(
              "inline",
              "Post inline findings",
              "Add new findings and retain existing discussion.",
            )}
          </div>
          <Select
            label="Minimum passing rating"
            help="Paperclip compares the agent’s validated score with this threshold. Incomplete reviews never pass."
            value={config.threshold}
            onChange={(v) => update("threshold", v)}
            options={[
              ["5", "5/5 · no actionable issues"],
              ["4", "4/5"],
              ["3", "3/5"],
              ["2", "2/5"],
              ["1", "1/5"],
              ["off", "Report only · no rating gate"],
            ]}
          />
          <p className="text-xs text-muted-foreground">
            To block merging, require <strong>Paperclip Review</strong> from
            this GitHub App in your repository’s ruleset. Saving here does not
            change GitHub rules.
          </p>
        </Group>
        <details className="space-y-4 rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Advanced review options
          </summary>
          <div className="grid gap-4 sm:grid-cols-2">
            {text(
              "includeAuthors",
              "Include authors",
              "Comma-separated GitHub handles or patterns. Empty includes all eligible authors.",
            )}
            {text(
              "excludeAuthors",
              "Exclude authors",
              "Excluded authors take precedence.",
            )}
            {text(
              "includeBranches",
              "Include target branches",
              "For example: main, release/*",
            )}
            {text(
              "excludeBranches",
              "Exclude target branches",
              "Excluded target branches take precedence.",
            )}
            {text(
              "includeLabels",
              "Required labels",
              "Review PRs with any of these labels.",
            )}
            {text(
              "excludeLabels",
              "Excluded labels",
              "For example: no-review, wip",
            )}
          </div>
          <Field
            label="Ignored files"
            help="One path pattern per line. These exclusions also apply to manual review requests."
          >
            <Textarea
              id="Ignored files"
              value={config.ignoredFiles}
              onChange={(e) => update("ignoredFiles", e.target.value)}
            />
          </Field>
          {text(
            "categories",
            "Finding categories",
            "Focus the reviewer on the kinds of problems that matter to your team.",
          )}
          <Select
            label="Minimum comment severity"
            help="This filters published comments, not the findings used to calculate the rating."
            value={config.severity}
            onChange={(v) => update("severity", v)}
            options={[
              ["P0", "P0 · critical"],
              ["P1", "P1 · high"],
              ["P2", "P2 · medium"],
              ["P3", "P3 · low"],
            ]}
          />
          <Field
            label="Review instructions"
            help="These supplement the selected agent’s instructions and cannot expand its permissions."
          >
            <Textarea
              id="Review instructions"
              value={config.instructions}
              onChange={(e) => update("instructions", e.target.value)}
            />
          </Field>
          <Group title="Formal GitHub reviews">
            {flag(
              "approve",
              "Allow APPROVE reviews",
              "A separate agent action; scoring 5/5 never approves automatically.",
            )}
            {flag(
              "requestChanges",
              "Allow REQUEST_CHANGES reviews",
              "The agent must have permission to submit this action.",
            )}
          </Group>
        </details>
        <details className="space-y-4 rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Event prompts
          </summary>
          <p className="text-xs text-muted-foreground">
            Each event becomes a message in the existing Paperclip task. Your
            agent’s instructions and tool permissions still apply.
          </p>
          <Select
            label="Event"
            help="Customize the instruction supplied to the agent for this event."
            value={prompt}
            onChange={(v) => setPrompt(v as PromptKind)}
            options={Object.keys(config.templates).map((k) => [k, k])}
          />
          <Field
            label="Message to agent"
            help="The server supplies event variables. External comment text is treated as untrusted content."
          >
            <Textarea
              id="Message to agent"
              className="min-h-36 font-mono text-xs"
              value={config.templates[prompt]}
              onChange={(e) =>
                update("templates", {
                  ...config.templates,
                  [prompt]: e.target.value,
                })
              }
            />
          </Field>
          <p className="break-words text-xs text-muted-foreground">
            Variables: repository, pr_number, head_sha, previous_head_sha,
            sender, event_action. Each run records the prompt revision.
          </p>
        </details>
      </>
    </div>
  );
}

export interface PreviewProps {
  initialStep?: number;
  section?: Section;
  scenario?: Scenario;
  reviewState?: ReviewState;
  persistKey?: string;
  initialOverride?: boolean;
}
export function GitHubChatPreview({
  initialStep = 0,
  section,
  scenario = "ready",
  reviewState = "failed",
  persistKey,
  initialOverride = false,
}: PreviewProps) {
  const [draft, setDraft] = useState<Draft>(() => {
    const seed = initialDraft(initialStep, scenario);
    if (initialOverride)
      seed.overrides["acme/platform"] = {
        ...seed.config,
        drafts: true,
        threshold: "4",
      };
    try {
      const raw = persistKey && sessionStorage.getItem(persistKey);
      if (raw) {
        const saved = JSON.parse(raw) as Draft;
        if (
          saved.config?.templates &&
          saved.access?.people &&
          Array.isArray(saved.repositories) &&
          Array.isArray(saved.repositoryInventory) &&
          Number.isInteger(saved.step) &&
          saved.step >= 0 &&
          saved.step < steps.length
        )
          return saved;
      }
    } catch {
      /* Storage is optional for the preview. */
    }
    return seed;
  });
  const [page, setPage] = useState<Section | null>(section ?? null);
  const [savedExit, setSavedExit] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [fixed, setFixed] = useState(false);
  const [method, setMethod] = useState(
    scenario === "existing" || scenario === "reconnect"
      ? "existing"
      : "manifest",
  );
  const [dialog, setDialog] = useState<
    | "provider"
    | "manifest"
    | "task"
    | "github"
    | "installation"
    | "repository-access"
    | "account-auth"
    | null
  >(null);
  const [appId, setAppId] = useState("");
  const [key, setKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [personalReady, setPersonalReady] = useState(
    !["no-account", "identity-expired"].includes(scenario),
  );
  const [scope, setScope] = useState(
    initialOverride ? "acme/platform" : "defaults",
  );
  const [check, setCheck] = useState(reviewState);
  const change = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setNotice("");
  };
  const go = (step: number) => {
    change({ step, available: Math.max(draft.available, step) });
    setError("");
  };
  const save = (exit = false) => {
    if (scenario === "save-error" && !fixed) {
      setError(
        "Couldn’t save your changes. Your draft is still here. Retry when the connection is restored.",
      );
      setFixed(true);
      return;
    }
    try {
      if (persistKey) sessionStorage.setItem(persistKey, JSON.stringify(draft));
      setError("");
      setNotice("Saved in this preview.");
      if (exit) setSavedExit(true);
    } catch {
      setError(
        "This browser could not save the preview. Keep this tab open and try again.",
      );
    }
  };
  const restore = () => {
    try {
      const raw = persistKey && sessionStorage.getItem(persistKey);
      if (raw) setDraft(JSON.parse(raw));
      setSavedExit(false);
      setNotice("Draft restored.");
    } catch {
      setError("Couldn’t restore the preview draft.");
    }
  };
  const config =
    scope === "defaults"
      ? draft.config
      : (draft.overrides[scope] ?? draft.config);
  const override = scope !== "defaults" && Boolean(draft.overrides[scope]);
  const updateConfig = (c: ReviewConfig) =>
    scope === "defaults"
      ? change({ config: c })
      : change({ overrides: { ...draft.overrides, [scope]: c } });
  const blocked =
    !fixed && ["webhook", "tools", "permissions", "runtime"].includes(scenario);
  const bot = draft.name || "acme-reviewer";
  const footer = (
    primary: string,
    action: () => void,
    disabled = false,
    secondary?: ReactNode,
  ) => (
    <SetupWizardFooter onSaveExit={() => save(true)}>
      {draft.step > 0 && (
        <Button variant="ghost" onClick={() => go(draft.step - 1)}>
          Back
        </Button>
      )}
      {secondary}
      <Button disabled={disabled} onClick={action}>
        {primary}
        <ArrowRight className="size-4" />
      </Button>
    </SetupWizardFooter>
  );
  const openTask = () => setDialog("task");
  const linkedContext = (
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Bot className="size-3.5" />
        {draft.agent}
      </span>
      <span>Responsible user: {draft.config.responsible}</span>
      <span>GitHub identity: {bot}[bot]</span>
    </div>
  );
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-5 py-2 text-xs text-muted-foreground">
        <span>
          Design preview · GitHub chat & reviews · provider actions and tasks
          are simulated
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            try {
              if (persistKey) sessionStorage.removeItem(persistKey);
            } catch {
              /* Storage is optional. */
            }
            setDraft(initialDraft(initialStep, scenario));
            setPage(section ?? null);
            setSavedExit(false);
            setFixed(false);
            setError("");
            setNotice("");
            setPersonalReady(
              !["no-account", "identity-expired"].includes(scenario),
            );
            setCheck(reviewState);
            setAppId("");
            setKey("");
            setWebhookSecret("");
            setScope(initialOverride ? "acme/platform" : "defaults");
          }}
        >
          Reset preview
        </Button>
      </div>
      <header className="flex items-center gap-2 border-b border-border px-5 py-4 text-sm">
        <span className="font-semibold">Acme</span>
        <ChevronRight className="size-3 text-muted-foreground" />
        <span>Apps</span>
        <ChevronRight className="size-3 text-muted-foreground" />
        <img
          src="/brands/apps/github.svg"
          className="size-4 dark:invert"
          alt=""
        />
        <span>GitHub</span>
        <ChevronRight className="size-3 text-muted-foreground" />
        <span className="text-muted-foreground">
          {page ? bot : "Connect an agent"}
        </span>
      </header>
      <div className="flex flex-col md:flex-row">
        <aside className="shrink-0 border-b border-border p-5 md:min-h-screen md:w-64 md:border-r md:border-b-0">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
              <Bot className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">{draft.agent}</p>
              <p className="text-xs text-muted-foreground">GitHub connection</p>
            </div>
          </div>
          {page ? (
            <nav aria-label="Connection navigation" className="space-y-1">
              {sections.map((item) => (
                <Button
                  key={item}
                  variant="ghost"
                  className={cn(
                    "w-full justify-start",
                    page === item && "bg-accent",
                  )}
                  aria-current={page === item ? "page" : undefined}
                  onClick={() => {
                    setPage(item);
                    setNotice("");
                  }}
                >
                  {item}
                </Button>
              ))}
            </nav>
          ) : (
            <details className="md:hidden">
              <summary className="cursor-pointer text-sm font-medium">
                Step {draft.step + 1} of {steps.length} · {steps[draft.step]}
              </summary>
              <div className="pt-4">
                <SetupWizardNavigation
                  inline
                  labels={steps}
                  step={draft.step}
                  availableStep={draft.available}
                  onSelect={go}
                />
              </div>
            </details>
          )}
          {!page && (
            <div className="hidden md:block">
              <SetupWizardNavigation
                inline
                labels={steps}
                step={draft.step}
                availableStep={draft.available}
                onSelect={go}
              />
            </div>
          )}
          <p className="mt-8 text-xs text-muted-foreground">
            GitHub conversations run as Paperclip tasks, assigned to this agent.
          </p>
        </aside>
        <main className="min-w-0 flex-1 px-5 py-8 sm:px-8">
          <div
            className={cn(
              "mx-auto space-y-6",
              page === "Reviews" ||
                page === "Conversations" ||
                page === "Activity"
                ? "max-w-4xl"
                : "max-w-2xl",
            )}
          >
            {notice && <Notice tone="success">{notice}</Notice>}
            {error && <Notice tone="error">{error}</Notice>}
            {savedExit ? (
              <>
                <Heading title="Your setup is saved">
                  Return to your GitHub connection whenever you’re ready.
                </Heading>
                <Notice>
                  Step {draft.step + 1}: {steps[draft.step]} · {draft.agent}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Only non-secret preview settings are saved. Unsaved
                    credential fields are never stored.
                  </p>
                </Notice>
                <Button onClick={restore}>
                  Resume setup
                  <ArrowRight className="size-4" />
                </Button>
              </>
            ) : page ? (
              <>
                <Heading title={page}>
                  {page === "Settings"
                    ? "Configure how this agent works with people on GitHub."
                    : page === "Access"
                      ? "Choose who can start work and which permissions apply."
                      : page === "Reviews"
                        ? "Agent assessments, findings, and checks attached to Paperclip tasks."
                        : page === "Conversations"
                          ? "Continue GitHub discussions from their linked Paperclip tasks."
                          : "Connection events and agent actions, with a clear outcome."}
                </Heading>
                {linkedContext}
                {page === "Settings" && (
                  <>
                    <CopyValue value={`@${bot} review this PR`} />
                    <Group title="Allowed repositories">
                      <RepositoryPicker
                        inventory={draft.repositoryInventory}
                        onInventoryChange={(repositoryInventory) =>
                          change({ repositoryInventory })
                        }
                        selected={draft.repositories}
                        onChange={(repositories) => change({ repositories })}
                        bot={bot}
                        scenario={scenario}
                      />
                    </Group>
                    <Select
                      label="Configuration scope"
                      help="Repository overrides start with the connection defaults. Reset an override to inherit future default changes."
                      value={scope}
                      onChange={setScope}
                      options={[
                        ["defaults", "Connection defaults"],
                        ...draft.repositories.map(
                          (r) => [r, r] as [string, string],
                        ),
                      ]}
                    />
                    {scope !== "defaults" && (
                      <Notice>
                        {override
                          ? "This repository has its own review settings."
                          : "This repository inherits connection defaults. Editing a field creates an override."}
                        {override && (
                          <Button
                            variant="link"
                            size="sm"
                            onClick={() => {
                              const next = { ...draft.overrides };
                              delete next[scope];
                              change({ overrides: next });
                            }}
                          >
                            Reset to defaults
                          </Button>
                        )}
                      </Notice>
                    )}
                    <ConfigEditor config={config} onChange={updateConfig} />
                    <Group title="Connection & tools">
                      <p className="text-sm">
                        {bot}[bot] · Installed for {draft.agent}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Read PRs, post comments, submit scored reviews. Uses
                        this bot’s GitHub App credentials.
                      </p>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setPage(null);
                          go(4);
                        }}
                      >
                        Check connection and tools
                      </Button>
                    </Group>
                    <div className="flex justify-end">
                      <Button onClick={() => save()}>Save settings</Button>
                    </div>
                  </>
                )}
                {page === "Access" && (
                  <>
                    <Notice tone="success">
                      <CheckCircle2 className="mr-2 inline size-4" />
                      Your GitHub account <strong>
                        @{draft.accountLogin}
                      </strong>{" "}
                      is linked to <strong>Dotta</strong>.
                    </Notice>
                    <Button
                      variant="link"
                      className="px-0"
                      onClick={() => {
                        setPage(null);
                        change({ step: 5, available: 7, linked: false });
                      }}
                    >
                      Change my linked account
                    </Button>
                    <AccessEditor
                      value={draft.access}
                      onChange={(access) => change({ access })}
                    />
                    <div className="flex justify-end">
                      <Button onClick={() => save()}>
                        Save access settings
                      </Button>
                    </div>
                  </>
                )}
                {page === "Reviews" && (
                  <>
                    <ReviewCard
                      agent={draft.agent}
                      state={check}
                      onTask={openTask}
                      onGitHub={() => setDialog("github")}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setCheck("queued");
                          setNotice(
                            "A new review request was added to task ACM-142 (simulated).",
                          );
                        }}
                      >
                        Request another review
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setDialog("github")}
                      >
                        Preview GitHub output
                        <ExternalLink className="size-4" />
                      </Button>
                    </div>
                    <Group title="Review history">
                      <div className="space-y-3 text-sm">
                        <p>
                          Today, 10:42 · <strong>{reviewLabels[check]}</strong>{" "}
                          · <code>c82f10a</code> ·{" "}
                          <button className="underline" onClick={openTask}>
                            ACM-142 · run 3
                          </button>
                        </p>
                        <p className="text-muted-foreground">
                          Today, 10:14 · 3/5 · a61d082 · 2 findings · run 2
                        </p>
                        <p className="text-muted-foreground">
                          Today, 09:55 · Follow-up answered · rating unchanged
                        </p>
                      </div>
                    </Group>
                  </>
                )}
                {page === "Conversations" && (
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {[
                      [
                        "#284",
                        "Harden webhook signature verification",
                        "ACM-142",
                      ],
                      [
                        "#284 · inline thread",
                        "Explain the retry boundary",
                        "ACM-142",
                      ],
                    ].map(([pr, title, task]) => (
                      <div
                        key={pr}
                        className="flex flex-wrap items-center gap-3 p-4 text-sm"
                      >
                        <GitPullRequest className="size-4 text-muted-foreground" />
                        <button
                          className="underline underline-offset-4"
                          onClick={() => setDialog("github")}
                        >
                          acme/platform {pr}
                        </button>
                        <span className="min-w-0 flex-1">{title}</span>
                        <button
                          className="text-xs underline underline-offset-4"
                          onClick={openTask}
                        >
                          {task} · Open task
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {page === "Activity" && <Activity onTask={openTask} />}
              </>
            ) : (
              <>
                {draft.step === 0 && (
                  <>
                    <Heading title="Connect an agent to GitHub">
                      People can mention your bot to start work or continue a
                      conversation. PR events can ask the same agent to review
                      changes.
                    </Heading>
                    <GitHubSetupPrompt instanceUrl={import.meta.env.VITE_PAPERCLIP_INSTANCE_URL ?? ""} />
                    <Select
                      disabled={draft.connected}
                      label="Paperclip agent"
                      help="This connection stays assigned to this agent. Use another connection for a different agent."
                      value={draft.agent}
                      onChange={(v) => change({ agent: v })}
                      options={[
                        ["Code Reviewer", "Code Reviewer · Engineering"],
                        ["Atlas", "Atlas · Engineering lead"],
                      ]}
                    />
                    <Notice>
                      <Bot className="mr-2 inline size-4" />
                      Messages become tasks assigned to{" "}
                      <strong>{draft.agent}</strong>. Linked people use their
                      Paperclip permissions.
                    </Notice>
                    <GitHubAgentTrustWarning agent={{ name: draft.agent, permissions: { trustPreset: draft.agent === "Code Reviewer" ? "low_trust_review" : "standard" } }} />
                    {footer("Continue", () => go(1))}
                  </>
                )}
                {draft.step === 1 && (
                  <>
                    <Heading
                      title={
                        scenario === "reconnect"
                          ? "Reconnect your GitHub App"
                          : "Connect your GitHub App"
                      }
                    >
                      Your agent will reply using this App’s bot identity.
                    </Heading>
                    {scenario === "private-url" ? (
                      <Notice tone="warning">
                        <strong>
                          GitHub needs a publicly reachable HTTPS address.
                        </strong>
                        <p className="mt-2">
                          This instance uses a private Tailscale address. Enable
                          public ingress before verifying delivery. Paperclip
                          Cloud provides HTTPS for hosted instances.
                        </p>
                        <a
                          className="mt-2 inline-block underline"
                          href="https://paperclip.ing/docs"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Read the self-hosting guide
                          <ExternalLink className="ml-1 inline size-3" />
                        </a>
                      </Notice>
                    ) : (
                      <Notice>
                        GitHub will send events to{" "}
                        <strong>acme.staging.paperclip.app</strong>. Signed
                        delivery is checked after installation.
                      </Notice>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={draft.connected}
                        variant={method === "manifest" ? "secondary" : "ghost"}
                        onClick={() => setMethod("manifest")}
                      >
                        Create a new App
                      </Button>
                      <Button
                        disabled={draft.connected}
                        variant={method === "existing" ? "secondary" : "ghost"}
                        onClick={() => setMethod("existing")}
                      >
                        Use an existing App
                      </Button>
                    </div>
                    {method === "manifest" ? (
                      <>
                        <Field
                          label="App name"
                          help="GitHub requires a globally unique App name. This becomes the bot people mention."
                        >
                          <Input
                            disabled={draft.connected}
                            id="App name"
                            value={draft.name}
                            onChange={(e) => change({ name: e.target.value })}
                          />
                        </Field>
                        <Select
                          disabled={draft.connected}
                          label="App owner"
                          help="You must be able to create an App in this GitHub account."
                          value={draft.owner}
                          onChange={(v) => change({ owner: v })}
                          options={[
                            ["organization", "Organization"],
                            ["personal", "My personal account"],
                          ]}
                        />
                        {draft.owner === "organization" && (
                          <Field
                            label="GitHub organization"
                            help="The organization’s GitHub handle, without a URL."
                          >
                            <Input
                              disabled={draft.connected}
                              id="GitHub organization"
                              value={draft.organization}
                              onChange={(e) =>
                                change({ organization: e.target.value })
                              }
                            />
                          </Field>
                        )}
                        <p className="text-sm text-muted-foreground">
                          GitHub creates the App and returns its credentials
                          directly to Paperclip. Then you choose which
                          repositories to install it on.
                        </p>
                        <Button
                          variant="link"
                          className="px-0"
                          onClick={() => setDialog("manifest")}
                        >
                          View GitHub App manifest
                        </Button>
                        {scenario === "expired" && !fixed && (
                          <Notice tone="warning">
                            The registration link expired. Start again to
                            generate a new link; your choices are preserved.
                          </Notice>
                        )}
                        {footer(
                          draft.connected
                            ? "Continue to installation"
                            : "Create GitHub App",
                          () => {
                            if (draft.connected) {
                              go(2);
                              return;
                            }
                            setFixed(true);
                            setDialog("provider");
                          },
                          !draft.name.trim() ||
                            (draft.owner === "organization" &&
                              !draft.organization.trim()),
                        )}
                      </>
                    ) : (
                      <>
                        <Field
                          label="GitHub App ID"
                          help="Open GitHub App settings, select your App, and copy App ID from General. This is not the Client ID."
                        >
                          <p className="text-xs text-muted-foreground">
                            GitHub → Settings → Developer settings → GitHub Apps
                            → your App → General.
                          </p>
                          <Input
                            id="GitHub App ID"
                            placeholder="123456"
                            value={appId}
                            onChange={(e) => setAppId(e.target.value)}
                          />
                        </Field>
                        <Field
                          label="Private key (PEM)"
                          help="In the same App’s General settings, choose Generate a private key. Paste the downloaded PEM contents."
                        >
                          <Input
                            id="Private key (PEM)"
                            type="password"
                            placeholder="Paste your App’s private key"
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                          />
                        </Field>
                        <Field
                          label="Webhook secret"
                          help="Use the webhook secret configured on this App. Paperclip verifies the original bytes of every delivery with it."
                        >
                          <Input
                            id="Webhook secret"
                            type="password"
                            value={webhookSecret}
                            onChange={(e) => setWebhookSecret(e.target.value)}
                          />
                        </Field>
                        <details className="space-y-3 text-sm">
                          <summary className="cursor-pointer">
                            Configure the existing App on GitHub
                          </summary>
                          <CopyValue value="https://acme.staging.paperclip.app/api/chat-webhooks/example-public-id/github" />
                          <p>
                            Set this webhook URL on your App. Enable Contents
                            read, Issues write, Pull requests write, and Checks
                            write. Subscribe to issue comments, pull request
                            review comments, and pull requests.
                          </p>
                        </details>
                        <p className="text-xs text-muted-foreground">
                          Use dummy values in this preview. Credentials are not
                          sent or saved.
                        </p>
                        {scenario === "reconnect" && (
                          <Notice>
                            Saved App: {bot}. Leave credential fields blank to
                            reuse its credentials. Reconnecting preserves
                            repository choices.
                          </Notice>
                        )}
                        {footer(
                          "Verify App credentials",
                          () => {
                            change({ connected: true });
                            go(2);
                          },
                          !(
                            scenario === "reconnect" &&
                            !appId &&
                            !key &&
                            !webhookSecret
                          ) &&
                            (!appId || !key || !webhookSecret),
                        )}
                      </>
                    )}
                  </>
                )}
                {draft.step === 2 && (
                  <>
                    <Heading title="Install your GitHub App">
                      Choose the GitHub account and repositories this App can
                      access on GitHub.
                    </Heading>
                    <Notice tone={draft.installed ? "success" : "muted"}>
                      {draft.installed ? (
                        <>
                          <strong>{bot} is installed on acme.</strong>
                          <p className="mt-2">
                            Next, choose which of its available repositories
                            this agent should respond in.
                          </p>
                        </>
                      ) : (
                        <>
                          <strong>{bot} is ready to install.</strong>
                          <p className="mt-2">
                            GitHub controls which repositories the App can
                            access. You’ll choose the agent’s allowed
                            repositories in the next step.
                          </p>
                        </>
                      )}
                    </Notice>
                    <p className="text-sm text-muted-foreground">
                      You may need an organization owner to approve the
                      installation.
                    </p>
                    {footer(
                      draft.installed
                        ? "Choose repositories"
                        : "Install on GitHub",
                      () =>
                        draft.installed ? go(3) : setDialog("installation"),
                    )}
                  </>
                )}
                {draft.step === 3 && (
                  <>
                    <Heading title="Choose allowed repositories">
                      Choose where {draft.agent} can respond and review PRs.
                    </Heading>
                    <RepositoryPicker
                      inventory={draft.repositoryInventory}
                      onInventoryChange={(repositoryInventory) =>
                        change({ repositoryInventory })
                      }
                      selected={draft.repositories}
                      onChange={(repositories) => change({ repositories })}
                      bot={bot}
                      scenario={scenario}
                    />
                    {footer(
                      "Check connection and tools",
                      () => go(4),
                      !draft.repositories.length,
                    )}
                  </>
                )}
                {draft.step === 4 && (
                  <>
                    <Heading title="Verify connection and agent tools">
                      Check that GitHub can reach Paperclip and that your agent
                      can use this bot’s connection.
                    </Heading>
                    <div className="divide-y divide-border rounded-lg border border-border px-4">
                      {[
                        "GitHub App identity",
                        "Signed webhook delivery",
                        "Selected repository access",
                        "Agent GitHub tools",
                        "Agent execution environment",
                      ].map((label, i) => {
                        const bad =
                          blocked &&
                          ((scenario === "webhook" && i === 1) ||
                            (scenario === "permissions" && i === 2) ||
                            (scenario === "tools" && i === 3) ||
                            (scenario === "runtime" && i === 4));
                        return (
                          <div
                            key={label}
                            className="flex items-start gap-3 py-4"
                          >
                            {bad ? (
                              <XCircle className="size-4 shrink-0 text-destructive" />
                            ) : (
                              <CheckCircle2 className="size-4 shrink-0 text-(--status-task-done)" />
                            )}
                            <div>
                              <p className="text-sm font-medium">{label}</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {bad
                                  ? scenario === "tools"
                                    ? `${draft.agent} has no permission to submit reviews through this connection.`
                                    : scenario === "permissions"
                                      ? "Checks: write is missing. Update the App permissions and approve the installation change."
                                      : scenario === "runtime"
                                        ? "This agent’s environment cannot run the required tools. Choose a supported environment in agent settings."
                                        : "No signed event has reached this address. Check GitHub’s Recent deliveries and your public ingress."
                                  : [
                                      bot + "[bot]",
                                      "Signed ping received at this instance’s current address",
                                      `${draft.repositories.length} ${draft.repositories.length === 1 ? "repository" : "repositories"} · Contents read · Pull requests and Checks write`,
                                      `Available to ${draft.agent} · same GitHub App identity`,
                                      "Ready to run Paperclip tasks",
                                    ][i]}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {blocked && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setFixed(true);
                          change({ verified: true });
                        }}
                      >
                        Simulate repair and recheck
                      </Button>
                    )}
                    <details className="space-y-3 text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        Connection details & troubleshooting
                      </summary>
                      <CopyValue value="https://acme.staging.paperclip.app/api/chat-webhooks/example-public-id/github" />
                      <p className="text-xs text-muted-foreground">
                        Webhook verification does not prove a complete agent
                        review. Try a real PR after setup.
                      </p>
                    </details>
                    {footer(
                      "Connect your account",
                      () => {
                        change({ verified: true });
                        go(5);
                      },
                      blocked,
                    )}
                  </>
                )}
                {draft.step === 5 && (
                  <>
                    <Heading title="Connect your GitHub account">
                      Use a personal GitHub connection to identify your messages
                      in Paperclip.
                    </Heading>
                    {draft.linked ? (
                      <Notice tone="success">
                        <CheckCircle2 className="mr-2 inline size-4" />
                        <strong>
                          @{draft.accountLogin} is linked to Dotta.
                        </strong>
                        <p className="mt-2">
                          Your mentions use your current Paperclip permissions.
                        </p>
                      </Notice>
                    ) : personalReady ? (
                      <>
                        <Select
                          label="Your GitHub connection"
                          help="Only your own verified personal GitHub connections are available. Shared organization and dedicated agent connections cannot identify you."
                          value={draft.accountLogin}
                          onChange={(accountLogin) => change({ accountLogin })}
                          options={[
                            ["dotta", "GitHub · @dotta · Personal"],
                            [
                              "dotta-work",
                              "Work GitHub · @dotta-work · Personal",
                            ],
                          ]}
                        />
                        <Notice>
                          <strong>Link @{draft.accountLogin} to Dotta</strong>
                          <p className="mt-2">
                            This account is verified by your existing GitHub
                            connection. Confirm it’s the account you’ll use to
                            talk to the bot.
                          </p>
                        </Notice>
                        <Button
                          variant="link"
                          className="px-0"
                          onClick={() => setDialog("account-auth")}
                        >
                          Connect another GitHub account
                          <ExternalLink className="size-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Notice tone="warning">
                          <strong>
                            {scenario === "identity-expired"
                              ? "Your personal GitHub connection needs to be reconnected."
                              : "You don’t have a personal GitHub connection yet."}
                          </strong>
                          <p className="mt-2">
                            Sign in through the usual GitHub connection flow,
                            then return here to confirm your account.
                          </p>
                        </Notice>
                      </>
                    )}
                    <p className="text-sm text-muted-foreground">
                      This identifies you as the person requesting work.{" "}
                      {draft.agent} continues to read and publish using {bot}
                      [bot], with this bot’s allowed repositories and
                      permissions.
                    </p>
                    {footer(
                      draft.linked
                        ? "Configure behavior"
                        : personalReady
                          ? "Use this GitHub account"
                          : scenario === "identity-expired"
                            ? "Reconnect GitHub"
                            : "Connect GitHub",
                      () => {
                        if (draft.linked) go(6);
                        else if (personalReady) change({ linked: true });
                        else setDialog("account-auth");
                      },
                    )}
                  </>
                )}
                {draft.step === 6 && (
                  <>
                    <Heading title="Configure how your agent responds">
                      Start with linked members’ PRs and mentions. You can
                      customize each repository later.
                    </Heading>
                    <ConfigEditor
                      config={draft.config}
                      onChange={(c) => change({ config: c })}
                    />
                    <details className="space-y-4 rounded-lg border border-border p-4">
                      <summary className="cursor-pointer text-sm font-medium">
                        Who can start work
                      </summary>
                      <AccessEditor
                        value={draft.access}
                        onChange={(access) => change({ access })}
                      />
                    </details>
                    {footer("Continue to try it", () => go(7))}
                  </>
                )}
                {draft.step === 7 && (
                  <>
                    <Heading title={`Try ${draft.agent} on a PR`}>
                      Your GitHub connection is ready. A first review is
                      optional.
                    </Heading>
                    <ol className="list-decimal space-y-3 pl-5 text-sm">
                      <li>
                        Open a PR in <strong>{draft.repositories[0]}</strong>.
                      </li>
                      <li>
                        Post this message:
                        <div className="mt-2">
                          <CopyValue value={`@${bot} review this PR`} />
                        </div>
                      </li>
                      <li>
                        Continue the conversation on GitHub or open its linked
                        task in Paperclip.
                      </li>
                    </ol>
                    {draft.testSent ? (
                      <Notice tone="success">
                        <CheckCircle2 className="mr-2 inline size-4" />
                        Your message was received.{" "}
                        <button className="underline" onClick={openTask}>
                          ACM-142
                        </button>{" "}
                        is assigned to {draft.agent}, with Dotta responsible.
                      </Notice>
                    ) : (
                      <Notice>
                        Waiting for a message from your linked account. You can
                        finish setup without sending one.
                      </Notice>
                    )}
                    <Button
                      variant="outline"
                      onClick={() => change({ testSent: true })}
                    >
                      Simulate my test message
                    </Button>
                    {footer(
                      "Finish setup",
                      () => setPage("Settings"),
                      false,
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setNotice(
                            "Setup finished. Message delivery has not been verified by this manual confirmation.",
                          );
                          setPage("Settings");
                        }}
                      >
                        I’ve sent the test message
                      </Button>,
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </main>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="max-h-screen overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {dialog === "provider"
                ? "Create GitHub App · simulated handoff"
                : dialog === "account-auth"
                  ? "Connect personal GitHub · simulated sign-in"
                  : dialog === "installation"
                    ? "Install GitHub App · simulated handoff"
                    : dialog === "manifest"
                      ? "GitHub App manifest"
                      : dialog === "task"
                        ? "ACM-142 · Harden webhook signature verification"
                        : "GitHub PR #284 · output preview"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "task"
                ? "Example Paperclip task, messages, and governed agent tools. No live run."
                : "Storybook fixture. No GitHub account, credentials, or external resources are changed."}
            </DialogDescription>
          </DialogHeader>
          {dialog === "provider" && (
            <div className="space-y-4">
              <p className="text-sm">
                On GitHub, confirm <strong>{bot}</strong> under{" "}
                <strong>
                  {draft.owner === "organization"
                    ? draft.organization
                    : "your account"}
                </strong>
                . GitHub returns the new App credentials directly to Paperclip.
              </p>
              <Button
                onClick={() => {
                  change({ connected: true });
                  setDialog(null);
                  go(2);
                }}
              >
                Simulate App created and return
              </Button>
            </div>
          )}
          {dialog === "account-auth" && (
            <div className="space-y-4">
              <p className="text-sm">
                Continue through Paperclip’s existing personal GitHub sign-in.
                On return, Paperclip verifies your GitHub account before you
                confirm the link.
              </p>
              <Button
                onClick={() => {
                  setPersonalReady(true);
                  change({ linked: false, accountLogin: "dotta" });
                  setDialog(null);
                }}
              >
                Simulate GitHub sign-in completed
              </Button>
            </div>
          )}
          {dialog === "installation" && (
            <div className="space-y-4">
              <p className="text-sm">
                GitHub asks which repositories this App can access. This example
                installation includes platform, design-system, and docs.
              </p>
              <Button
                onClick={() => {
                  change({ installed: true });
                  setDialog(null);
                }}
              >
                Simulate installation completed
              </Button>
            </div>
          )}
          {dialog === "manifest" && (
            <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
              {JSON.stringify(
                {
                  name: bot,
                  public: false,
                  url: "https://acme.staging.paperclip.app",
                  hook_attributes: {
                    url: "https://acme.staging.paperclip.app/api/chat-webhooks/example-public-id/github",
                    active: true,
                  },
                  redirect_url:
                    "https://acme.staging.paperclip.app/api/chat-github/manifest/callback",
                  default_permissions: {
                    contents: "read",
                    issues: "write",
                    pull_requests: "write",
                    checks: "write",
                  },
                  default_events: [
                    "issue_comment",
                    "pull_request_review_comment",
                    "pull_request",
                  ],
                },
                null,
                2,
              )}
            </pre>
          )}
          {dialog === "task" && (
            <div className="space-y-5">
              {linkedContext}
              <Notice>
                Source: acme/platform #284 · Assigned to {draft.agent} ·
                Responsible user: Dotta
              </Notice>
              <div className="space-y-4 text-sm">
                <p>
                  <strong>GitHub · Dotta</strong>
                  <br />@{bot} review this PR
                </p>
                <p>
                  <strong>{draft.agent}</strong>
                  <br />
                  I’ll inspect the current diff and verify the signature
                  handling.
                </p>
                <div className="space-y-2 rounded-md bg-muted p-3 font-mono text-xs">
                  <p>github.read_pull_request · #284 · c82f10a</p>
                  <p>github.read_files · server/webhooks.ts</p>
                  <p>
                    {check === "passed"
                      ? "github.submit_review · score 5/5 · no remaining findings"
                      : check === "failed"
                        ? "github.submit_review · score 3/5 · 2 findings"
                        : "No complete review result published for this head"}
                  </p>
                  <p>Paperclip Review · {reviewLabels[check]} · requires 5/5</p>
                </div>
                <p>
                  <strong>GitHub · Dotta</strong>
                  <br />
                  I’ve pushed a fix. Please check the retry path too.
                </p>
                <p>
                  <strong>PR updated · automatic event</strong>
                  <br />
                  Continue this task with the new head. Event prompt revision 2.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Tools use {bot}[bot] through this connection. External input
                cannot select another repository or credential.
              </p>
            </div>
          )}
          {dialog === "github" && (
            <div className="space-y-5">
              <ReviewCard agent={draft.agent} state={check} onTask={openTask} />
              <Group title="Review summary">
                <p className="text-sm">
                  {check === "passed"
                    ? "The signature comparison and idempotency checks are correct. Prior findings have been addressed in the current head."
                    : check === "failed"
                      ? "Fix the signature comparison and retry deduplication before merging. The current review found two actionable issues."
                      : check === "incomplete"
                        ? "The agent could not read the required repository context. No complete assessment is available for this head."
                        : check === "manual"
                          ? "An authorized member must request a review before this head can be assessed."
                          : "The current head is awaiting an assessment. The previous review remains in history and cannot pass this commit."}
                </p>
                <p className="text-xs text-muted-foreground">
                  {check === "passed" || check === "failed"
                    ? "Reviewed commit c82f10a · 11 files · review 3"
                    : "PR head c82f10a · no complete assessment"}{" "}
                  · by {bot}[bot]
                </p>
              </Group>
              {check === "failed" && (
                <Group title="Inline finding">
                  <p className="text-xs font-mono">
                    server/webhooks.ts · line 84 · P1
                  </p>
                  <p className="text-sm">
                    Verify the signature against the original request bytes.
                    Re-serializing JSON can reject a legitimate delivery.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Prior thread retained · 2 replies · New findings appear as
                    additional comments.
                  </p>
                </Group>
              )}
              <Notice>
                Formal approval is a separate action. A passing score does not
                approve this PR.
              </Notice>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function ReviewCard({
  state,
  onTask,
  onGitHub,
  agent,
}: {
  agent: string;
  state: ReviewState;
  onTask: () => void;
  onGitHub?: () => void;
}) {
  const pending = state === "running" || state === "queued";
  return (
    <div className="space-y-4 rounded-lg border border-border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            acme/platform · PR #284
          </p>
          <h2 className="mt-1 text-base font-semibold">
            Harden webhook signature verification
          </h2>
        </div>
        <GitPullRequest className="size-5 text-muted-foreground" />
      </div>
      <Notice
        tone={
          state === "passed"
            ? "success"
            : pending
              ? "muted"
              : state === "failed"
                ? "error"
                : "warning"
        }
      >
        <div className="flex items-center gap-2">
          {state === "passed" ? (
            <Check className="size-4" />
          ) : pending ? (
            <Loader2
              className={cn("size-4", state === "running" && "animate-spin")}
            />
          ) : (
            <XCircle className="size-4" />
          )}
          <strong>Paperclip Review · {reviewLabels[state]}</strong>
        </div>
        <p className="mt-2 text-xs">
          {state === "passed"
            ? "The current head meets the required 5/5 rating."
            : state === "failed"
              ? "Requires 5/5. Address two findings and request another review."
              : state === "incomplete"
                ? "Repository context was unavailable. This review cannot produce a passing score. Repair access and retry."
                : state === "manual"
                  ? "This author is outside the automatic review policy. A linked member can mention the bot to request a review."
                  : "This assessment applies only to c82f10a. An earlier score cannot pass this head."}
        </p>
      </Notice>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <button className="underline" onClick={onTask}>
          ACM-142 · Open Paperclip task
        </button>
        {onGitHub && (
          <button className="underline" onClick={onGitHub}>
            Open GitHub preview
          </button>
        )}
        <span className="text-muted-foreground">
          Responsible: Dotta · Agent: {agent}
        </span>
      </div>
    </div>
  );
}
function Activity({ onTask }: { onTask: () => void }) {
  const [older, setOlder] = useState(false);
  const items = older
    ? [
        ["09:41:02", "App installed", "acme · 3 repositories"],
        [
          "09:40:18",
          "Signed webhook verified",
          "Current public address confirmed",
        ],
      ]
    : [
        ["10:42:08", "Review published", "3/5 · check failed · c82f10a"],
        [
          "10:41:52",
          "Agent invoked GitHub tools",
          "Bot connection · repository scope verified",
        ],
        ["10:41:10", "Task continued", "PR updated · prompt revision 2"],
        ["10:40:58", "Duplicate webhook ignored", "Existing delivery retained"],
      ];
  return (
    <>
      <div className="divide-y divide-border rounded-lg border border-border">
        {items.map(([time, title, description]) => (
          <div key={time} className="flex flex-wrap gap-3 p-4 text-sm">
            <time className="w-20 shrink-0 text-xs text-muted-foreground">
              {time}
            </time>
            <div className="flex-1">
              <p className="font-medium">{title}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {description}
              </p>
            </div>
            {!older && (
              <button className="text-xs underline" onClick={onTask}>
                ACM-142
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-between">
        <span className="text-xs text-muted-foreground">
          September 19, 2026 · UTC
        </span>
        <Button variant="outline" size="sm" onClick={() => setOlder(!older)}>
          {older ? "Newest activity" : "Older activity"}
        </Button>
      </div>
    </>
  );
}

function RepositoryPicker({
  inventory,
  onInventoryChange,
  selected,
  onChange,
  bot,
  scenario,
}: {
  inventory: string[];
  onInventoryChange: (repos: string[]) => void;
  selected: string[];
  onChange: (repos: string[]) => void;
  bot: string;
  scenario: Scenario;
}) {
  const available = inventory;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(
    scenario === "repositories-error",
  );
  const [refreshed, setRefreshed] = useState(false);
  const [manage, setManage] = useState(false);
  const [addedOnGitHub, setAddedOnGitHub] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    setRefreshError(false);
    window.setTimeout(() => {
      const next = addedOnGitHub
        ? [...new Set([...repositories, ...inventory, "acme/mobile"])]
        : inventory.length
          ? inventory
          : scenario === "repositories-error"
            ? repositories
            : [];
      onInventoryChange(next);
      onChange(selected.filter((repo) => next.includes(repo)));
      setRefreshed(true);
      setRefreshing(false);
    }, 350);
  };
  return (
    <div className="space-y-4">
      <div className="space-y-3 border-y border-border py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{bot} · acme installation</p>
            <p className="text-xs text-muted-foreground">
              {refreshError
                ? "Repository access could not be loaded"
                : `${available.length} repositories available from GitHub`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Refresh access"
              title="Refresh access"
              disabled={refreshing}
              onClick={refresh}
            >
              {refreshing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setManage(true)}>
              Configure access on GitHub
              <ExternalLink className="size-4" />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          This list comes from the bot App’s installation on GitHub. Enable
          repositories below to let {bot} respond in them.
        </p>
        {refreshError ? (
          <Notice tone="error">
            Couldn’t refresh repository access. Check the installation on
            GitHub, then retry.
            <Button variant="link" onClick={refresh}>
              Retry refresh
            </Button>
          </Notice>
        ) : !available.length ? (
          <Notice>
            No repositories available. Configure access on GitHub, then refresh
            this list.
          </Notice>
        ) : (
          <div
            className="max-h-(--sz-github-repository-list) divide-y divide-border overflow-y-auto"
            aria-label="Available GitHub repositories"
          >
            {available.map((repo) => (
              <Toggle
                key={repo}
                label={repo}
                value={selected.includes(repo)}
                onChange={(enabled) =>
                  onChange(
                    enabled
                      ? [...selected, repo]
                      : selected.filter((value) => value !== repo),
                  )
                }
              />
            ))}
          </div>
        )}
        {refreshed && (
          <p role="status" className="text-xs text-muted-foreground">
            Repository access refreshed. Newly available repositories stay
            disabled until you enable them here.
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Missing a repository?{" "}
        <button
          className="text-foreground underline"
          onClick={() => setManage(true)}
        >
          Configure access on GitHub
        </button>
        , then refresh this list. Enabling a repository here does not expand the
        App’s access on GitHub.
      </p>
      <Dialog open={manage} onOpenChange={setManage}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Configure installation · simulated GitHub visit
            </DialogTitle>
            <DialogDescription>
              In the real flow, this opens the bot App’s installation settings
              on GitHub. Organization owners control repository access there.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            For this preview, add acme/mobile to the installation. Return to
            Paperclip and refresh to see it; it won’t be enabled automatically.
          </p>
          <Button
            onClick={() => {
              setAddedOnGitHub(true);
              setManage(false);
            }}
          >
            Simulate adding a repository on GitHub
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
