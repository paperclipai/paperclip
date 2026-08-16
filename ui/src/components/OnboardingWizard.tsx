import { useEffect, useState, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { useCompanyListQuery } from "../api/companies-query";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
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
import { DEFAULT_OPENCODE_LOCAL_MODEL, isValidOpenCodeModelId } from "@paperclipai/adapter-opencode-local";
import {
  canGoBackFromOnboardingStep,
  canJumpToOnboardingStep,
  companyPrefixFromOnboardingPath,
  resolveRouteOnboardingOptions,
} from "../lib/onboarding-route";
import { useCompanyMission } from "../hooks/useCompanyMission";
import {
  isExistingCompanyMissionUnresolved,
  planMissionPersistence,
} from "../lib/onboarding-mission";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { FrontDoor } from "./FrontDoor";
import { AgentCapsule } from "./AgentCapsule";
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
  // question, and the shared company cache cannot answer it.
  //
  // `main.tsx` sets `staleTime: 30_000` for every query, so for thirty seconds
  // after a sign-in a mounted observer of the company list serves whatever is
  // cached with no request at all. `Auth.tsx` invalidates the list on sign-in,
  // but invalidation keeps serving the old data while it refetches. Neither
  // shows up as loading and neither shows up as an error, so the previous
  // account's companies arrive looking perfectly healthy - and a check that
  // trusts "not loading, no error" finds the old company id in them and hands
  // one account's onboarding draft to the next.
  //
  // Sign-out is no longer the hole it was: `useSignOut` now resets every
  // account-scoped cache entry rather than invalidating two of them, so the
  // ordinary A-signs-out-then-B-signs-in path does not leave A's companies in
  // hand.
  //
  // That covers the button, not the question. An account can change without
  // it - a session lapsing server-side, a second account signing in on a warm
  // tab, a caller supplying the company context from somewhere else - so this
  // gate stays independent of that fix rather than deferring to it.
  //
  // So this asks for a list fetched *for this mount*, rather than reading the
  // one in hand. `isFetchedAfterMount` is the part that matters; `staleTime: 0`
  // is what makes that reachable while the shared entry is still fresh. It
  // shares the query key, so the result populates the same cache entry the
  // rest of the app reads.
  const companiesQuery = useCompanyListQuery({
    staleTime: 0,
    // Only a *parseable* saved draft poses the question. Without one there is
    // nothing to authorize, and this must not add a request to every wizard
    // mount - nor make the cleanup of unreadable junk wait on an endpoint that
    // has no bearing on whether it is junk.
    enabled: rawBlob !== undefined && rawBlob !== null,
  });

  // Decidable only with a list that succeeded, was fetched since this
  // component mounted, actually arrived, and that the server was willing to
  // give us.
  //
  // `isSuccess` is what ties the answer to this session. React Query keeps the
  // last good `data` when a refetch fails, so after an account switch the
  // retained value is the *previous* account's list - but a failed refetch
  // flips status to error, so `isSuccess` rejects it. Combined with
  // `staleTime: 0`, which makes every mount refetch, and the mount gate below
  // holding while that is in flight, a success here is always this session's.
  //
  // `isFetchedAfterMount` looks like it belongs here too and does not: it is
  // true after a *failed* refetch as well, so it never rejects anything
  // `isSuccess` has not already rejected. Left out rather than kept as
  // decoration - no test could distinguish it, which is how a guard rots.
  //
  // The `unauthorized` check is the last one: `companiesListQueryOptions`
  // folds 401 and 403 into `{ companies: [], unauthorized: true }` rather than
  // throwing, so an auth blip arrives as a *successful* fetch of an empty list
  // and would otherwise read as "this account owns nothing" and delete the
  // draft.
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
  const { hasMission: routeCompanyHasMission, settled: routeMissionSettled } =
    useCompanyMission(routeMatchedCompanyId);

  // Hold the options back until the mission lookup settles, exactly as they
  // are already held back while companies load. The step below is applied once
  // and not revised, so the wizard must not open before the answer is in.
  const routeOnboardingOptions =
    (companyPrefix && companiesLoading) || !routeMissionSettled
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          companyPrefix,
          companies,
          companyHasMission: routeCompanyHasMission,
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
  const [agentName, setAgentName] = useState((saved?.agentName as string) ?? "Chief of staff");
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
      q1, q2, q3, q4, agentName, adapterType, cwd, model, command, args, url,
      createdCompanyId, createdCompanyPrefix, createdAgentId,
      createdCompanyGoalId, createdProjectId, createdIssueRef,
      onboardingPath, growWorkflows, growPainPoints, growAutomate,
    };
    onboardingDraftStorage.write(JSON.stringify(state));
  }, [
    effectiveOnboardingOpen, step, companyName, companyGoal, missionPath, missionConfirmed,
    q1, q2, q3, q4, agentName, adapterType, cwd, model, command, args, url,
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
    setAgentName("Chief of staff");
    setAdapterType("claude_local");
    setModel("");
    setCommand("");
    setArgs("");
    setUrl("");
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
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
    adapterConfigOverride?: Record<string, unknown>
  ): Promise<AdapterEnvironmentTestResult | null> {
    if (!createdCompanyId) {
      setAdapterEnvError(
        "Create or select a company before testing adapter environment."
      );
      return null;
    }
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    try {
      const result = await agentsApi.testEnvironment(
        createdCompanyId,
        adapterType,
        {
          adapterConfig: adapterConfigOverride ?? buildAdapterConfig()
        }
      );
      setAdapterEnvResult(result);
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
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
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

      if (isLocalAdapter) {
        const result = adapterEnvResult ?? (await runAdapterEnvironmentTest());
        if (!result) return;
      }

      const hire = await agentsApi.hire(createdCompanyId, {
        name: agentName.trim(),
        role: "ceo",
        adapterType,
        adapterConfig: buildAdapterConfig(),
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // Every button below is disabled while a request is in flight. The
      // keyboard has to honour the same rule, or a second Enter re-enters a
      // handler whose guard is a piece of state the first one has not set
      // yet — two goals for one mission, two agents for one hire.
      if (loading) return;
      if (step === 0) return; // front door requires click
      if (step === 1 && companyName.trim()) setStep(2);
      else if (step === 2 && companyName.trim() && companyGoal.trim()) handleConfirmMission();
      else if (step === 3 && agentName.trim()) setStep(4);
      else if (step === 4 && agentName.trim() && !missionUnresolvedForHire)
        handleGiveHeartbeat();
      else if (step === 5) handleLaunchToDashboard();
    }
  }

  if (!effectiveOnboardingOpen) return null;

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
              step === 1 || step === 2 ? "md:w-1/2" : "md:w-full"
            )}
          >
            <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
              {/* 5-segment progress bar (brand .wsteps/.wstep) — segment N
                  filled once step ≥ N. Completed segments jump back. */}
              <div className="flex items-center gap-1.5 mb-8">
                {([1, 2, 3, 4, 5] as const).map((s) => {
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

              {/* Persistent evolving capsule (steps 3–5): a single AgentCapsule
                  held in the same tree slot so React reuses the DOM node and the
                  morph reads as one capsule coming to life — dashed slot →
                  solid (configured) → liquid fill + blue glow (online). */}
              {step >= 3 && step <= 5 && (
                <div className="mb-6 space-y-4">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      {step === 5 ? (
                        <Check className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <Bot className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-medium">
                        {step === 3
                          ? "Create your first agent"
                          : step === 4
                            ? "Connect a model"
                            : "Review"}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {step === 3 ? (
                          <>
                            They'll help drive{" "}
                            <span className="font-medium text-foreground">{companyName}</span>{" "}
                            toward its mission. We default to{" "}
                            <span className="font-medium text-foreground">Chief of staff</span>.
                            Rename it to anything you like.
                          </>
                        ) : step === 4 ? (
                          <>Pick the adapter and model your lead will run on, then check the environment.</>
                        ) : (
                          <>Your first agent is online and ready to work.</>
                        )}
                      </p>
                    </div>
                  </div>

                  <div
                    className={cn(
                      "flex flex-col items-center py-1 text-center",
                      step === 5 ? "mt-8 gap-2.5" : "gap-1.5"
                    )}
                  >
                    <AgentCapsule
                      state={step === 3 ? "slot" : step === 4 ? "configured" : "online"}
                      gradient={5}
                      glow="blue"
                      size="md"
                    />
                    {step !== 3 && (
                      <p
                        className={cn(
                          "text-muted-foreground",
                          step === 5 ? "text-sm" : "text-(length:--text-micro)"
                        )}
                      >
                        {step === 4 ? (
                          "your team lead, taking shape"
                        ) : (
                          <span className="font-medium text-foreground">{agentName}</span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
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

              {/* Step 1: Name your company (both paths) */}
              {step === 1 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Name your organization</h3>
                      <p className="text-xs text-muted-foreground">
                        What should we call your team or company?
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 group">
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
                      placeholder="Acme Corp"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && companyName.trim()) {
                          e.preventDefault();
                          if (onboardingPath !== "grow" && !missionPath) setMissionPath("direct");
                          setStep(2);
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

              {/* Step 3: Create your team lead — name only (capsule above) */}
              {step === 3 && (
                <div className="space-y-5">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="Chief of staff"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && agentName.trim()) {
                          e.preventDefault();
                          setStep(4);
                        }
                      }}
                      autoFocus
                    />
                  </div>
                </div>
              )}

              {/* Step 4: Connect a model — adapter + model + env check (capsule above) */}
              {step === 4 && (
                <div className="space-y-5">
                  {/* Adapter type radio cards */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      Adapter type
                    </label>
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
                          {opt.recommended && (
                            <Badge variant="ghost" className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-(length:--text-nano) font-semibold px-1.5 leading-none">
                              Recommended
                            </Badge>
                          )}
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
                      More Agent Adapter Types
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
                  {isLocalAdapter && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Model
                        </label>
                        <Popover
                          open={modelOpen}
                          onOpenChange={(next) => {
                            setModelOpen(next);
                            if (!next) setModelSearch("");
                          }}
                        >
                          <PopoverTrigger asChild>
                            <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
                              <span
                                className={cn(
                                  !model && "text-muted-foreground"
                                )}
                              >
                                {selectedModel
                                  ? selectedModel.label
                                  : model ||
                                    (adapterType === "opencode_local"
                                      ? "Select model (required)"
                                      : "Default")}
                              </span>
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-(--radix-popover-trigger-width) p-1"
                            align="start"
                          >
                            <input
                              className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
                              placeholder="Search models..."
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              autoFocus
                            />
                            {adapterType !== "opencode_local" && (
                              <button
                                className={cn(
                                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                  !model && "bg-accent"
                                )}
                                onClick={() => {
                                  setModel("");
                                  setModelOpen(false);
                                }}
                              >
                                Default
                              </button>
                            )}
                            <div className="max-h-(--sz-240px) overflow-y-auto">
                              {groupedModels.map((group) => (
                                <div
                                  key={group.provider}
                                  className="mb-1 last:mb-0"
                                >
                                  {adapterType === "opencode_local" && (
                                    <div className="px-2 py-1 text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                                      {group.provider} ({group.entries.length})
                                    </div>
                                  )}
                                  {group.entries.map((m) => (
                                    <button
                                      key={m.id}
                                      className={cn(
                                        "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                        m.id === model && "bg-accent"
                                      )}
                                      onClick={() => {
                                        setModel(m.id);
                                        setModelOpen(false);
                                      }}
                                    >
                                      <span
                                        className="block w-full text-left truncate"
                                        title={m.id}
                                      >
                                        {adapterType === "opencode_local"
                                          ? extractModelName(m.id)
                                          : m.label}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ))}
                            </div>
                            {filteredModels.length === 0 && (
                              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                No models discovered.
                              </p>
                            )}
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                  )}

                  {isLocalAdapter && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium">
                            Adapter environment check
                          </p>
                          <p className="text-(length:--text-micro) text-muted-foreground">
                            Runs a live probe that asks the adapter CLI to
                            respond with hello.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs"
                          disabled={adapterEnvLoading}
                          onClick={() => void runAdapterEnvironmentTest()}
                        >
                          {adapterEnvLoading ? "Testing..." : "Test now"}
                        </Button>
                      </div>

                      {adapterEnvError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-(length:--text-micro) text-destructive">
                          {adapterEnvError}
                        </div>
                      )}

                      {adapterEnvResult &&
                      adapterEnvResult.status === "pass" ? (
                        <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300 animate-in fade-in slide-in-from-bottom-1 duration-300">
                          <Check className="h-3.5 w-3.5 shrink-0" />
                          <span className="font-medium">Passed</span>
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
                          adapterType === "opencode_local" ? (
                            <p className="text-muted-foreground">
                              If auth fails, set{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "CURSOR_API_KEY"
                                  : adapterType === "gemini_local"
                                    ? "GEMINI_API_KEY"
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
              {step === 5 && (
                <div className="space-y-5 py-1">
                  {/* Review checklist — everything that's now set up */}
                  <div className="space-y-1.5">
                    {[
                      { label: "Organization name", done: Boolean(companyName.trim()) },
                      { label: "Mission", done: Boolean(companyGoal.trim()) },
                      { label: "Agent created", done: Boolean(createdAgentId) },
                      { label: "Model connected", done: Boolean(createdAgentId) },
                    ].map(({ label, done }) => (
                      <div key={label} className="flex items-center gap-2 text-sm">
                        <span
                          className={cn(
                            "flex h-4 w-4 items-center justify-center rounded-full shrink-0",
                            done
                              ? "bg-green-500/15 text-green-600 dark:text-green-400"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          <Check className="h-2.5 w-2.5" />
                        </span>
                        <span className={done ? "text-foreground" : "text-muted-foreground"}>
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Error */}
              {visibleError && (
                <div className="mt-3">
                  <p className="text-xs text-destructive">{visibleError}</p>
                </div>
              )}

              {/* Footer navigation */}
              <div className="flex items-center justify-between mt-8">
                <div>
                  {canGoBackFromOnboardingStep({ currentStep: step, entryStep }) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep((step - 1) as Step)}
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
                      disabled={!companyName.trim()}
                      onClick={() => {
                        if (onboardingPath !== "grow" && !missionPath) setMissionPath("direct");
                        setStep(2);
                      }}
                    >
                      Next
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
            </div>
          </div>
          )}

          {/* Right half — ASCII art (hidden on mobile, only for the team
              name + mission steps) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-muted text-muted-foreground transition-(--tp-width-opacity) duration-500 ease-in-out",
              step === 1 || step === 2 ? "w-1/2 opacity-100" : "w-0 opacity-0"
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
