import { useEffect, useState, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MotionConfig, motion } from "motion/react";
import type {
  AdapterEnvironmentTestResult,
  AgentRole,
  ClaudeOAuthTokenStatusResponse,
  Environment,
  InstanceSettings,
} from "@paperclipai/shared";
import { AGENT_ROLES, AGENT_ROLE_LABELS, ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { Label } from "./ui/label";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { ApiError } from "../api/client";
import { companiesApi } from "../api/companies";
import { useCompanyListQuery } from "../api/companies-query";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import {
  resolveAdapterTestEnvironmentId,
  resolveLocalDefaultEnvironmentId,
  resolveManagedSandboxEnvironmentId,
} from "../lib/adapter-test-environment";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  extractModelName,
  extractProviderIdWithFallback
} from "../lib/model-utils";
import { getUIAdapter } from "../adapters";
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { useDisabledAdaptersSync, useAdapterRegistryLoaded } from "../adapters/use-disabled-adapters";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { buildFixedClaudeOAuthBinding } from "./environment-variables-editor/model";
import { defaultCreateValues } from "./agent-config-defaults";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import { restoreOnboardingState } from "../lib/onboarding-state";
import { composeCeoInstructions } from "../lib/ceo-instructions";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId,
  selectReusableOnboardingProject,
} from "../lib/onboarding-launch";
import { buildNewAgentRuntimeConfig } from "../lib/new-agent-runtime-config";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_KIMI_LOCAL_MODEL } from "@paperclipai/adapter-kimi-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL, isValidOpenCodeModelId } from "@paperclipai/adapter-opencode-local";
import {
  canGoBackFromOnboardingStep,
  canJumpToOnboardingStep,
  companyPrefixFromOnboardingPath,
  resolveRouteOnboardingOptions,
} from "../lib/onboarding-route";
import { useCompanyMission } from "../hooks/useCompanyMission";
import { useCloudInstance } from "../hooks/useCloudInstance";
import {
  isExistingCompanyMissionUnresolved,
  planMissionPersistence,
} from "../lib/onboarding-mission";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { FrontDoor } from "./FrontDoor";
import { PillGuy } from "./onboarding/PillGuy";
import { AGENT_ARC_WIZARD_STEPS, Stepper, agentArcStepFor } from "./onboarding/Stepper";
import { AgentPreview } from "./onboarding/AgentPreview";
import { FooterNav } from "./onboarding/FooterNav";
import { OnboardingHeading } from "./onboarding/OnboardingPrimitives";
import { DEFAULT_AGENT_ROLE } from "../lib/onboarding-agent-role";
import { capsuleHeroMotion } from "./onboarding/onboarding-motion";
import { Badge } from "@/components/ui/badge";
import {
  Building2,
  Bot,
  ListTodo,
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Check,
  Loader2,
  ChevronDown,
  X
} from "lucide-react";

type Step = 0 | 1 | 2 | 3 | 4 | 5;
// Plugin/external adapters use arbitrary type ids, so this mirrors the master
// wizard's registry-driven approach rather than a fixed union.
type AdapterType = string;

const MISSION_PROMPT_CHIPS = [
  "Build a SaaS product",
  "Scale a content business",
  "Launch a marketplace"
];

function buildMissionFromQuestionnaire(q1: string, q2: string, q3: string, q4: string): string {
  const parts: string[] = [];
  if (q1.trim()) parts.push(q1.trim());
  if (q2.trim()) parts.push(`We serve ${q2.trim().toLowerCase()}.`);
  if (q3.trim()) parts.push(`Our biggest challenge is ${q3.trim().toLowerCase()}.`);
  if (q4.trim()) parts.push(`Success looks like ${q4.trim().toLowerCase()}.`);
  return parts.join(" ");
}

/**
 * True when an adapter-test result blocks a hire. A `fail` status always
 * blocks. A `warn` or a `pass` status blocks too when a check reports
 * `ADAPTER_AUTH_MISSING_CHECK_CODE`. That check means the agent has no
 * working authentication, so it cannot run. A `warn` with no such check
 * still lets the hire proceed. The wizard widened the gate for missing
 * authentication only, not for every other warning.
 */
function blocksAgentCreate(result: AdapterEnvironmentTestResult): boolean {
  if (result.status === "fail") return true;
  return result.checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE);
}

/** True when `value` is a plain object, so callers can spread it as env config. */
function isEnvRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ANTHROPIC_API_KEY_ENV_KEY = "ANTHROPIC_API_KEY";

/**
 * True when the adapter configuration carries a non-empty ANTHROPIC_API_KEY.
 * The server rejects that key together with the fixed Claude login binding
 * (see `assertClaudeOAuthBindingInvariant` in `server/src/services/secrets.ts`).
 * This checks the built configuration first, so onboarding never sends a
 * hire the server would reject.
 */
function adapterConfigHasAnthropicApiKey(config: Record<string, unknown>): boolean {
  if (!isEnvRecord(config.env)) return false;
  const binding = config.env[ANTHROPIC_API_KEY_ENV_KEY];
  if (typeof binding === "string") return binding.trim().length > 0;
  if (!isEnvRecord(binding)) return false;
  if (binding.type === "plain") {
    return typeof binding.value === "string" && binding.value.trim().length > 0;
  }
  return binding.type === "secret_ref" || binding.type === "user_secret_ref";
}

// Exported so tests write/read the exact key the component uses, instead of
// duplicating the literal and silently drifting from it if it's ever renamed.
export const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";
const DEFAULT_TASK_TITLE = "Paperclip onboarding";
const DEFAULT_TASK_DESCRIPTION = `You are the Paperclip agent. This is your first task. Your job here is to
understand what the user wants and turn it into a concrete plan — not to
start building yet.

A greeting has already been posted to the user on your behalf, so don't
re-introduce yourself — go straight to the questions.

This is a user-facing chat. Everything you post here is read by the user, so
keep your messages terse and written for them. Only surface things meant for
the user: the questions, the plan, the team, next-step options, and short
status ("Got your answers — here's the plan."). Never narrate how you work.
Don't post your internal steps or thinking into the chat — no "let me probe
the schema", "schema learned", "building the questions payload", "orienting
myself with the API", or similar play-by-play of your API/tool calls. Do that
work silently and post only the result.

Work in this order:

1. Ask a few focused, clarifying questions. Use an ask_user_questions interaction to settle on one concrete goal to tackle first— scope, priorities, constraints, and what "done" looks like. Don't guess; ask.

2. Propose one plan. Once you understand the goal, write a short approach plan to the \`plan\` document. At the bottom, list the agents you'd hire (with their roles) and any follow-up tasks you'd create. Then present the whole thing as a SINGLE request_checkbox_confirmation that targets the \`plan\` document, with each proposed hire and follow-up task as its own checkable option, checked by default. Give each option a stable id you can act on later. Do NOT use suggest_tasks or a separate request_confirmation — one checkbox card is the plan and its approval. In the card's message keep the summary to a line or two and point the user to the full write-up in the plan on the right sidebar (it opens to the Plan there automatically) — don't paste the whole plan into the card, and never say the write-up is "above" or "in the plan doc above"; it lives in the right sidebar.

3. Wait for approval. Don't hire anyone or create work until the user approves the plan. They can uncheck anything they don't want before approving, and unchecking simply drops it. If they ask for changes, revise the plan document and re-confirm.

4. On approval, execute only what they kept. Create exactly the checked options — hire the checked agents and create + delegate the checked follow-up tasks, each in its own task. Skip anything the user unchecked.

Propose, don't decide. Keep it conversational.`;
/**
 * The onboarding draft in `localStorage`, via a browser that is allowed to say
 * no.
 *
 * Storage access throws outright where a browser denies it — Safari's private
 * mode, a blocked third-party context — and every call site here sits in a
 * render, an effect, or a close handler, so an escaping exception takes down
 * something the customer was using. Losing the ability to resume onboarding is
 * a far smaller failure than the wizard tearing down mid-answer, or refusing
 * to close.
 *
 * Routed through one object on purpose. Guarding these one at a time is how
 * three of the four call sites ended up unguarded while the fourth looked
 * fixed: the read, the stale-blob cleanup, the persist effect, and `reset()`
 * all have the same failure and want the same answer.
 */
const onboardingDraftStorage = {
  read(): string | null {
    try {
      return localStorage.getItem(ONBOARDING_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  write(value: string): void {
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, value);
    } catch {
      // Storage unavailable: the draft is simply not resumable this session.
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    } catch {
      // Nothing to do. A draft that cannot be cleared is re-rejected on the
      // next load by the same ownership check that rejected it here.
    }
  },
};

const INCOMPLETE_ONBOARDING_STATE_MESSAGE =
  "Onboarding state is incomplete. Please restart onboarding and try again.";

/**
 * Thin gate in front of {@link OnboardingWizardInner}. The inner component's
 * ~20 `useState(saved?.x ?? default)` initializers only read `saved` on their
 * very first render, so it must never mount before the restored draft is
 * final, otherwise every field locks to its default and the draft is lost
 * for good. restoreOnboardingState requires the SETTLED companies list (see
 * its JSDoc), so when a saved blob exists we wait for `companiesLoading` to
 * clear before computing `saved` and mounting the inner component at all.
 */
export function OnboardingWizard() {
  // Deliberately does not call `useCompany()`. The list it exposes is the
  // shared cache, which is what this gate must not trust - see below.

  // Parsed once (not re-parsed by the cleanup effect below) so the restored
  // value and the "should we wipe the blob" decision always agree.
  const rawBlob = useMemo(() => {
    const raw = onboardingDraftStorage.read();
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null; // malformed: treated as stale below
    }
  }, []);

  // Whether this account owns the company the draft names is an authorization
  // question, and the answer has to be about the account asking now.
  //
  // The shared company cache could not answer it at all: one entry for every
  // account, served for thirty seconds after a switch with no loading state and
  // no error, so a check that trusted "not loading, no error" handed one
  // account's draft to the next. The entry is keyed by account now, and that
  // trap is gone with it.
  //
  // What survives is smaller and still worth a request. A cached list is the
  // right account's but can be thirty seconds old, so a company created moments
  // ago in another tab is missing from it — and missing reads as "you do not own
  // this", which deletes the draft rather than withholding it. So this still
  // asks for a list fetched for this mount.
  const companiesQuery = useCompanyListQuery({
    staleTime: 0,
    // Only a *parseable* saved draft poses the question. Without one there is
    // nothing to authorize, and this must not add a request to every wizard
    // mount - nor make the cleanup of unreadable junk wait on an endpoint that
    // has no bearing on whether it is junk.
    enabled: rawBlob !== undefined && rawBlob !== null,
  });

  // Decidable only with a list that succeeded, actually arrived, and that the
  // server was willing to give us.
  //
  // Whose list it is stopped being a question here: the entry is keyed by
  // account, so the previous account's list is unreachable rather than merely
  // rejected. What the checks still answer is whether there is an answer at all,
  // and the reason that matters is the *destructive* branch below — an
  // undecidable draft is withheld and recoverable, but a draft judged
  // not-yours is deleted.
  //
  // `isSuccess`: React Query keeps the last good `data` through a failed
  // refetch, and a retained list is not evidence about now.
  //
  // `staleTime: 0` on the query, still: a cached list is the right account's but
  // can be thirty seconds old, and a company created moments ago in another tab
  // would be missing from it — which reads as "this draft belongs to a company
  // you do not own" and deletes it.
  //
  // `unauthorized`: the query folds 401 and 403 into
  // `{ companies: [], unauthorized: true }` rather than throwing, so an auth
  // blip arrives as a *successful* fetch of an empty list and would otherwise
  // read as "this account owns nothing" and delete the draft.
  const ownershipDecidable =
    companiesQuery.isSuccess &&
    companiesQuery.data !== undefined &&
    !companiesQuery.data.unauthorized;

  const { saved, staleStateDetected } = useMemo(() => {
    if (rawBlob === undefined) return { saved: null, staleStateDetected: false };
    // Unreadable, so junk regardless of who owns what. Judged before the
    // ownership check rather than after it, so clearing it does not wait on a
    // company request that cannot change the answer.
    if (rawBlob === null) return { saved: null, staleStateDetected: true };
    // Not decidable yet, or not decidable at all. Either way: restore nothing,
    // delete nothing. A draft withheld is recoverable on the next load; a
    // draft deleted, or one handed to the wrong account, is not.
    if (!ownershipDecidable) return { saved: null, staleStateDetected: false };
    const restored = restoreOnboardingState(rawBlob, companiesQuery.data!.companies);
    return { saved: restored, staleStateDetected: restored === null };
  }, [rawBlob, ownershipDecidable, companiesQuery.data]);

  // A discarded/malformed state should not sit in storage waiting to confuse
  // the next onboarding attempt (e.g. a different signed-in user).
  useEffect(() => {
    if (!staleStateDetected) return;
    onboardingDraftStorage.clear();
  }, [staleStateDetected]);

  // A saved blob exists and the verification fetch is still in flight: wait,
  // rather than mount the inner wizard with a premature and unrecoverable
  // guess at the draft. Its ~20 `useState(saved?.x ?? default)` initializers
  // only read `saved` once.
  //
  // `isFetching`, not `isLoading`. `isLoading` is false whenever the cache
  // holds retained data, so a refetch over a warm cache would mount the wizard
  // while ownership was still undecidable - and with the wizard open, the
  // persist effect would overwrite the customer's own draft with defaults
  // before the answer arrived. `isFetching` covers the refetch too.
  //
  // While in flight, not on failure. The companies query sets `retry: false`,
  // so a failed fetch stays failed; and with no companies the dashboard offers
  // a "Get Started" button wired to onboarding, which a gate that returned null
  // here would make do nothing at all.
  //
  // Mounting does not cost the draft. The persist effect that would overwrite
  // it is itself gated on `effectiveOnboardingOpen`, so a mounted-but-closed
  // wizard writes nothing. If the wizard is open the customer is onboarding
  // right now, which supersedes the draft anyway.
  if (rawBlob !== undefined && companiesQuery.isFetching) {
    return null;
  }

  return <OnboardingWizardInner saved={saved} />;
}

function OnboardingWizardInner({
  saved,
}: {
  saved: Record<string, unknown> | null;
}) {
  const {
    onboardingOpen,
    onboardingOptions,
    closeOnboarding,
    onboardingRouteDismissed: routeDismissed,
    setOnboardingRouteDismissed: setRouteDismissed,
  } = useDialog();
  const { companies, setSelectedCompanyId, loading: companiesLoading } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { companyPrefix: matchedCompanyPrefix } = useParams<{ companyPrefix?: string }>();
  // This component renders beside `<Routes>`, not inside it (`App.tsx`), so it
  // has no route match and `useParams()` gives nothing. Read the prefix from
  // the pathname, which `useLocation()` supplies without a match. The param is
  // kept first so a future move inside the route tree needs no change here.
  const companyPrefix =
    matchedCompanyPrefix ?? companyPrefixFromOnboardingPath(location.pathname);
  // Managed stacks create organizations on Cloud, so the route below never
  // resolves into the create wizard there — see resolveRouteOnboardingOptions.
  const cloudInstance = useCloudInstance();

  // Support opening the wizard from a route (e.g. /onboarding or an existing
  // company's "add agent" entry point) in addition to the dialog context.
  // The company the path names, resolved before the mission lookup below so it
  // has something to ask about. Same match the resolver makes.
  const routeMatchedCompanyId =
    companyPrefix && !companiesLoading
      ? companies.find(
          (company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
        )?.id ?? null
      : null;
  // The mission lookup used to gate this: the step was applied once and not
  // revised, so opening before the answer arrived left the customer on the
  // wrong step. The step no longer depends on the answer, so the wait bought
  // nothing but a slower open. Companies still gate it — the resolver needs
  // them to match the prefix at all.
  const routeOnboardingOptions =
    companyPrefix && companiesLoading
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          companyPrefix,
          companies,
          cloudManaged: Boolean(cloudInstance),
        });
  const effectiveOnboardingOpen =
    onboardingOpen || (routeOnboardingOptions !== null && !routeDismissed);
  const effectiveOnboardingOptions = onboardingOpen
    ? onboardingOptions
    : routeOnboardingOptions ?? {};

  // Sync disabled adapter types only when the wizard is visible. The wizard is
  // mounted globally, including on /auth, where protected adapter routes are
  // expected to reject signed-out browsers.
  const disabledTypes = useDisabledAdaptersSync({ enabled: effectiveOnboardingOpen });
  const adapterRegistryLoaded = useAdapterRegistryLoaded({ enabled: effectiveOnboardingOpen });

  const initialStep = effectiveOnboardingOptions.initialStep ?? 0;
  const existingCompanyId = effectiveOnboardingOptions.companyId;

  const [step, setStep] = useState<Step>((saved?.step as Step) ?? initialStep);
  // The step this run *entered* on, which bounds how far back it can walk.
  // Captured once, when the wizard opens, for the same reason the step itself
  // is: it derives from queries, so a live read would move the floor under a
  // customer mid-flow — and here that would quietly re-open the "create a
  // company" step to a run that already holds one.
  const [entryStep, setEntryStep] = useState<number>((saved?.step as Step) ?? initialStep);
  const [onboardingPath, setOnboardingPath] = useState<"create" | "grow" | null>((saved?.onboardingPath as "create" | "grow" | null) ?? null);

  // "Grow existing" questionnaire fields
  const [growWorkflows, setGrowWorkflows] = useState((saved?.growWorkflows as string) ?? "");
  const [growPainPoints, setGrowPainPoints] = useState((saved?.growPainPoints as string) ?? "");
  const [growAutomate, setGrowAutomate] = useState((saved?.growAutomate as string) ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Step 1
  const [companyName, setCompanyName] = useState((saved?.companyName as string) ?? "");
  const [companyGoal, setCompanyGoal] = useState((saved?.companyGoal as string) ?? "");
  const [missionPath, setMissionPath] = useState<"direct" | "questionnaire" | null>((saved?.missionPath as "direct" | "questionnaire" | null) ?? null);
  const [missionConfirmed, setMissionConfirmed] = useState((saved?.missionConfirmed as boolean) ?? false);
  // Questionnaire answers
  const [q1, setQ1] = useState((saved?.q1 as string) ?? ""); // What do you do?
  const [q2, setQ2] = useState((saved?.q2 as string) ?? ""); // Who do you serve?
  const [q3, setQ3] = useState((saved?.q3 as string) ?? ""); // Biggest bottleneck?
  const [q4, setQ4] = useState((saved?.q4 as string) ?? ""); // What would success look like?

  // Step 2
  // The name is not defaulted: a pre-filled "Chief of staff" is a choice made
  // on the customer's behalf that they then have to notice and undo. It is the
  // step's only question, and its CTA gates on it.
  const [agentName, setAgentName] = useState((saved?.agentName as string) ?? "");
  // Defaults to `general` rather than empty. The arc stopped asking for a role
  // — a customer naming their first agent is describing what it does, not
  // filing it — but the hire still needs one, and the guard below returns
  // silently when it is missing. An unset role there would mean Connect
  // appearing to work and hiring nobody.
  const [agentRole, setAgentRole] = useState<AgentRole>(
    // `||`, not `??`: the empty string was this field's default before the arc
    // stopped asking for a role, so every draft saved by an earlier build holds
    // `agentRole: ""`. `??` passes that straight through, and an empty role
    // reaches the silent return in the hire — the exact failure the default
    // exists to prevent, arriving through a restored draft instead of a fresh
    // one.
    (saved?.agentRole as AgentRole) || DEFAULT_AGENT_ROLE,
  );
  const [adapterType, setAdapterType] = useState<AdapterType>((saved?.adapterType as AdapterType) ?? "claude_local");
  const [cwd, setCwd] = useState((saved?.cwd as string) ?? "");
  const [model, setModel] = useState((saved?.model as string) ?? "");
  const [command, setCommand] = useState((saved?.command as string) ?? "");
  const [args, setArgs] = useState((saved?.args as string) ?? "");
  const [url, setUrl] = useState((saved?.url as string) ?? "");
  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AdapterEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  const [showMoreAdapters, setShowMoreAdapters] = useState(false);
  // The owner's stored Claude subscription login, read right before the hire
  // (see handleGiveHeartbeat). Onboarding applies it with no extra control,
  // so nothing else reads this state yet.
  const [claudeOAuthStatus, setClaudeOAuthStatus] =
    useState<ClaudeOAuthTokenStatusResponse | null>(null);

  // Created entity IDs — pre-populate from existing company when skipping step 1
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    existingCompanyId ?? (saved?.createdCompanyId as string) ?? null
  );
  const [createdCompanyPrefix, setCreatedCompanyPrefix] = useState<
    string | null
  >((saved?.createdCompanyPrefix as string) ?? null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>((saved?.createdAgentId as string) ?? null);
  const [createdCompanyGoalId, setCreatedCompanyGoalId] = useState<string | null>(
    (saved?.createdCompanyGoalId as string) ?? null
  );
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(
    (saved?.createdProjectId as string) ?? null
  );
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(
    (saved?.createdIssueRef as string) ?? null
  );

  // The company the *route* last supplied, so a navigation that stops naming
  // one can drop it without touching a company the wizard created itself.
  const routeCompanyIdRef = useRef<string | null>(null);
  // The current company, mirrored so the sync effect can read it without
  // taking it as a dependency. Depending on it would re-run the effect on
  // every company change, and the effect also calls setStep - it would drag
  // the user back to the route's initial step mid-flow.
  const createdCompanyIdRef = useRef<string | null>(null);
  // In flight, synchronously. `loading` cannot answer this: it is state, so a
  // second caller in the same tick — key repeat holding Enter down — reads the
  // value the first has not written yet. `createdCompanyId` cannot answer it
  // either, because it is not set until the request it guards has resolved. A
  // ref is written before the request goes out, so the second caller sees it.
  const creatingCompanyRef = useRef(false);
  // Same shape for the hire. Greptile (round-3 PR): with "Test now" gone the
  // Connect handler re-runs a cached failed probe — and two overlapping
  // submissions could then both pass the fresh probe and both hire. `loading`
  // cannot stop the second caller for the same reason as above.
  const hiringAgentRef = useRef(false);
  // True when the last `adapterEnvResult` came from a config that carried
  // the fixed Claude login binding (see `hireAdapterConfig` in
  // `handleGiveHeartbeat`). A cached result from a config that did not carry
  // the binding cannot answer for a config that now does — see the reuse
  // check in `handleGiveHeartbeat`.
  const adapterEnvResultAppliedStoredLoginRef = useRef(false);
  createdCompanyIdRef.current = createdCompanyId;

  // The mission of the company actually in hand, which is not always the one
  // the route named - the dashboard opens the wizard with a company too. Same
  // query key as the route lookup above, so when they agree this is one cache
  // entry and no second request.
  const {
    mission: existingCompanyMission,
    settled: existingMissionSettled,
    fetching: existingMissionFetching,
  } = useCompanyMission(createdCompanyId);

  // Seed the mission field from the company's own goal.
  //
  // A company that already has its mission opens on the agent step, so steps 1
  // and 2 never run and `companyGoal` stays empty. It is not only a display
  // field: the Review checklist reads it, and `composeCeoInstructions` seeds
  // the lead agent's instructions from it. Left empty, the agent is hired
  // knowing nothing of the mission the customer gave at signup - which is the
  // answer this whole flow exists to carry forward.
  //
  // Only when the field is empty, so a customer editing their mission is never
  // overwritten by the stored copy.
  const hydratedMissionForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId) return;
    if (hydratedMissionForRef.current === createdCompanyId) return;
    if (!existingMissionSettled || existingMissionFetching) return;
    hydratedMissionForRef.current = createdCompanyId;
    if (!existingCompanyMission.goalInput) return;
    setCompanyGoal((current) => (current.trim() ? current : existingCompanyMission.goalInput));
    setCreatedCompanyGoalId((current) => current ?? existingCompanyMission.goalId);
  }, [
    effectiveOnboardingOpen,
    createdCompanyId,
    existingMissionSettled,
    existingMissionFetching,
    existingCompanyMission.goalInput,
    existingCompanyMission.goalId,
  ]);

  // Hiring seeds the agent's instructions from `companyGoal`, so it must not
  // run while that field is still waiting to be hydrated - the agent would be
  // created with an empty or foreign mission and nothing would report it.
  const missionUnresolvedForHire = isExistingCompanyMissionUnresolved({
    existingCompanyId: createdCompanyId,
    goalsLoaded: existingMissionSettled,
    goalsFetching: existingMissionFetching,
  });
  // The step the request wants, mirrored for the same reason. `initialStep` is
  // *derived* - from the company list, and now from the goal list behind
  // `useCompanyMission` - so its value changes whenever one of those queries
  // does: a retry, a background refetch, a cache invalidation. An effect that
  // depended on it would re-run on every such change and call setStep, moving
  // a customer who is already mid-flow. Reading it through a ref breaks that
  // dependency, so the effect runs when the wizard *opens* or when the company
  // changes, and takes whatever the step is at that moment.
  const initialStepRef = useRef<Step | undefined>(undefined);
  initialStepRef.current = effectiveOnboardingOptions.initialStep;

  // Reset the route-dismissed flag when navigating to a different path.
  useEffect(() => {
    setRouteDismissed(false);
  }, [location.pathname]);

  /**
   * Forget everything that describes one particular company.
   *
   * Called when the wizard stops holding a company - the route replaced it, or
   * withdrew it. Both are the same event, and clearing only part of it is what
   * lets the next company skip work it has not done: a kept goal id reads as
   * "this company's mission is already written", and the launch path would
   * link the next company's project to the previous company's goal.
   *
   * The name and the prefix are cleared here too and backfilled again from the
   * company list by the effects below, so they always describe the company in
   * hand rather than the one before it.
   */
  function clearCompanyScopedState() {
    setCreatedCompanyPrefix(null);
    setCompanyName("");
    setCompanyGoal("");
    // The marker travels with the field it describes. It means "companyGoal
    // holds this company's hydrated mission", so it is cleared wherever that
    // field is - here and in `reset()`. Left behind, the next run believes a
    // mission it no longer holds was already fetched, and hires the lead agent
    // without one.
    hydratedMissionForRef.current = null;
    setMissionPath(null);
    setMissionConfirmed(false);
    setCreatedCompanyGoalId(null);
    setCreatedProjectId(null);
    setCreatedIssueRef(null);
    setCreatedAgentId(null);
  }

  // Sync step and company when onboarding opens with explicit options.
  // Only override saved state when explicit options provide values.
  //
  // The step belongs to the request that opened the wizard, not to the latest
  // value of the expression that produced it - see `initialStepRef` above for
  // why those differ. This effect is therefore keyed on the two things that
  // make a *new* request: the wizard opening, and the company changing.
  // Navigating from one company's onboarding path to another re-decides the
  // step; the same request re-deriving a fresher value does not.
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    // If explicit options are provided, they take precedence over saved state
    if (initialStepRef.current) {
      setStep(initialStepRef.current);
      setEntryStep(initialStepRef.current);
    }
    const routeCompanyId = effectiveOnboardingOptions.companyId ?? null;
    if (routeCompanyId) {
      // Claim ownership only when the route *introduces* a company. A route
      // that merely names the one already in hand - the wizard created it,
      // then the user navigated to that company's onboarding path - has not
      // supplied anything, so it must not take ownership of it. Otherwise
      // navigating on to `/onboarding` would clear work the wizard did.
      if (routeCompanyId !== createdCompanyIdRef.current) {
        setCreatedCompanyId(routeCompanyId);
        clearCompanyScopedState();
      }
      // Ownership is recorded either way, including when the route merely
      // names the company already in hand. Only the clearing above is
      // conditional.
      //
      // This is a deliberate change to the rule the comment above described.
      // Not recording ownership there protected wizard-created work from a
      // later `/onboarding`, but it also meant that company was never
      // withdrawn: create a company on step 1, visit its own onboarding path,
      // then go to `/onboarding`, and the wizard shows "create a company"
      // while still holding the previous one. The next confirmation then
      // writes that customer's new mission into the old company - which is
      // exactly the failure the withdrawal branch below was written to
      // prevent, reached by a path it could not see.
      //
      // Losing the step-1 progress on `/onboarding` is the better error:
      // `/onboarding` is a request to start a company, so honouring it beats
      // silently writing into a different one.
      routeCompanyIdRef.current = routeCompanyId;
      return;
    }
    if (routeCompanyIdRef.current) {
      // The route named a company and now does not - the user navigated from
      // an existing company's onboarding to `/onboarding`, or to a prefix that
      // matches nothing. Drop it. Keeping it leaves the wizard showing step 1,
      // "create a company", while still holding the previous one, so the next
      // confirmation writes into that company instead of making a new one.
      //
      // Only a company this route supplied is cleared. One the wizard created
      // itself, or restored from saved state, is left alone: the ref is null
      // in those cases, and clearing them would discard real progress.
      //
      // Withdrawing a company clears the same state that replacing one does.
      // The two are the same event - this company is no longer the wizard's -
      // and clearing only half of it leaves ids that make the *next* company
      // skip work it has not done.
      setCreatedCompanyId(null);
      routeCompanyIdRef.current = null;
      clearCompanyScopedState();
    }
  }, [effectiveOnboardingOpen, effectiveOnboardingOptions.companyId]);

  // Backfill issue prefix for an existing company once companies are loaded.
  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId || createdCompanyPrefix) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company) setCreatedCompanyPrefix(company.issuePrefix);
  }, [effectiveOnboardingOpen, createdCompanyId, createdCompanyPrefix, companies]);

  // Backfill the name too, for the same company and the same reason.
  //
  // `companyName` is otherwise only ever typed on step 1, so a company that
  // enters the wizard further along has none. That is a dead end rather than a
  // cosmetic gap: the mission step prints the name in its own copy, and both
  // ways forward from that step - the button and the Enter key - require
  // `companyName.trim()`. An existing company opened on the mission step could
  // not leave it. Nothing reached that state until the dashboard started
  // opening agentless companies there.
  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId || companyName) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company) setCompanyName(company.name);
  }, [effectiveOnboardingOpen, createdCompanyId, companyName, companies]);

  // Persist wizard state to localStorage on every change
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const state = {
      step, companyName, companyGoal, missionPath, missionConfirmed,
      q1, q2, q3, q4, agentName, agentRole, adapterType, cwd, model, command, args, url,
      createdCompanyId, createdCompanyPrefix, createdAgentId,
      createdCompanyGoalId, createdProjectId, createdIssueRef,
      onboardingPath, growWorkflows, growPainPoints, growAutomate,
    };
    onboardingDraftStorage.write(JSON.stringify(state));
  }, [
    effectiveOnboardingOpen, step, companyName, companyGoal, missionPath, missionConfirmed,
    q1, q2, q3, q4, agentName, agentRole, adapterType, cwd, model, command, args, url,
    createdCompanyId, createdCompanyPrefix, createdAgentId,
    createdCompanyGoalId, createdProjectId, createdIssueRef,
    onboardingPath, growWorkflows, growPainPoints, growAutomate,
  ]);

  const {
    data: adapterModels,
    error: adapterModelsError,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching
  } = useQuery({
    // The wizard doesn't expose an environment selector, so models always
    // resolve against the local Paperclip host (environmentId = null).
    queryKey: createdCompanyId
      ? queryKeys.agents.adapterModels(createdCompanyId, adapterType, null)
      : ["agents", "none", "adapter-models", adapterType, null],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, adapterType, { environmentId: null }),
    // Models are picked on step 4 (Connect a model).
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 4
  });
  const getCapabilities = useAdapterCapabilities();
  const adapterCaps = getCapabilities(adapterType);
  const isLocalAdapterCaps =
    adapterCaps.supportsInstructionsBundle ||
    adapterCaps.supportsSkills ||
    adapterCaps.supportsLocalAgentJwt;
  const isLocalAdapter =
    isLocalAdapterCaps ||
    adapterType === "claude_local" ||
    adapterType === "codex_local" ||
    adapterType === "gemini_local" ||
    adapterType === "kimi_local" ||
    adapterType === "opencode_local" ||
    adapterType === "pi_local" ||
    adapterType === "cursor";
  // Build adapter grids dynamically from the UI registry + display metadata.
  // External/plugin adapters automatically appear with generic defaults, and
  // server-disabled types are filtered out.
  const { recommendedAdapters, moreAdapters } = useMemo(() => {
    const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);
    const all = listUIAdapters()
      .filter((a) =>
        !SYSTEM_ADAPTER_TYPES.has(a.type) &&
        !disabledTypes.has(a.type) &&
        isVisualAdapterChoice(a.type)
      )
      .map((a) => ({ ...getAdapterDisplay(a.type), type: a.type }));

    return {
      recommendedAdapters: all.filter((a) => a.recommended),
      moreAdapters: all.filter((a) => !a.recommended),
    };
  }, [disabledTypes]);

  // The default (or a saved) adapterType can name an adapter the server has
  // since disabled — e.g. a cloud sandbox registry without claude_local. The
  // grid hides it, so without this snap the wizard would silently keep an
  // invisible selection and create an agent that can never acquire a lease.
  useEffect(() => {
    // Not until the registry has loaded. External adapter types are only
    // registered once the adapters query resolves, so before that a saved
    // external adapter is indistinguishable from a disabled one - and snapping
    // would replace the customer's choice with a built-in and persist it.
    if (!adapterRegistryLoaded) return;
    const visible = [...recommendedAdapters, ...moreAdapters].filter(
      (a) => !a.comingSoon,
    );
    if (visible.length === 0) return;
    if (visible.some((a) => a.type === adapterType)) return;
    const next = visible[0].type as AdapterType;
    setAdapterType(next);
    if (next === "codex_local") return;
    if (next === "opencode_local") {
      setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
      return;
    }
    if (next === "gemini_local") {
      setModel(DEFAULT_GEMINI_LOCAL_MODEL);
      return;
    }
    if (next === "cursor") {
      setModel(DEFAULT_CURSOR_LOCAL_MODEL);
      return;
    }
    setModel("");
  }, [adapterRegistryLoaded, recommendedAdapters, moreAdapters, adapterType]);

  const COMMAND_PLACEHOLDERS: Record<string, string> = {
    claude_local: "claude",
    codex_local: "codex",
    gemini_local: "gemini",
    kimi_local: "kimi",
    pi_local: "pi",
    cursor: "agent",
    opencode_local: "opencode",
  };
  const effectiveAdapterCommand =
    command.trim() ||
    (COMMAND_PLACEHOLDERS[adapterType] ?? adapterType.replace(/_local$/, ""));

  useEffect(() => {
    if (step !== 4) return;
    setAdapterEnvResult(null);
    adapterEnvResultAppliedStoredLoginRef.current = false;
    setAdapterEnvError(null);
  }, [step, adapterType, model, command, args, url]);

  const selectedModel = (adapterModels ?? []).find((m) => m.id === model);
  const hasAnthropicApiKeyOverrideCheck =
    adapterEnvResult?.checks.some(
      (check) =>
        check.code === "claude_anthropic_api_key_overrides_subscription"
    ) ?? false;
  const shouldSuggestUnsetAnthropicApiKey =
    adapterType === "claude_local" &&
    adapterEnvResult?.status === "fail" &&
    hasAnthropicApiKeyOverrideCheck;
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return (adapterModels ?? []).filter((entry) => {
      if (!query) return true;
      const provider = extractProviderIdWithFallback(entry.id, "");
      return (
        entry.id.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query) ||
        provider.toLowerCase().includes(query)
      );
    });
  }, [adapterModels, modelSearch]);
  const groupedModels = useMemo(() => {
    if (adapterType !== "opencode_local") {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id))
        }
      ];
    }
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const entry of filteredModels) {
      const provider = extractProviderIdWithFallback(entry.id);
      const bucket = groups.get(provider) ?? [];
      bucket.push(entry);
      groups.set(provider, bucket);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id))
      }));
  }, [filteredModels, adapterType]);

  function reset() {
    onboardingDraftStorage.clear();
    // Cleared with `companyGoal` below - see `clearCompanyScopedState`.
    hydratedMissionForRef.current = null;
    setStep(0);
    setOnboardingPath(null);
    setGrowWorkflows("");
    setGrowPainPoints("");
    setGrowAutomate("");
    setLoading(false);
    setError(null);
    setCompanyName("");
    setCompanyGoal("");
    setMissionPath(null);
    setMissionConfirmed(false);
    setQ1("");
    setQ2("");
    setQ3("");
    setQ4("");
    // Back to the mount defaults: an empty name (the step's only question, and
    // what its CTA gates on) and the neutral role every onboarding hire uses.
    setAgentName("");
    setAgentRole(DEFAULT_AGENT_ROLE);
    setAdapterType("claude_local");
    setModel("");
    setCommand("");
    setArgs("");
    setUrl("");
    setAdapterEnvResult(null);
    adapterEnvResultAppliedStoredLoginRef.current = false;
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
    setClaudeOAuthStatus(null);
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setCreatedAgentId(null);
    setCreatedCompanyGoalId(null);
    setCreatedProjectId(null);
    setCreatedIssueRef(null);
  }

  function handleClose() {
    reset();
    closeOnboarding();
    // On the /onboarding route the wizard is also kept open by the route
    // itself, so closing the dialog must mark the route dismissed — otherwise
    // effectiveOnboardingOpen stays true and the wizard re-renders instead of
    // handing off to the launcher card (PAP-52).
    setRouteDismissed(true);
  }

  /**
   * Whether the company an async handler started for is still the one in hand.
   *
   * A route change can switch companies while a request is in flight, and the
   * switch clears the created resource ids so the new company starts clean. A
   * write that lands afterwards would put them back, and hand that company the
   * previous one's goal, project, issue or agent — which is exactly what the
   * clearing exists to prevent.
   *
   * Every async write below asks this before it attributes anything. It never
   * cancels the server work, which is done and correct either way; it declines
   * only to record it against a company it does not belong to.
   */
  function stillTheSameCompany(companyIdAtStart: string | null) {
    return createdCompanyIdRef.current === companyIdAtStart;
  }

  async function handleLaunchToDashboard() {
    if (!createdCompanyId || !createdAgentId) {
      setError(INCOMPLETE_ONBOARDING_STATE_MESSAGE);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let goalId = createdCompanyGoalId;
      if (!goalId) {
        const goals = await goalsApi.list(createdCompanyId);
        goalId = selectDefaultCompanyGoalId(goals);
        if (stillTheSameCompany(createdCompanyId)) setCreatedCompanyGoalId(goalId);
      }

      let projectId = createdProjectId;
      if (!projectId) {
        const projects = await projectsApi.list(createdCompanyId);
        const existingOnboardingProject = selectReusableOnboardingProject(projects);
        if (existingOnboardingProject) {
          projectId = existingOnboardingProject.id;
        } else {
          const project = await projectsApi.create(
            createdCompanyId,
            buildOnboardingProjectPayload(goalId)
          );
          projectId = project.id;
          queryClient.invalidateQueries({
            queryKey: queryKeys.projects.list(createdCompanyId)
          });
        }
        if (stillTheSameCompany(createdCompanyId)) setCreatedProjectId(projectId);
      }

      let issueRef = createdIssueRef;
      if (!issueRef) {
        const issue = await issuesApi.create(
          createdCompanyId,
          buildOnboardingIssuePayload({
            title: DEFAULT_TASK_TITLE,
            description: DEFAULT_TASK_DESCRIPTION,
            assigneeAgentId: createdAgentId,
            projectId,
            goalId
          })
        );
        issueRef = issue.identifier ?? issue.id;
        if (stillTheSameCompany(createdCompanyId)) setCreatedIssueRef(issueRef);
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(createdCompanyId)
        });
      }

      // Everything above is server work and stands on its own: the company has
      // its goal, its onboarding project and its first task. What follows is
      // this wizard finishing — selecting a company, discarding its own state
      // and navigating. None of that is right for a customer who has moved to
      // another company in the meantime: it would take them back, and `reset()`
      // would discard the progress they had started there.
      if (!stillTheSameCompany(createdCompanyId)) return;

      const prefix = createdCompanyPrefix;
      // Select the new company as a route sync, not a manual switch: the
      // explicit navigate below is the intended destination, so page-memory's
      // "restore last page" (which falls back to /dashboard) must not fire and
      // clobber the first-task URL. See PAP-404.
      setSelectedCompanyId(createdCompanyId, { source: "route_sync" });
      reset();
      closeOnboarding();
      // Drop the user straight into the first task's detail page (not the
      // dashboard) so they land on the conversation the agent will start in.
      navigate(prefix ? `/${prefix}/issues/${issueRef}` : `/issues/${issueRef}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch first task");
    } finally {
      setLoading(false);
    }
  }

  function buildAdapterConfig(): Record<string, unknown> {
    const adapter = getUIAdapter(adapterType);
    const config = adapter.buildAdapterConfig({
      ...defaultCreateValues,
      adapterType,
      model:
        adapterType === "gemini_local"
          ? model || DEFAULT_GEMINI_LOCAL_MODEL
          : adapterType === "kimi_local"
            ? model || DEFAULT_KIMI_LOCAL_MODEL
          : adapterType === "cursor"
            ? model || DEFAULT_CURSOR_LOCAL_MODEL
            : adapterType === "opencode_local"
              ? model || DEFAULT_OPENCODE_LOCAL_MODEL
              : model,
      command,
      args,
      url,
      dangerouslySkipPermissions:
        adapterType === "claude_local" || adapterType === "opencode_local",
      dangerouslyBypassSandbox:
        adapterType === "codex_local"
          ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
          : defaultCreateValues.dangerouslyBypassSandbox
    });
    if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
    }
    return config;
  }

  async function runAdapterEnvironmentTest(
    adapterConfigOverride?: Record<string, unknown>,
    appliedStoredClaudeLoginBinding = false
  ): Promise<AdapterEnvironmentTestResult | null> {
    if (!createdCompanyId) {
      setAdapterEnvError(
        "Create or select an organization before testing adapter environment."
      );
      return null;
    }
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    try {
      // Probe the environment a real run would use, so the Test matches a real
      // run. The wizard has no agent yet, so the agent-default tier is always
      // null; resolve the instance default and the instance local default. A
      // settings-resolution failure surfaces an error instead of a silent host
      // probe, which would report a false result.
      let environmentList: Environment[];
      let settings: InstanceSettings;
      let managedSandboxOnly: boolean;
      try {
        const [list, generalSettings, experimentalSettings] = await Promise.all([
          queryClient.ensureQueryData({
            queryKey: queryKeys.environments.list(createdCompanyId),
            queryFn: () => environmentsApi.list(createdCompanyId),
          }),
          queryClient.ensureQueryData({
            queryKey: queryKeys.instance.settings,
            queryFn: () => instanceSettingsApi.get(),
          }),
          queryClient.ensureQueryData({
            queryKey: queryKeys.instance.experimentalSettings,
            queryFn: () => instanceSettingsApi.getExperimental(),
          }),
        ]);
        environmentList = list;
        settings = generalSettings;
        managedSandboxOnly = experimentalSettings?.enableManagedSandboxOnly === true;
      } catch {
        setAdapterEnvError(
          "Could not load environment settings to determine which environment to test in. Retry the test.",
        );
        return null;
      }
      // Mirror the server run-time resolution, including the managed-sandbox-only
      // redirect: when the resolution lands on the local environment and the
      // policy is on, probe the managed sandbox the real run uses instead. The
      // resolver throws when no managed sandbox is available, which the outer
      // catch surfaces as a fail-closed error rather than a local host probe.
      const environmentId = resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: settings?.defaultEnvironmentId ?? null,
        localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(environmentList),
        managedSandboxOnly,
        managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(environmentList),
        // The policy hides the local environment, so an instance default that
        // still points at the hidden local row names no visible environment.
        // Pass the visible ids so the resolver redirects that stale local
        // default to the managed sandbox instead of sending the hidden local id.
        visibleEnvironmentIds: environmentList.map((environment) => environment.id),
      });
      const result = await agentsApi.testEnvironment(
        createdCompanyId,
        adapterType,
        {
          adapterConfig: adapterConfigOverride ?? buildAdapterConfig(),
          environmentId,
        }
      );
      setAdapterEnvResult(result);
      adapterEnvResultAppliedStoredLoginRef.current = appliedStoredClaudeLoginBinding;
      return result;
    } catch (err) {
      setAdapterEnvError(
        err instanceof Error ? err.message : "Adapter environment test failed"
      );
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }

  // Step 2 → 3 ("Confirm mission"): create the company + its company-level
  // goal, then advance to naming the team lead. Guarded so revisiting the
  // mission step (e.g. via Back) doesn't create a duplicate company.
  async function handleConfirmMission() {
    if (createdCompanyId) {
      // An existing company needs its mission written, not just skipped past.
      // This branch used to advance without saving anything, which was
      // harmless while nothing sent an existing company to the mission step -
      // a company reached step 2 only by creating itself on step 1, one line
      // below. The dashboard now opens an agentless company here, so the
      // customer types a mission and presses "Confirm mission". Advancing
      // without writing it would leave the company with no mission at all,
      // which is the state this whole change exists to remove.
      //
      // A goal already in hand means update it, not skip the write. It used
      // to mean skip, which was safe only while the field could not hold an
      // unsaved change: the id was set by *writing* the mission, so arriving
      // here with one meant nothing had been typed since. Hydration breaks
      // that - the id now also arrives from the company's existing goal, with
      // the customer's edits sitting in the field beside it - and skipping
      // would discard exactly the answer this step asked for.
      setLoading(true);
      setError(null);
      try {
        // The company may already have a mission this step could not see.
        // `useCompanyMission` fails open, so a goal lookup that exhausted its
        // retries sends a company that has one here anyway. Adding a second
        // company-level goal would leave two, and the earlier one would keep
        // winning `selectDefaultCompanyGoalId` everywhere outside this wizard.
        //
        // So read once more before writing, and update rather than add. The
        // customer just answered the question on a step that asked it, so
        // their answer is the mission. A read that fails still writes: an
        // unwritten mission is the failure this whole change exists to remove.
        let existingGoalId: string | null = createdCompanyGoalId;
        try {
          const goals = await queryClient.fetchQuery({
            queryKey: queryKeys.goals.list(createdCompanyId),
            queryFn: () => goalsApi.list(createdCompanyId)
          });
          existingGoalId = existingGoalId ?? selectDefaultCompanyGoalId(goals);
        } catch {
          // Still cannot tell. Fall through and write.
        }

        const plan = planMissionPersistence({
          goalInput: companyGoal,
          existingGoalId,
        });
        if (plan.kind === "skip") {
          setStep(3);
          return;
        }
        const goal =
          plan.kind === "update"
            ? await goalsApi.update(plan.goalId, plan.payload)
            : await goalsApi.create(createdCompanyId, plan.payload);
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(createdCompanyId)
        });
        if (!stillTheSameCompany(createdCompanyId)) return;
        setCreatedCompanyGoalId(goal.id);
        setStep(3);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save the mission");
      } finally {
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // Same guard as the others, from the other end: nothing was in hand when
      // this started, so "unchanged" means still nothing. A route that supplied
      // a company while the request was open has taken over the wizard, and
      // adopting the company just created would fight it — and would leave the
      // customer on a company they never navigated to.
      if (!stillTheSameCompany(null)) return;
      setCreatedCompanyId(company.id);
      // Keep the mirror current here rather than waiting for the next render.
      // The goal write below asks `stillTheSameCompany(company.id)`, and a ref
      // that still held the pre-create value would answer "no" to the handler
      // that just did the creating - so the goal would never be attributed and
      // the wizard would sit on the mission step it had just completed.
      createdCompanyIdRef.current = company.id;
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);

      const parsedGoal = parseOnboardingGoalInput(companyGoal);
      const goal = await goalsApi.create(company.id, {
        title: parsedGoal.title,
        ...(parsedGoal.description
          ? { description: parsedGoal.description }
          : {}),
        level: "company",
        status: "active"
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.list(company.id)
      });
      if (!stillTheSameCompany(company.id)) return;
      setCreatedCompanyGoalId(goal.id);

      setStep(3); // → Create your team lead
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      setLoading(false);
    }
  }

  // Step 1 → 3 ("Name your company"): create the company, then go straight to
  // the first agent.
  //
  // This work used to live at the end of `handleConfirmMission`, because step 1
  // led to the mission step and the company was created when that step was
  // confirmed. Onboarding no longer asks for the mission, so step 1 has to do
  // its own creating — routing 1 → 3 without this left the wizard on the agent
  // step with no company to hire into, and nothing said so.
  //
  // No goal is written here. That is the difference from the path this was
  // taken from, and it is deliberate: the mission is collected later, in the
  // tenant app, so writing an empty one now would only give the company a goal
  // it did not choose.
  async function handleCreateCompany() {
    if (createdCompanyId) {
      setStep(3);
      return;
    }
    if (creatingCompanyRef.current) return;
    creatingCompanyRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // Nothing was in hand when this started, so "unchanged" means still
      // nothing. A route that supplied a company while the request was open has
      // taken over the wizard, and adopting the company just created would
      // fight it — and would leave the customer on a company they never
      // navigated to.
      if (!stillTheSameCompany(null)) return;
      setCreatedCompanyId(company.id);
      // Keep the mirror current rather than waiting for the next render, for
      // the same reason the mission path does: anything downstream that asks
      // `stillTheSameCompany` in this tick would otherwise be told no.
      createdCompanyIdRef.current = company.id;
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      creatingCompanyRef.current = false;
      setLoading(false);
    }
  }


  // Step 4 → 5 ("Give it a heartbeat"): hire the lead agent + seed its
  // instructions, then advance to Review. Guarded so revisiting step 4
  // doesn't hire a second agent.
  async function handleGiveHeartbeat() {
    if (!createdCompanyId) return;
    // Guarded at the button and the Enter path too; repeated here because this
    // seeds the agent's instructions from `companyGoal`, and hiring with an
    // unhydrated mission fails silently - the agent exists, and simply never
    // learns what the company is for.
    if (missionUnresolvedForHire) return;
    if (createdAgentId) {
      setStep(5);
      return;
    }
    if (hiringAgentRef.current) return;
    hiringAgentRef.current = true;
    setLoading(true);
    setError(null);
    try {
      if (adapterType === "opencode_local") {
        const selectedModelId = model.trim();
        if (!isValidOpenCodeModelId(selectedModelId)) {
          setError(
            "OpenCode requires an explicit model in provider/model format."
          );
          return;
        }
        if (adapterModelsError) {
          setError(
            adapterModelsError instanceof Error
              ? adapterModelsError.message
              : "Failed to load OpenCode models."
          );
          return;
        }
        if (adapterModelsLoading || adapterModelsFetching) {
          setError(
            "OpenCode models are still loading. Please wait and try again."
          );
          return;
        }
        const discoveredModels = adapterModels ?? [];
        if (!discoveredModels.some((entry) => entry.id === selectedModelId)) {
          setError(
            discoveredModels.length === 0
              ? "No OpenCode models discovered. Run `opencode models` and authenticate providers."
              : `Configured OpenCode model is unavailable: ${selectedModelId}`
          );
          return;
        }
      }

      // Onboarding applies a stored Claude subscription login automatically,
      // with no extra control. A new user who signs in, leaves, and returns
      // should not sign in a second time — that is the board's direction.
      // The binding is a reference to the owner's stored value, never the
      // value itself (see buildFixedClaudeOAuthBinding). The server rejects
      // that binding together with a configured ANTHROPIC_API_KEY, so this
      // checks the built configuration first and asks the status route only
      // when there is no such conflict.
      //
      // Read the stored-login status before the environment test below, and
      // fold it into one adapter configuration. The test must probe the same
      // configuration the hire sends — a config without the binding can
      // report missing authentication for a user the binding would have
      // covered.
      const baseAdapterConfig = buildAdapterConfig();
      let storedClaudeLogin: ClaudeOAuthTokenStatusResponse | null = null;
      if (
        adapterType === "claude_local" &&
        !adapterConfigHasAnthropicApiKey(baseAdapterConfig)
      ) {
        try {
          storedClaudeLogin = await agentsApi.getClaudeOAuthTokenStatus(createdCompanyId);
        } catch (err) {
          // A fixed 404 means the owner has no stored value. It is not a
          // failure.
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
          storedClaudeLogin = null;
        }
        if (stillTheSameCompany(createdCompanyId)) setClaudeOAuthStatus(storedClaudeLogin);
      }
      const shouldApplyStoredClaudeLogin = storedClaudeLogin !== null;
      const hireAdapterConfig = shouldApplyStoredClaudeLogin
        ? {
            ...baseAdapterConfig,
            env: {
              ...(isEnvRecord(baseAdapterConfig.env) ? baseAdapterConfig.env : {}),
              ...buildFixedClaudeOAuthBinding(),
            },
          }
        : baseAdapterConfig;

      if (isLocalAdapter) {
        // A cached result is reusable only when it tested the same
        // configuration the hire below sends, and only when it does not
        // block the hire — see blocksAgentCreate. With the "Test now" card
        // gone, this button is the only way to re-probe. Reusing a stale
        // blocking result, or a result from a config that did not carry the
        // stored login, would lock out a customer who has since fixed the
        // problem or signed in.
        const cachedUsable =
          adapterEnvResult &&
          adapterEnvResultAppliedStoredLoginRef.current === shouldApplyStoredClaudeLogin &&
          !blocksAgentCreate(adapterEnvResult)
            ? adapterEnvResult
            : null;
        const result =
          cachedUsable ??
          (await runAdapterEnvironmentTest(hireAdapterConfig, shouldApplyStoredClaudeLogin));
        if (!result) return;
        // Block the hire on a failed environment test. Also block it on a
        // pass or a warn result that reports missing authentication — the
        // agent cannot run without one of those.
        if (blocksAgentCreate(result)) {
          setError(
            result.status === "fail"
              ? "The environment test failed. Fix the reported checks before you hire this agent."
              : "No working authentication was found. Fix the reported checks before you hire this agent.",
          );
          return;
        }
      }

      // `agentRole` always holds a value now (see its default), so this is a
      // type narrowing rather than a gate — but it stays, because a future
      // path that clears the role must not reach a hire that silently no-ops.
      if (!agentRole) return;

      const hire = await agentsApi.hire(createdCompanyId, {
        // The name is optional; an agent that reaches here without one is
        // named for the job it was hired to do rather than left blank.
        name: agentName.trim() || AGENT_ROLE_LABELS[agentRole],
        role: agentRole,
        adapterType,
        adapterConfig: hireAdapterConfig,
        ...(shouldApplyStoredClaudeLogin ? { applyStoredClaudeLogin: true } : {}),
        runtimeConfig: buildNewAgentRuntimeConfig()
      });
      if (hire.approval) {
        await approvalsApi.approve(
          hire.approval.id,
          "Approved during onboarding first-agent setup."
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.list(createdCompanyId)
        });
      }
      const agent = hire.agent;
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId)
      });
      // Seed the CEO's agent instructions file so the agent always has
      // company context + a hiring-plan output format rule. Non-fatal on
      // failure — the agent can still function with adapter defaults.
      //
      // Before the ownership check below on purpose. This agent exists now,
      // and it needs its instructions whatever this wizard goes on to show.
      // Guarding server work rather than attribution would leave a hired agent
      // with adapter defaults because the customer changed pages.
      try {
        const bundle = await agentsApi.instructionsBundle(agent.id, createdCompanyId);
        await agentsApi.saveInstructionsFile(
          agent.id,
          {
            path: bundle.entryFile,
            content: composeCeoInstructions({
              companyName,
              companyGoal,
              growPath: onboardingPath === "grow",
              growWorkflows,
              growPainPoints,
              growAutomate,
              q1, q2, q3, q4,
            }),
          },
          createdCompanyId,
        );
      } catch (err) {
        console.warn("Failed to seed CEO instructions:", err);
      }

      if (!stillTheSameCompany(createdCompanyId)) return;
      setCreatedAgentId(agent.id);
      // Advance to the Review step — the lead is now online. The user drives
      // strategy + hiring from the planning chat after "Get started".
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      hiringAgentRef.current = false;
      setLoading(false);
    }
  }

  async function handleUnsetAnthropicApiKey() {
    if (!createdCompanyId || unsetAnthropicLoading) return;
    setUnsetAnthropicLoading(true);
    setError(null);
    setAdapterEnvError(null);
    setForceUnsetAnthropicApiKey(true);

    const configWithUnset = (() => {
      const config = buildAdapterConfig();
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
      return config;
    })();

    try {
      if (createdAgentId) {
        await agentsApi.update(
          createdAgentId,
          { adapterConfig: configWithUnset },
          createdCompanyId
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
      }

      const result = await runAdapterEnvironmentTest(configWithUnset);
      if (result?.status === "fail") {
        setError(
          "Retried with ANTHROPIC_API_KEY unset in adapter config, but the environment test is still failing."
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to unset ANTHROPIC_API_KEY and retry."
      );
    } finally {
      setUnsetAnthropicLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Something nearer the key already dealt with it. The company-name field
    // handles Enter itself and does not check for a modifier, so Cmd+Enter in
    // that field reaches both handlers — and both would start creating a
    // company. The `loading` guard below cannot catch that: `setLoading(true)`
    // has not landed while the same event is still bubbling, so the second
    // caller reads the value the first one has not written yet. Two companies,
    // one keystroke.
    if (e.defaultPrevented) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // Every button below is disabled while a request is in flight. The
      // keyboard has to honour the same rule, or a second Enter re-enters a
      // handler whose guard is a piece of state the first one has not set
      // yet — two goals for one mission, two agents for one hire.
      if (loading) return;
      if (step === 0) return; // front door requires click
      if (step === 1 && companyName.trim()) {
        if (skipsMissionStep) void handleCreateCompany();
        else setStep(2);
      }
      else if (step === 2 && companyName.trim() && companyGoal.trim()) handleConfirmMission();
      else if (step === 3 && agentName.trim()) setStep(4);
      else if (step === 4 && agentName.trim() && !missionUnresolvedForHire)
        handleGiveHeartbeat();
      else if (step === 5) handleLaunchToDashboard();
    }
  }

  if (!effectiveOnboardingOpen) return null;

  // The arc strip stands in for the full-length bar only when the run began on
  // the arc — the Cloud-first path, where the company already exists and steps
  // 1-2 never happen. A run that started at step 1 keeps one continuous count.
  // Step 2 is two different screens wearing one number: the grow path's "tell us
  // about your team" questionnaire, and the create path's mission step.
  // Onboarding stopped asking for the mission, but the questionnaire is still
  // how a grow run describes the team it is levelling up — its answers seed the
  // lead agent — so only the create path skips ahead.
  const skipsMissionStep = onboardingPath !== "grow";

  // Back lands on whatever came before this step *for this run*, which is not
  // always `step - 1`. A create run went 1 → 3, so stepping blindly would walk
  // it into the mission screen it never saw. Two runs still belong on step 2
  // going back: a grow run, whose step 2 is the questionnaire rather than the
  // mission, and a run that *entered* on the mission step because something
  // opened it there — it has seen that screen, so Back owes it the way back.
  function backStepFrom(current: Step): Step {
    if (current === 3 && skipsMissionStep && entryStep !== 2) return 1;
    return (current - 1) as Step;
  }

  const isAgentArcStep = agentArcStepFor(step) !== null;
  const showsAgentArcStepper = isAgentArcStep && entryStep >= 3;

  const launchStateIncomplete = step === 5 && (!createdCompanyId || !createdAgentId);
  const visibleError = error ?? (launchStateIncomplete ? INCOMPLETE_ONBOARDING_STATE_MESSAGE : null);

  return (
    <Dialog
      open={effectiveOnboardingOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleClose();
        }
      }}
    >
      <DialogPortal>
        {/* Plain div instead of DialogOverlay — Radix's overlay wraps in
            RemoveScroll which blocks wheel events on our custom (non-DialogContent)
            scroll container. A plain div preserves the background without scroll-locking. */}
        <div className="fixed inset-0 z-50 bg-background" />
        <div className="fixed inset-0 z-50 flex" onKeyDown={handleKeyDown}>
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-4 left-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </button>

          {/* Step 0: Front Door — full-screen choice */}
          {step === 0 && (
            <div className="w-full flex flex-col overflow-y-auto">
              <FrontDoor onChoose={(path) => {
                setOnboardingPath(path);
                setStep(1);
              }} />
            </div>
          )}

          {/* Left half — form (steps 1+) */}
          {step !== 0 && (
          <div
            className={cn(
              "w-full flex flex-col overflow-y-auto transition-(--tp-width) duration-500 ease-in-out",
              step === 2 ? "md:w-1/2" : "md:w-full"
            )}
          >
            <div
              className={cn(
                "mx-auto my-auto shrink-0",
                // The arc sits in the prototype's card frame; the earlier steps
                // keep the split-panel layout they were designed for. One
                // element styled two ways, not two wrappers, so the step
                // content below renders exactly once.
                isAgentArcStep
                  ? "w-(--sz-560px) max-w-full rounded-xl border border-border bg-card px-8 py-10 sm:px-10 sm:py-11"
                  : "w-full max-w-md px-8 py-12",
              )}
            >
              {/* Full-length progress bar (brand .wsteps/.wstep) — segment N
                  filled once step ≥ N. Completed segments jump back.
                  Hidden for a run that entered on the agent arc: the arc strip
                  below counts that run's three steps, and showing both put two
                  progress bars on the same screen. A run that started at step 1
                  keeps this one throughout, so its count never restarts.

                  Step 2 is absent: onboarding no longer asks for the mission, so
                  a segment for it would be one the run can never fill, and the
                  count would visibly skip from 1 to 3. */}
              {!showsAgentArcStepper && (
              <div className="flex items-center gap-1.5 mb-8">
                {([1, 3, 4, 5] as const).map((s) => {
                  const filled = step >= s;
                  const canJump = canJumpToOnboardingStep({
                    targetStep: s,
                    currentStep: step,
                    entryStep,
                  });
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-label={`Step ${s}`}
                      aria-current={s === step ? "step" : undefined}
                      disabled={!canJump}
                      onClick={() => canJump && setStep(s as Step)}
                      className={cn(
                        "h-1 flex-1 rounded-full transition-colors",
                        filled ? "bg-foreground" : "bg-muted",
                        canJump ? "cursor-pointer" : "cursor-default"
                      )}
                    />
                  );
                })}
              </div>
              )}

              {/* The agent arc's progress strip. Numbered 1–3 over the wizard's
                  steps 3–5, because company creation already happened in Cloud
                  and the mission step is skipped when it did. */}
              {showsAgentArcStepper && (
                <Stepper
                  step={agentArcStepFor(step)!}
                  canJumpToStep={(target) =>
                    canJumpToOnboardingStep({
                      targetStep: AGENT_ARC_WIZARD_STEPS[target - 1]!,
                      currentStep: step,
                      entryStep,
                    })
                  }
                  onJumpToStep={(target) => setStep(AGENT_ARC_WIZARD_STEPS[target - 1]! as Step)}
                />
              )}

              {/* The hero, above the heading: one PillGuy held in the same tree
                  slot across steps 3–5, so React reuses the DOM node and moving
                  between steps never replays the entrance. It is dormant while
                  the agent is being specified and wakes on Review. */}
              {step >= 3 && step <= 5 && (
                // reducedMotion="user" defers to the OS setting, so the hero
                // arrives in place for anyone who asked for less movement. The
                // token layer zeroes the CSS durations; this covers the JS half.
                <MotionConfig reducedMotion="user">
                  {/* mb-6 continues the prototype's single rhythm past this
                      block: it groups the hero and heading, and the step's own
                      controls sit a step below on the same spacing. */}
                  <div className="mb-6 space-y-6">
                    <motion.div
                      initial={capsuleHeroMotion.initial}
                      animate={capsuleHeroMotion.animate}
                      transition={capsuleHeroMotion.transition}
                      className="flex flex-col items-center gap-2"
                    >
                      {/* Dormant until the agent is actually hired. Review is
                          the first step where one exists, so that is where it
                          wakes — the arc's payoff, not a flourish along it. */}
                      <PillGuy
                        state={step === 5 ? "alive" : "dormant"}
                        className="size-(--sz-72px)"
                      />
                      <AgentPreview agentName={agentName} agentRole="" />
                    </motion.div>

                    <OnboardingHeading
                      center
                      title={
                        step === 3
                          ? "Create your first agent"
                          : step === 4
                            ? "Connect a model"
                            : "Let's get started..."
                      }
                      // The agent step carries no lede, as the prototype has it:
                      // the capsule and the heading say what this is, and a
                      // sentence restating it only pushes the fields down.
                      lede={
                        step === 3 ? undefined : step === 4 ? (
                          <>Paperclip works with your existing subscription or API keys.</>
                        ) : (
                          <>{agentName.trim() || "Your first agent"} is ready to work!</>
                        )
                      }
                    />
                  </div>
                </MotionConfig>
              )}

              {/* Step content */}
              {step === 2 && onboardingPath === "grow" && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Sparkles className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Tell us about your team</h3>
                      <p className="text-xs text-muted-foreground">
                        We'll use this to set up your lead agent and plan which agents to add.
                      </p>
                    </div>
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What does your team work on?</label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. We create educational YouTube content about AI"
                      value={q1}
                      onChange={(e) => setQ1(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What are your current workflows?</label>
                    <textarea
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                      placeholder="e.g. Manual content creation, spreadsheet tracking, email outreach"
                      value={growWorkflows}
                      onChange={(e) => setGrowWorkflows(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What pain points would you solve with AI?</label>
                    <textarea
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                      placeholder="e.g. Can't produce content fast enough, no time for social media"
                      value={growPainPoints}
                      onChange={(e) => setGrowPainPoints(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What would you automate first?</label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. Social media scheduling and content repurposing"
                      value={growAutomate}
                      onChange={(e) => setGrowAutomate(e.target.value)}
                    />
                  </div>
                  {companyName.trim() && q1.trim() && (
                    <>
                      {!companyGoal.trim() && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const parts = [q1.trim()];
                            if (growPainPoints.trim()) parts.push(`Key challenge: ${growPainPoints.trim()}`);
                            if (growAutomate.trim()) parts.push(`First priority: automate ${growAutomate.trim().toLowerCase()}`);
                            setCompanyGoal(parts.join(". "));
                          }}
                        >
                          Generate mission from answers
                        </Button>
                      )}
                      {companyGoal.trim() && (
                        <div className="group">
                          <label className="text-xs text-foreground mb-1 block">Generated mission — edit however you like:</label>
                          <textarea
                            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                            value={companyGoal}
                            onChange={(e) => setCompanyGoal(e.target.value)}
                          />
                        </div>
                      )}
                    </>
                  )}
                  <button
                    className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => { setOnboardingPath(null); setStep(0); }}
                  >
                    ← Back to start
                  </button>
                </div>
              )}

              {/* Step 1: name the organization (both paths). One question, one
                  design: this mirrors the funnel's naming screen — same
                  question, same sub, same left-aligned heading in a centered
                  column — so a customer creating their second organization
                  in-app is asked exactly what their first one asked them. */}
              {step === 1 && (
                <div className="mx-auto w-full max-w-md space-y-6">
                  <OnboardingHeading
                    title="What is the name of your organization?"
                    lede="This will be the name of your Paperclip organization — choose something your team will recognize."
                  />
                  <div className="group">
                    <label
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        companyName.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      Name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. Northwind Labs"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && companyName.trim()) {
                          e.preventDefault();
                          if (skipsMissionStep) void handleCreateCompany();
                          else setStep(2);
                        }
                      }}
                      autoFocus
                    />
                  </div>
                  <button
                    className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => { setOnboardingPath(null); setStep(0); }}
                  >
                    ← Back to start
                  </button>
                </div>
              )}

              {/* Step 2: Define your mission */}
              {step === 2 && onboardingPath !== "grow" && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Define your mission</h3>
                      <p className="text-xs text-muted-foreground">
                        Your mission guides everything — your lead agent, who you bring on, and the work <strong>{companyName}</strong> takes on.
                      </p>
                    </div>
                  </div>

                  {/* Mission path selector */}
                  <div className="space-y-3 pt-3">
                    <label className="text-xs text-foreground block">
                      How would you like to define your mission?
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                          missionPath === "direct"
                            ? "border-foreground bg-accent/50"
                            : "border-border hover:bg-accent/50"
                        )}
                        onClick={() => setMissionPath("direct")}
                      >
                        <Sparkles className="h-4 w-4" />
                        <span className="font-medium">I know my mission</span>
                        <span className="text-muted-foreground text-(length:--text-nano)">
                          Type it directly
                        </span>
                      </button>
                      <button
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                          missionPath === "questionnaire"
                            ? "border-foreground bg-accent/50"
                            : "border-border hover:bg-accent/50"
                        )}
                        onClick={() => setMissionPath("questionnaire")}
                      >
                        <ListTodo className="h-4 w-4" />
                        <span className="font-medium">Help me figure it out</span>
                        <span className="text-muted-foreground text-(length:--text-nano)">
                          Answer a few questions
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Direct mission input */}
                  {missionPath === "direct" && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label
                          className={cn(
                            "text-xs mb-1 block transition-colors",
                            companyGoal.trim()
                              ? "text-foreground"
                              : "text-muted-foreground group-focus-within:text-foreground"
                          )}
                        >
                          Mission
                        </label>
                        <textarea
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                          placeholder="What is your team trying to achieve?"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                          autoFocus
                        />
                      </div>
                      {/* Prompt chips for inspiration */}
                      <div className="flex flex-wrap gap-1.5">
                        {MISSION_PROMPT_CHIPS.map((chip) => (
                          <button
                            key={chip}
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-(length:--text-micro) transition-colors",
                              companyGoal === chip
                                ? "border-foreground bg-accent text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/50"
                            )}
                            onClick={() => setCompanyGoal(chip)}
                          >
                            {chip}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Questionnaire path */}
                  {missionPath === "questionnaire" && !missionConfirmed && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What does your team work on?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. We create educational YouTube content about AI"
                          value={q1}
                          onChange={(e) => setQ1(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Who do you serve?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Non-technical professionals curious about AI tools"
                          value={q2}
                          onChange={(e) => setQ2(e.target.value)}
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What's your biggest bottleneck right now?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Can't produce content fast enough across multiple channels"
                          value={q3}
                          onChange={(e) => setQ3(e.target.value)}
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What would success look like in 6 months?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Publishing daily content across 4 platforms with a team of AI agents"
                          value={q4}
                          onChange={(e) => setQ4(e.target.value)}
                        />
                      </div>
                      {q1.trim() && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setCompanyGoal(buildMissionFromQuestionnaire(q1, q2, q3, q4));
                            setMissionConfirmed(true);
                          }}
                        >
                          Generate my mission
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Questionnaire result — editable mission */}
                  {missionPath === "questionnaire" && missionConfirmed && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label className="text-xs text-foreground mb-1 block">
                          Here's your draft mission — edit it however you like:
                        </label>
                        <textarea
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-80px)"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <button
                        className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => { setMissionConfirmed(false); setCompanyGoal(""); }}
                      >
                        ← Back to questions
                      </button>
                    </div>
                  )}

                  {/* Confirm mission note */}
                  {companyGoal.trim() && (
                    <p className="text-(length:--text-micro) text-muted-foreground italic">
                      You can always change your mission later in settings.
                    </p>
                  )}
                </div>
              )}

              {/* Step 3: the name, and only the name. The role picker went with
                  the question it was asking — a customer naming their first
                  agent is describing what it does, and the placeholder carries
                  the range of answers that fit. Hiring uses the neutral
                  `general` role; a specific one can be set later, where there
                  is context to choose it in. */}
              {step === 3 && (
                <div className="mx-auto flex w-full max-w-(--sz-320px) flex-col gap-6">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="onboarding-agent-name">Name</Label>
                    <Input
                      id="onboarding-agent-name"
                      placeholder="e.g. Chief of staff, Designer, Ron, Clippy..."
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      autoFocus
                    />
                  </div>
                </div>
              )}

              {/* Step 4: Connect a model — adapter + model + env check (capsule above) */}
              {step === 4 && (
                <div className="space-y-5">
                  {/* The two cards are self-describing; an "Adapter type"
                      eyebrow above them named the mechanism rather than the
                      choice. */}
                  <div>
                    <div className="grid grid-cols-2 gap-2">
                      {recommendedAdapters.map((opt) => (
                        <button
                          key={opt.type}
                          className={cn(
                            "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                            adapterType === opt.type
                              ? "border-foreground bg-accent"
                              : "border-border hover:bg-accent/50"
                          )}
                          onClick={() => {
                            const nextType = opt.type;
                            setAdapterType(nextType);
                            if (nextType === "codex_local") {
                              return;
                            }
                            if (nextType === "opencode_local") {
                              setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
                              return;
                            }
                            setModel("");
                          }}
                        >
                          {/* No "Recommended" badge: it sat on both options,
                              so it recommended nothing and only added the one
                              saturated colour on the screen. */}
                          <opt.icon className="h-4 w-4" />
                          <span className="font-medium">{opt.label}</span>
                          <span className="text-muted-foreground text-(length:--text-nano)">
                            {opt.description}
                          </span>
                        </button>
                      ))}
                    </div>

                    <button
                      className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowMoreAdapters((v) => !v)}
                    >
                      <ChevronDown
                        className={cn(
                          "h-3 w-3 transition-transform",
                          showMoreAdapters ? "rotate-0" : "-rotate-90"
                        )}
                      />
                      Advanced settings
                    </button>

                    {showMoreAdapters && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        {moreAdapters.map((opt) => (
                           <button
                             key={opt.type}
                             disabled={!!opt.comingSoon}
                             className={cn(
                               "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                               opt.comingSoon
                                 ? "border-border opacity-40 cursor-not-allowed"
                                 : adapterType === opt.type
                                 ? "border-foreground bg-accent"
                                 : "border-border hover:bg-accent/50"
                             )}
                             onClick={() => {
                               if (opt.comingSoon) return;
                               const nextType = opt.type;
                              setAdapterType(nextType);
                              if (nextType === "gemini_local" && !model) {
                                setModel(DEFAULT_GEMINI_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "kimi_local" && !model) {
                                setModel(DEFAULT_KIMI_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "cursor" && !model) {
                                setModel(DEFAULT_CURSOR_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "opencode_local") {
                                setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
                                return;
                              }
                              setModel("");
                            }}
                          >
                            <opt.icon className="h-4 w-4" />
                            <span className="font-medium">{opt.label}</span>
                            <span className="text-muted-foreground text-(length:--text-nano)">
                              {opt.comingSoon
                                ? opt.disabledLabel ?? "Coming soon"
                                : opt.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Conditional adapter fields */}
                  {/* No model picker. Every adapter this step offers resolves
                      its own default (see buildAdapterConfig), so the picker
                      asked the customer to choose a model before they had any
                      way to judge one — and the agent's model is changeable
                      later, where its work gives the choice meaning. */}

                  {/* The environment check runs without being shown: Connect
                      probes the adapter before hiring (see handleGiveHeartbeat)
                      and blocks the hire on a fail. The idle card — probe
                      explainer plus a "Test now" button — is gone from this
                      step, so this block renders only when a probe has actually
                      found something: the checks the blocking error tells the
                      customer to fix have to be visible somewhere. */}
                  {isLocalAdapter && (adapterEnvError || (adapterEnvResult && adapterEnvResult.status !== "pass")) && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                      {adapterEnvError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-(length:--text-micro) text-destructive">
                          {adapterEnvError}
                        </div>
                      )}

                      {adapterEnvResult &&
                      adapterEnvResult.status === "pass" ? (
                        <div className="space-y-2 animate-in fade-in slide-in-from-bottom-1 duration-300">
                          {/* Use the shared status-chip helper with the done
                              status hue, so the pass banner derives its fill,
                              text, and border from the design tokens in both
                              modes instead of raw color values. */}
                          <div
                            className="status-chip flex items-center gap-2 rounded-md border px-2.5 py-2 text-(length:--text-micro)"
                            style={{ "--sc": "var(--status-task-done)" } as CSSProperties}
                          >
                            <Check className="size-3.5 shrink-0" />
                            <span className="font-medium">Passed</span>
                          </div>
                          {/* Show the checks on a pass too, so the target and the
                              auth signals stay visible before the hire. */}
                          <AdapterEnvironmentResult result={adapterEnvResult} />
                        </div>
                      ) : adapterEnvResult ? (
                        <AdapterEnvironmentResult result={adapterEnvResult} />
                      ) : null}

                      {shouldSuggestUnsetAnthropicApiKey && (
                        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
                          <p className="text-(length:--text-micro) text-amber-900/90 leading-relaxed">
                            Claude failed while{" "}
                            <span className="font-mono">ANTHROPIC_API_KEY</span>{" "}
                            is set. You can clear it in this adapter config
                            and retry the probe.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            disabled={
                              adapterEnvLoading || unsetAnthropicLoading
                            }
                            onClick={() => void handleUnsetAnthropicApiKey()}
                          >
                            {unsetAnthropicLoading
                              ? "Retrying..."
                              : "Unset ANTHROPIC_API_KEY"}
                          </Button>
                        </div>
                      )}

                      {adapterEnvResult && adapterEnvResult.status === "fail" && (
                        <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-(length:--text-micro) space-y-1.5">
                          <p className="font-medium">Manual debug</p>
                          <p className="text-muted-foreground font-mono break-all">
                            {adapterType === "cursor"
                              ? `${effectiveAdapterCommand} -p --mode ask --output-format json \"Respond with hello.\"`
                              : adapterType === "codex_local"
                              ? `${effectiveAdapterCommand} exec --json -`
                              : adapterType === "gemini_local"
                                ? `${effectiveAdapterCommand} --output-format json "Respond with hello."`
                              : adapterType === "kimi_local"
                                ? `${effectiveAdapterCommand} -p "Respond with hello." --output-format stream-json`
                              : adapterType === "opencode_local"
                                ? `${effectiveAdapterCommand} run --format json "Respond with hello."`
                              : `${effectiveAdapterCommand} --print - --output-format stream-json --verbose`}
                          </p>
                          <p className="text-muted-foreground">
                            Prompt:{" "}
                            <span className="font-mono">Respond with hello.</span>
                          </p>
                          {adapterType === "cursor" ||
                          adapterType === "codex_local" ||
                          adapterType === "gemini_local" ||
                          adapterType === "kimi_local" ||
                          adapterType === "opencode_local" ? (
                            <p className="text-muted-foreground">
                              If auth fails, set{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "CURSOR_API_KEY"
                                  : adapterType === "gemini_local"
                                    ? "GEMINI_API_KEY"
                                    : adapterType === "kimi_local"
                                      ? "KIMI_MODEL_NAME + KIMI_MODEL_API_KEY"
                                    : "OPENAI_API_KEY"}
                              </span>{" "}
                              in env or run{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "agent login"
                                  : adapterType === "codex_local"
                                    ? "codex login"
                                    : adapterType === "gemini_local"
                                      ? "gemini auth"
                                      : adapterType === "kimi_local"
                                        ? "kimi login"
                                      : "opencode auth login"}
                              </span>
                              .
                            </p>
                          ) : (
                            <p className="text-muted-foreground">
                              If login is required, run{" "}
                              <span className="font-mono">claude login</span>{" "}
                              and retry.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {(adapterType === "http" ||
                    adapterType === "openclaw_gateway") && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        {adapterType === "openclaw_gateway"
                          ? "Gateway URL"
                          : "Webhook URL"}
                      </label>
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                        placeholder={
                          adapterType === "openclaw_gateway"
                            ? "ws://127.0.0.1:18789"
                            : "https://..."
                        }
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Step 5: Review — lead is online (shared capsule above) */}
              {/* Step 5: nothing. The heading names the agent and says it is
                  ready, and the pill above has just woken to show it — a
                  checklist restating those in three rows only asked the
                  customer to audit work they watched happen. */}

              {/* Error */}
              {visibleError && (
                <div className="mt-3">
                  <p className="text-xs text-destructive">{visibleError}</p>
                </div>
              )}

              {isAgentArcStep && (
                <FooterNav
                  onBack={
                    canGoBackFromOnboardingStep({ currentStep: step, entryStep })
                      ? () => setStep(backStepFrom(step))
                      : undefined
                  }
                  // The prototype's cloud flow hires on this step and calls the
                  // action "Create". Here the model step sits between, so this
                  // one advances — which is exactly the distinction the
                  // prototype's own local flow draws with "Next".
                  primaryLabel={step === 3 ? "Next" : step === 4 ? "Connect" : "Get started"}
                  loadingLabel={step === 4 ? "Connecting..." : "Launching..."}
                  loading={step === 3 ? false : loading}
                  primaryDisabled={
                    step === 3
                      ? !agentName.trim()
                      : step === 4
                        ? loading || adapterEnvLoading || missionUnresolvedForHire
                        : loading || launchStateIncomplete
                  }
                  onPrimary={() => {
                    if (step === 3) setStep(4);
                    else if (step === 4) handleGiveHeartbeat();
                    else handleLaunchToDashboard();
                  }}
                />
              )}

              {/* Footer navigation */}
              {!isAgentArcStep && (
              <div className="flex items-center justify-between mt-8">
                <div>
                  {canGoBackFromOnboardingStep({ currentStep: step, entryStep }) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep(backStepFrom(step))}
                      disabled={loading}
                    >
                      <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {step === 1 && (
                    <Button
                      size="sm"
                      disabled={!companyName.trim() || loading}
                      onClick={() => {
                        if (skipsMissionStep) void handleCreateCompany();
                        else setStep(2);
                      }}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : null}
                      Continue
                      <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  )}
                  {step === 2 && (
                    <Button
                      size="sm"
                      disabled={!companyName.trim() || !companyGoal.trim() || loading}
                      onClick={handleConfirmMission}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Confirm mission"}
                    </Button>
                  )}
                  {step === 3 && (
                    <Button
                      size="sm"
                      disabled={!agentName.trim()}
                      onClick={() => setStep(4)}
                    >
                      Next
                      <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  )}
                  {step === 4 && (
                    <Button
                      size="sm"
                      disabled={
                        !agentName.trim() ||
                        loading ||
                        adapterEnvLoading ||
                        missionUnresolvedForHire
                      }
                      onClick={handleGiveHeartbeat}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Connecting..." : "Connect"}
                    </Button>
                  )}
                  {step === 5 && (
                    <Button
                      size="sm"
                      onClick={handleLaunchToDashboard}
                      disabled={loading || launchStateIncomplete}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Launching..." : "Get started"}
                    </Button>
                  )}
                </div>
              </div>
              )}
            </div>
          </div>
          )}

          {/* Right half — ASCII art (hidden on mobile, only for the team
              name + mission steps) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-muted text-muted-foreground transition-(--tp-width-opacity) duration-500 ease-in-out",
              step === 2 ? "w-1/2 opacity-100" : "w-0 opacity-0"
            )}
          >
            <AsciiArtAnimation />
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}

function AdapterEnvironmentResult({
  result
}: {
  result: AdapterEnvironmentTestResult;
}) {
  const statusLabel =
    result.status === "pass"
      ? "Passed"
      : result.status === "warn"
      ? "Warnings"
      : "Failed";
  const statusClass =
    result.status === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : result.status === "warn"
      ? "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-2.5 py-2 text-(length:--text-micro) ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-1.5 space-y-1">
        {result.checks.map((check, idx) => (
          <div
            key={`${check.code}-${idx}`}
            className="leading-relaxed break-words"
          >
            <span className="font-medium uppercase tracking-wide opacity-80">
              {check.level}
            </span>
            <span className="mx-1 opacity-60">·</span>
            <span>{check.message}</span>
            {check.detail && (
              <span className="block opacity-75 break-all">
                ({check.detail})
              </span>
            )}
            {check.hint && (
              <span className="block opacity-90 break-words">
                Hint: {check.hint}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
