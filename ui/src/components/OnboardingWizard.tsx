import { useEffect, useState, useMemo, useRef } from "react";
import type { ComponentType, CSSProperties } from "react";
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
import { AdapterLoginPanel } from "./AgentConfigForm";
import { secretsApi } from "../api/secrets";
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
import { SleepingZs } from "./onboarding/SleepingZs";
import {
  AGENT_ARC_WIZARD_STEPS,
  ONBOARDING_STEP_LABELS,
  ONBOARDING_WIZARD_STEPS,
  Stepper,
  agentArcStepFor,
  onboardingStepPositionFor,
} from "./onboarding/Stepper";
import { AgentPreview } from "./onboarding/AgentPreview";
import { ModelSourceTiles, type CredentialMode } from "./onboarding/ModelSourceTiles";
import { CredentialModeLink } from "./onboarding/CredentialModeLink";
import { ApiKeyField, ConnectInputCanvas } from "./onboarding/ConnectInputCanvas";
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

// First-run onboarding stays on the proven direct adapters even when an
// instance administrator has opted into Paperclip Runner elsewhere. The
// experimental flag only exposes the runner in explicit agent configuration.
const ONBOARDING_EXCLUDED_ADAPTER_TYPES = new Set([
  "process",
  "http",
  "paperclip_runner",
]);

function restoreOnboardingAdapterType(savedAdapterType: unknown): AdapterType {
  return typeof savedAdapterType === "string" && savedAdapterType !== "paperclip_runner"
    ? savedAdapterType
    : "claude_local";
}

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

/**
 * Full-colour brand marks for the sources this step offers.
 *
 * The registry's own icons are monochrome, drawn to sit in dense config UI
 * where a row of saturated logos would be noise. This step is the opposite
 * case: two large tiles carrying the whole choice, where the brand is the
 * fastest thing to recognise.
 *
 * Keyed by adapter type with a fallback, so the row stays registry-driven. An
 * adapter with no brand file here still renders — with its registry icon —
 * rather than a gap where a tile should be.
 */
const MODEL_SOURCE_BRAND_MARKS: Record<string, string> = {
  claude_local: "/brands/claude-color.svg",
};

/**
 * What the connect step calls each source.
 *
 * Deliberately not the display registry's label, which ten other surfaces read.
 * This step asks which *provider* you are signing in with — the panel under the
 * row says "Sign in to Anthropic" and "Sign in to OpenAI" — while the agent
 * config screens name the tool that runs ("Codex CLI was not found on this
 * host"). One rename in the registry would make that message say OpenAI, which
 * is vaguer, not clearer.
 *
 * It is a tension worth naming rather than hiding: DESIGN.md asks for one name
 * per concept, and this is two names for one adapter. The concepts are
 * different — vendor here, tool there — but if the product decides otherwise,
 * this map is the thing to delete.
 */
const MODEL_SOURCE_NAMES: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "OpenAI",
};

/**
 * OpenAI's blossom, inline rather than served from `/brands`.
 *
 * The supplied asset is a white fill, which was fine while this row only ever
 * sat on a dark tile. It follows the reader's system setting now, and white on
 * the light tile is invisible. Inlining lets the path take
 * `currentColor` and be legible in both, which an `<img>` cannot do.
 */
function OpenAiBlossom({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 716 716" className={className} fill="none" aria-hidden>
      <path
        fill="currentColor"
        d="M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z"
      />
    </svg>
  );
}

const MODEL_SOURCE_INLINE_MARKS: Record<string, ComponentType<{ className?: string }>> = {
  codex_local: OpenAiBlossom,
};

/**
 * The environment variable each source reads its key from.
 *
 * Named rather than described in the field above it, because the customer knows
 * which key they are holding and does not know where this step will put it. The
 * mapping already existed in this file as prose inside the environment-check
 * hint; this is the same knowledge, in a form the key field can use.
 */
const API_KEY_ENV_KEYS: Record<string, string> = {
  claude_local: ANTHROPIC_API_KEY_ENV_KEY,
  codex_local: "OPENAI_API_KEY",
};

function apiKeyEnvKeyFor(adapterType: string): string {
  return API_KEY_ENV_KEYS[adapterType] ?? "API_KEY";
}

function ModelSourceMark({
  type,
  Fallback,
}: {
  type: string;
  Fallback: ComponentType<{ className?: string }>;
}) {
  const Inline = MODEL_SOURCE_INLINE_MARKS[type];
  if (Inline) return <Inline className="size-full" />;
  const brand = MODEL_SOURCE_BRAND_MARKS[type];
  if (!brand) return <Fallback className="size-full" />;
  return <img src={brand} alt="" className="size-full" />;
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
      return window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  write(value: string): void {
    try {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, value);
    } catch {
      // Storage unavailable: the draft is simply not resumable this session.
    }
  },
  clear(): void {
    try {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
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
  // The ownership gate is closed after the initial validation succeeds, or
  // when no validation is needed. A later company-list invalidation is
  // ordinary background work. If it unmounted the inner wizard then, all of
  // its live useState values would be reconstructed from `rawBlob` above —
  // the value from page load, not the draft the customer just typed — and a
  // successful organization submission would appear to do nothing.
  //
  // A failed validation must remain retryable. A later successful fetch needs
  // to remount the wizard with the now-authorized draft, rather than keeping
  // the defaults it showed while ownership was unknown.
  const [initialDraftValidationComplete, setInitialDraftValidationComplete] = useState(
    rawBlob === undefined || rawBlob === null,
  );

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

  // A saved blob exists and its *initial* verification fetch is still in
  // flight: wait, rather than mount the inner wizard with a premature and
  // unrecoverable guess at the draft. Its ~20 `useState(saved?.x ?? default)`
  // initializers only read `saved` once. After that first mount this is a
  // background refetch, which must not tear down the customer's live state.
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
  const waitForInitialDraftValidation =
    !initialDraftValidationComplete && rawBlob !== undefined && companiesQuery.isFetching;

  useEffect(() => {
    if (
      !initialDraftValidationComplete &&
      ownershipDecidable &&
      !companiesQuery.isFetching
    ) {
      setInitialDraftValidationComplete(true);
    }
  }, [initialDraftValidationComplete, ownershipDecidable, companiesQuery.isFetching]);

  if (waitForInitialDraftValidation) {
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
  const [adapterType, setAdapterType] = useState<AdapterType>(() =>
    restoreOnboardingAdapterType(saved?.adapterType),
  );
  /**
   * Whether a model source has been chosen, as opposed to which one
   * `adapterType` happens to hold.
   *
   * The two are not the same, and reading the second as the first is what made
   * this step arrive with a tile already lit and its input already open: the
   * hire needs an adapter, so `adapterType` always carries one, restored or
   * defaulted. A customer who never touched the row could reach the end of the
   * step having chosen nothing.
   *
   * Restored true when the draft names a source. Someone returning here has
   * already answered, and asking again would throw that answer away.
   */
  const [sourcePicked, setSourcePicked] = useState<boolean>(
    () => typeof saved?.adapterType === "string" && saved.adapterType.length > 0,
  );
  const savedNativeRunnerDraft = saved?.adapterType === "paperclip_runner";
  const [cwd, setCwd] = useState((saved?.cwd as string) ?? "");
  // Native drafts may carry provider-specific configuration that is invalid
  // for the legacy adapter selected above. Keep the portable working
  // directory, but clear runner-specific execution fields while restoring.
  const [model, setModel] = useState(
    savedNativeRunnerDraft ? "" : (saved?.model as string) ?? "",
  );
  const [command, setCommand] = useState(
    savedNativeRunnerDraft ? "" : (saved?.command as string) ?? "",
  );
  const [args, setArgs] = useState(
    savedNativeRunnerDraft ? "" : (saved?.args as string) ?? "",
  );
  const [url, setUrl] = useState(
    savedNativeRunnerDraft ? "" : (saved?.url as string) ?? "",
  );
  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AdapterEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  const [showMoreAdapters, setShowMoreAdapters] = useState(false);
  /**
   * Whether the connect step is asking for a subscription sign-in or an API key.
   *
   * Restored from the draft like everything else on this step: someone who
   * picked keys, left, and came back should not be handed a sign-in panel they
   * already said no to.
   */
  const [credentialMode, setCredentialMode] = useState<CredentialMode>(
    (saved?.credentialMode as CredentialMode) ?? "subscription",
  );
  /**
   * Whether Connect has been pressed for the current source.
   *
   * The step's footer button is what starts the sign-in now, so this is the
   * whole of the difference between the card being absent and the card running:
   * the panel is mounted with `autoStart` the moment this is true, and it
   * cancels back to false. Deliberately not in the draft — a login is a live
   * server session with a deadline on it, and restoring a wizard an hour later
   * into "connecting" would be describing a session that is long gone.
   */
  const [loginStarted, setLoginStarted] = useState(false);
  /**
   * Whether that sign-in reached its success state.
   *
   * Only the displayed-code login ever sits here to be read: the browser-code
   * login advances the step from its own success, so nothing gets the chance
   * to render this. It exists because OpenAI's login finishes in another tab,
   * with nothing to type back — so the step has to wait, and the footer button
   * is where the waiting shows.
   */
  const [loginConnected, setLoginConnected] = useState(false);
  /**
   * The key itself, held only for as long as the wizard is open. It is written
   * into the adapter config at hire time and never into the draft — a draft is
   * `localStorage`, and a provider key does not belong there.
   */
  const [apiKey, setApiKey] = useState("");
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
  /**
   * The secret a key typed on this step was stored as, remembered for the key it
   * holds. Connect can be pressed more than once — a hire that fails leaves the
   * customer on the step to try again — and without this each press would store
   * another copy of the same credential.
   */
  const apiKeySecretRef = useRef<{ key: string } | null>(null);
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
      // The mode, never the key: this blob is localStorage.
      credentialMode,
      createdCompanyId, createdCompanyPrefix, createdAgentId,
      createdCompanyGoalId, createdProjectId, createdIssueRef,
      onboardingPath, growWorkflows, growPainPoints, growAutomate,
    };
    onboardingDraftStorage.write(JSON.stringify(state));
  }, [
    effectiveOnboardingOpen, step, companyName, companyGoal, missionPath, missionConfirmed,
    q1, q2, q3, q4, agentName, agentRole, adapterType, cwd, model, command, args, url,
    credentialMode,
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

  // Resolve the login environment at render time, so the wizard can decide
  // whether to show the login panel before any adapter test runs. This
  // mirrors the agent configuration form's own resolution, including the
  // managed-sandbox-only redirect (see AgentConfigForm.tsx:618-640). A render
  // must not throw, so a resolver error yields no login environment rather
  // than an error boundary.
  const { data: loginEnvironmentList = [] } = useQuery({
    queryKey: createdCompanyId
      ? queryKeys.environments.list(createdCompanyId)
      : ["environments", "none"],
    queryFn: () => environmentsApi.list(createdCompanyId!),
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 4,
  });
  const { data: instanceSettingsForLogin } = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    enabled: effectiveOnboardingOpen && step === 4,
  });
  // Wanted across the whole arc, not just the connect step. The progress strip
  // reads it too — see `enteredFromCloud` — and a value fetched only on step 4
  // would let the strip change length as the customer walked through it.
  const { data: experimentalSettingsForLogin } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: effectiveOnboardingOpen && step >= 3 && step <= 5,
  });
  const resolvedLoginEnvironmentId = useMemo(() => {
    try {
      return resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: instanceSettingsForLogin?.defaultEnvironmentId ?? null,
        localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(loginEnvironmentList),
        managedSandboxOnly: experimentalSettingsForLogin?.enableManagedSandboxOnly === true,
        managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(loginEnvironmentList),
        visibleEnvironmentIds: loginEnvironmentList.map((environment) => environment.id),
      });
    } catch {
      return null;
    }
  }, [
    instanceSettingsForLogin?.defaultEnvironmentId,
    loginEnvironmentList,
    experimentalSettingsForLogin?.enableManagedSandboxOnly,
  ]);
  const resolvedLoginEnvironment = useMemo(
    () =>
      loginEnvironmentList.find((environment) => environment.id === resolvedLoginEnvironmentId) ??
      null,
    [loginEnvironmentList, resolvedLoginEnvironmentId],
  );
  // Sandbox provider capabilities for the login pseudo-terminal gate, loaded
  // only when the adapter declares a login capability — the same query the
  // agent configuration form runs (AgentConfigForm.tsx:652-658).
  const { data: loginEnvironmentCapabilities } = useQuery({
    queryKey: createdCompanyId
      ? queryKeys.environments.capabilities(createdCompanyId)
      : ["environment-capabilities", "none"],
    queryFn: () => environmentsApi.capabilities(createdCompanyId!),
    enabled:
      Boolean(createdCompanyId) &&
      adapterCaps.login != null &&
      effectiveOnboardingOpen &&
      step === 4,
  });
  const loginEnvironmentProvider =
    typeof resolvedLoginEnvironment?.config?.provider === "string"
      ? resolvedLoginEnvironment.config.provider
      : null;
  const loginProviderSupportsPty =
    loginEnvironmentProvider != null &&
    loginEnvironmentCapabilities?.sandboxProviders?.[loginEnvironmentProvider]?.supportsLoginPty ===
      true;
  // The same capability gate the agent configuration form uses to show its
  // login panel (AgentConfigForm.tsx:1064), minus the form's fourth input — a
  // full adapter test result. The cheap auth signal below stands in for that
  // input here, so this gate alone only decides whether the login mechanism
  // could ever apply to the current adapter and environment.
  const canShowAdapterLogin = Boolean(
    adapterCaps.login != null &&
      resolvedLoginEnvironment?.driver === "sandbox" &&
      resolvedLoginEnvironmentId &&
      createdCompanyId &&
      loginProviderSupportsPty,
  );
  // The cheap signal, re-read whenever the adapter type or the resolved login
  // environment changes (both are part of the query key). It reports whether
  // the host already holds a usable credential, with no adapter environment
  // test. The route reads only host-local state, so a login baked into a
  // sandbox image rather than held on the host reads as `absent` even though
  // the owner could already sign in — the panel then shows for one extra step
  // it did not strictly need, never the reverse.
  const authSignalQuery = useQuery({
    queryKey: createdCompanyId
      ? queryKeys.agents.authSignal(createdCompanyId, adapterType, resolvedLoginEnvironmentId)
      : ["agents", "none", "auth-signal", adapterType, resolvedLoginEnvironmentId],
    queryFn: () =>
      agentsApi.getAdapterAuthSignal(
        createdCompanyId!,
        adapterType,
        resolvedLoginEnvironmentId ?? undefined,
      ),
    enabled:
      Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 4 && canShowAdapterLogin,
  });
  const authSignalStatus = authSignalQuery.data?.status ?? null;
  const showAdapterLoginPanel =
    canShowAdapterLogin && (authSignalStatus === "absent" || authSignalStatus === "unknown");
  /**
   * The signal is being fetched and has not answered yet.
   *
   * Worth its own state rather than folding into "no panel to show". Until it
   * answers, `authSignalStatus` is null and every not-signed-in customer looks
   * momentarily identical to a signed-in one — so the card would assert that
   * they are already signed in, for exactly as long as the request takes, and
   * then replace it with a sign-in prompt. A reassurance that is wrong and then
   * withdrawn is worse than saying nothing for a beat.
   */
  const authSignalUndecided = canShowAdapterLogin && authSignalStatus === null;

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
    const all = listUIAdapters()
      .filter((a) =>
        !ONBOARDING_EXCLUDED_ADAPTER_TYPES.has(a.type) &&
        !disabledTypes.has(a.type) &&
        isVisualAdapterChoice(a.type)
      )
      .map((a) => ({ ...getAdapterDisplay(a.type), type: a.type }));

    return {
      recommendedAdapters: all.filter((a) => a.recommended),
      moreAdapters: all.filter((a) => !a.recommended),
    };
  }, [disabledTypes]);

  /**
   * A source chosen from the visible row. Read off the row rather than off
   * `adapterType` alone, because a restored draft can name an adapter this step
   * no longer offers — a selection the customer cannot see.
   */
  const sourceSelected =
    sourcePicked && recommendedAdapters.some((opt) => opt.type === adapterType);

  /**
   * Whether the connect step may advance.
   *
   * One predicate, because there are two ways to advance and they drifted. The
   * button's condition and Cmd+Enter's were written out separately, so when the
   * button gained `sourceSelected` and `adapterEnvLoading` the keyboard kept the
   * older, shorter list — and hired against a source the row had never shown.
   * The same defect the button was just fixed for, one path over.
   *
   * `loading` is deliberately not here. The keyboard handler returns on it
   * before reaching any step, for a reason particular to keystrokes: a second
   * Enter re-enters a handler whose guard is state the first has not written
   * yet. That check belongs at the top of the handler, not per-step.
   *
   * Anything that gates this step belongs in here, so the next one is added
   * once rather than twice.
   */
  const connectStepReady =
    sourceSelected && !adapterEnvLoading && !missionUnresolvedForHire;

  /**
   * Whether this step has a sign-in to do before it can hire.
   *
   * The same four conditions the card itself renders on, named once so the
   * footer button and the card cannot disagree about whether a login is
   * happening. When it is false — an API key, a source already signed in on the
   * sandbox, no sandbox to sign in against — Connect goes straight to the hire,
   * exactly as it did before.
   */
  const connectStepNeedsLogin = Boolean(
    credentialMode !== "api" &&
      showAdapterLoginPanel &&
      createdCompanyId &&
      resolvedLoginEnvironmentId,
  );

  /**
   * Whether the source's login ends by taking a code back from the customer.
   *
   * This is what splits the two waits, and it is a real difference rather than
   * a cosmetic one. The browser-code login finishes here, in the field on the
   * card, so the button is busy and says so. The displayed-code login finishes
   * somewhere else entirely — another tab, possibly another device — so the
   * button is not busy, it is waiting, and a spinner would be claiming work
   * this screen is not doing.
   */
  const loginSubmitsBrowserCode =
    adapterCaps.login?.panelMode === "submitted_browser_code";

  // Connect is pressed, the login is running, and it has not succeeded yet.
  const connectStepLoggingIn =
    connectStepNeedsLogin && loginStarted && !loginConnected;

  /**
   * What the step's primary action does, for both the button and Cmd+Enter.
   *
   * One function rather than the condition written twice. The keyboard path
   * has drifted from the button here before — the comment on its `step === 4`
   * branch is about exactly that — and the gap it left was a hire that skipped
   * a check. This one would be worse: Cmd+Enter would hire before the sign-in
   * it is meant to start, against a source with no credential.
   */
  function handleConnectStepPrimary() {
    if (connectStepNeedsLogin && !loginStarted) {
      setLoginStarted(true);
      return;
    }
    void handleGiveHeartbeat();
  }

  /**
   * When the input canvas is open: exactly when a source has been chosen.
   *
   * The card is the answer to the tile that was just pressed, so an untouched
   * row leaves nothing under it — a sign-in bar offered before the question was
   * answered says the step already knows which provider is meant, which it does
   * not.
   *
   * This used to open for a pending sign-in as well, `|| showAdapterLoginPanel`,
   * so that a restored draft naming an adapter this step no longer offers still
   * had something to press. That reasoning came from when the row arrived with a
   * selection already made and an invisible one was a dead end. It is not one
   * now: the row is a question, an unofferable saved adapter simply leaves it
   * unanswered, and the visible tiles are the thing to press. `showAdapterLoginPanel`
   * still decides what goes *inside* the canvas — only not whether it exists.
   */
  /**
   * The one thing that can be wrong here before anything is pressed: there is
   * no sandbox to sign in against, so Connect cannot get anywhere. Worth saying
   * on arrival rather than after a press that goes nowhere.
   *
   * Its two neighbours in the old canvas are not worth the same. "Checking this
   * source's credentials…" narrated a request nothing was waiting on, and "this
   * source is already signed in" answered a question the customer had not asked
   * yet — both were written for a canvas that opened on selection, and the
   * press is what opens it now.
   */
  const connectStepHasNoSandbox =
    credentialMode !== "api" && !canShowAdapterLogin && !authSignalUndecided;

  /**
   * Open once there is something in it: a key field, a sign-in that has been
   * started, or the news that no sign-in is possible.
   *
   * It no longer opens on selection alone. The card is the sign-in itself now,
   * and a sign-in starts when Connect is pressed — so between picking a tile
   * and pressing the button there is nothing to put here, and the step is the
   * question and the button, which is what the design draws.
   */
  const canvasOpen =
    sourceSelected &&
    (credentialMode === "api" || loginStarted || connectStepHasNoSandbox);

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
    // The snap is not a choice. It replaces a name the customer can no longer
    // see with the first one they can, which is the right thing to hold — but
    // holding it *as chosen* would put a filled tile and an open sign-in panel
    // on a step nobody has answered, and re-create by the back door exactly the
    // preselection this step was changed to stop doing. The saved answer was
    // unofferable, so the question is open again.
    setSourcePicked(false);
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

  // Throw the cached probe away whenever the thing it probed changes. Every
  // input to `buildAdapterConfig` belongs in this list, `credentialMode` and
  // `apiKey` included: the Connect handler reuses a passing result instead of
  // re-probing, so a dependency missing here is a hire that skips the check.
  //
  // That is reachable rather than theoretical. The hire runs after the probe
  // inside one try/catch, so a hire that fails — a network error, a server
  // error — leaves the pass sitting in state. Switch to an API key, paste one,
  // press Connect again, and without these two the wizard would hire against a
  // key nothing ever tested.
  useEffect(() => {
    if (step !== 4) return;
    setAdapterEnvResult(null);
    adapterEnvResultAppliedStoredLoginRef.current = false;
    setAdapterEnvError(null);
  }, [step, adapterType, model, command, args, url, credentialMode, apiKey]);

  // A login belongs to one source in one credential mode. Switching either
  // means the card on screen is answering a question nobody asked any more, so
  // the step goes back to offering Connect. The panel is keyed on the adapter
  // as well, so it unmounts on the same change and releases its server session
  // on the way out.
  useEffect(() => {
    setLoginStarted(false);
    setLoginConnected(false);
  }, [adapterType, credentialMode]);

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

  /**
   * Whether a just-created company can still be committed to this wizard.
   *
   * Company-list refreshes can make the surrounding app adopt the POST result
   * before the continuation runs. That is the same successful transition, not
   * a takeover. A different id still means navigation moved the wizard to a
   * different organization while the request was in flight.
   */
  function canCommitCreatedCompany(
    companyIdAtStart: string | null,
    returnedCompanyId: string,
  ) {
    const companyIdNow = createdCompanyIdRef.current;
    if (companyIdNow === companyIdAtStart || companyIdNow === returnedCompanyId) {
      return true;
    }
    setError("Organization created, but onboarding switched to another organization.");
    return false;
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

  /**
   * Store the typed key as the customer's own user secret, and report whether it
   * is in place.
   *
   * A user secret rather than a company one, to match the subscription half of
   * this very step: signing in stores the Claude token as a user secret and
   * binds a `user_secret_ref`. Two credential modes on one step that scoped
   * their secrets differently would be hard to justify and easy to get wrong
   * later. It also keeps the key to the person who typed it instead of exposing
   * it to everyone with company secret access, and agent runs still resolve it
   * through the company's responsible user.
   *
   * A user secret needs a definition to hang off. The Claude token's is fixed
   * and server-owned; there is no such definition for API keys, so onboarding
   * creates one on first use. That needs company owner or admin rights, which
   * whoever just created this company in onboarding has.
   *
   * Returns false on failure, having set the error. Callers must treat false as
   * a stop: there is deliberately no path that hands the raw key back, because
   * the only thing left to do with it would be to embed it.
   */
  async function storeApiKeyUserSecret(companyId: string): Promise<boolean> {
    const key = apiKey.trim();
    const envKey = apiKeyEnvKeyFor(adapterType);
    if (apiKeySecretRef.current?.key === key) return true;
    try {
      const entries = await secretsApi.listMyUserSecrets(companyId);
      const existing = entries.find((entry) => entry.definition.key === envKey);
      const definitionId =
        existing?.definition.id ??
        (
          await secretsApi.createUserSecretDefinition(companyId, {
            key: envKey,
            name: `${envKey} for onboarding`,
            description: "Created while connecting a model during onboarding.",
          })
        ).id;
      // Rotate rather than create when a value is already stored, because
      // creating a second value for one definition is what the server refuses.
      if (existing?.secret) {
        await secretsApi.rotateMyUserSecret(companyId, existing.secret.id, { value: key });
      } else {
        await secretsApi.createMyUserSecret(companyId, {
          definitionId,
          definitionKey: envKey,
          value: key,
        });
      }
      apiKeySecretRef.current = { key };
      return true;
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not store the API key: ${err.message}`
          : "Could not store the API key.",
      );
      return false;
    }
  }

  function buildAdapterConfig(bindApiKey = false): Record<string, unknown> {
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
    // A key typed on this step is the credential the agent is being hired with,
    // so it has to reach the configuration the hire sends — and the same one the
    // environment test probes, or the test would pass on a config the hire does
    // not use. Only when the mode asks for it: leaving a stale reference in the
    // config after switching back to a subscription is what the server rejects
    // alongside the Claude OAuth binding.
    //
    // A reference, never the key itself. The adapter configuration is
    // persisted and revisioned, so a `{ type: "plain", value }` here would leave
    // a live credential at rest in every copy of it. This mirrors
    // `buildFixedClaudeOAuthBinding`, which holds a reference to the stored
    // Claude token for the same reason.
    //
    // Guarded on the caller having stored the secret, not on the key being
    // present. If storing failed this stays false, and the right outcome is a
    // configuration with no credential — which the hire then blocks on — rather
    // than one that quietly falls back to embedding the value.
    if (credentialMode === "api" && bindApiKey) {
      const env =
        typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env[apiKeyEnvKeyFor(adapterType)] = {
        type: "user_secret_ref",
        key: apiKeyEnvKeyFor(adapterType),
        version: "latest",
      };
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
    const companyIdAtStart = createdCompanyIdRef.current;
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // Same guard as the others, from the other end: nothing was in hand when
      // this started, so "unchanged" means still nothing. A route that supplied
      // a company while the request was open has taken over the wizard, and
      // adopting the company just created would fight it — and would leave the
      // customer on a company they never navigated to.
      if (!canCommitCreatedCompany(companyIdAtStart, company.id)) return;
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
    const companyIdAtStart = createdCompanyIdRef.current;
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // Nothing was in hand when this started, so "unchanged" means still
      // nothing. A route that supplied a company while the request was open has
      // taken over the wizard, and adopting the company just created would
      // fight it — and would leave the customer on a company they never
      // navigated to.
      if (!canCommitCreatedCompany(companyIdAtStart, company.id)) return;
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
    // The grid and restore path both exclude native runner. Keep this final
    // guard at the mutation boundary so a stale or modified client cannot use
    // first-run onboarding to create a native agent.
    if (adapterType === "paperclip_runner") {
      setAdapterType("claude_local");
      setModel("");
      setError("Paperclip Runner is not available during onboarding. Choose a legacy adapter.");
      return;
    }
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
      // Store the key before anything is built from it, so both the probe and the
      // hire describe it the same way — as a reference. A failure here stops the
      // hire rather than falling through to a configuration with no credential.
      let apiKeyStored = false;
      if (credentialMode === "api" && apiKey.trim()) {
        apiKeyStored = await storeApiKeyUserSecret(createdCompanyId);
        if (!apiKeyStored) return;
      }
      const baseAdapterConfig = buildAdapterConfig(apiKeyStored);
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
      // `connectStepReady`, the same predicate the step's button uses. Spelling
      // the condition out here again is what let this path hire against a
      // source the tile row had never shown, after the button was gated and
      // this was not.
      // Also gated on `connectStepLoggingIn`, the way the button is: a sign-in
      // that is already running has nothing for this to do, and re-entering it
      // would start a second server session.
      else if (
        step === 4 &&
        agentName.trim() &&
        connectStepReady &&
        !connectStepLoggingIn
      )
        handleConnectStepPrimary();
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
  /**
   * True when the organization was named in Cloud rather than here.
   *
   * `enableManagedSandboxOnly` is the cloud-tenant shape — the connect step
   * already resolves its login environment through it. A tenant wearing it did
   * not ask for the organization's name, because Cloud did, so the walk the
   * customer is on is four steps and this is the second.
   *
   * A self-hosted run that enters at the agent step is a different case with
   * the same `entryStep`: an existing company that has no agents yet. There was
   * no naming screen before it, so its walk really is three, and it keeps the
   * shorter strip.
   */
  const enteredFromCloud = experimentalSettingsForLogin?.enableManagedSandboxOnly === true;
  const showsAgentArcStepper = isAgentArcStep && entryStep >= 3 && !enteredFromCloud;

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
        {/* A deliberate hook for "the wizard mounted".

            The tests that assert it opens used to prove it by finding any text
            in the document — which, with the front door mocked to null in that
            suite, was only ever the close button's screen-reader label. Removing
            the button took the proof with it, and those tests would have gone on
            passing indefinitely if it had stayed. A named anchor says what they
            mean rather than depending on whatever happens to render. */}
        <div
          data-testid="onboarding-wizard"
          className="fixed inset-0 z-50 flex"
          onKeyDown={handleKeyDown}
        >
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
                // my-auto, not items-center on the column: they look identical
                // until a step is taller than the window, where centring by
                // alignment overflows in both directions and the top cannot be
                // scrolled to. Auto margins collapse to zero with no free space.
                "mx-auto my-auto shrink-0",
                // No card. The steps sit on the page ground rather than in a
                // bordered, filled frame — the frame was drawing a box around
                // content that is already the only thing on screen, and its
                // edge competed with the tiles' own strokes. The two branches
                // now differ only in measure. One element styled two ways, not
                // two wrappers, so the step content below renders exactly once.
                // Step 1 takes the arc's measure too. Its footer is now the
                // same pair, and a pair styled identically but sitting 96px
                // narrower than the next screen's makes the whole frame jump on
                // Continue — which is the thing that read as "off" to begin
                // with, and is more obvious once the buttons match.
                // 68px sides, so the column inside the 560px frame is 424px —
                // the measure the design draws every arc step to. It was 40px
                // (a 480px column), which is wide enough that the two model
                // tiles stretch and the name field sits under a question far
                // narrower than itself.
                isAgentArcStep || step === 1
                  ? "w-(--sz-560px) max-w-full px-8 py-10 sm:px-(--sz-64px) sm:py-11"
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
                <Stepper
                  step={onboardingStepPositionFor(step)}
                  total={ONBOARDING_WIZARD_STEPS.length}
                  labels={ONBOARDING_STEP_LABELS}
                  canJumpToStep={(target) =>
                    canJumpToOnboardingStep({
                      targetStep: ONBOARDING_WIZARD_STEPS[target - 1]!,
                      currentStep: step,
                      entryStep,
                    })
                  }
                  onJumpToStep={(target) =>
                    setStep(ONBOARDING_WIZARD_STEPS[target - 1]! as Step)
                  }
                />
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
                  {/* The gap under the agent — its name to the step's title —
                      is tighter than the step's other rows on purpose. The name
                      labels the character directly above it, so the two read as
                      one object; at the full row rhythm the name floated between
                      the character and the title and belonged to neither. 24px
                      against the 36px used elsewhere, a little over a third
                      less. `mb-9` still holds the block off the step content. */}
                  <div className="mb-9 space-y-6">
                    <motion.div
                      initial={capsuleHeroMotion.initial}
                      animate={capsuleHeroMotion.animate}
                      transition={capsuleHeroMotion.transition}
                      className="flex flex-col items-center gap-2"
                    >
                      {/* Dormant until the agent is actually hired. Review is
                          the first step where one exists, so that is where it
                          wakes — the arc's payoff, not a flourish along it. */}
                      {/* `relative` is load-bearing: the sleep marks anchor
                          to this box and travel out past its top-right
                          corner. */}
                      <div className="relative size-(--sz-72px)">
                        <PillGuy
                          state={step === 5 ? "alive" : "dormant"}
                          className="size-full"
                        />
                        {/* Only while it is actually asleep. A still grey
                            silhouette reads as a placeholder that failed to
                            load rather than as something waiting its turn. */}
                        {step < 5 && <SleepingZs />}
                      </div>
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
                          <>Paperclip works with your subscription or API keys.</>
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
                <div className="space-y-8">
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

              {/* Step 1: name the organization (both paths).
                  Dressed as the arc steps that follow it — centred heading, no
                  lede, and the same footer pair — because a customer walks
                  straight from here into them, and one screen reading as a
                  different product is more jarring than this one no longer
                  matching the funnel's naming screen exactly. The question
                  itself is still the funnel's, so the ask has not changed.

                  The lede went because it said what the field already says: a
                  labelled "Name" under "What is the name of your organization?"
                  does not need a sentence explaining that it names the
                  organization. */}
              {step === 1 && (
                <div className="mx-auto w-full space-y-9">
                  <OnboardingHeading
                    center
                    title="What is the name of your organization?"
                  />
                  {/* The field takes the agent step's measure rather than the
                      column's, so the two questions the wizard asks — name the
                      organization, name the agent — present the same target.
                      The heading stays full width above it, as it does there. */}
                  <div className="group mx-auto w-full max-w-(--sz-320px)">
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
                </div>
              )}

              {/* Step 2: Define your mission */}
              {step === 2 && onboardingPath !== "grow" && (
                <div className="space-y-8">
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
                <div className="mx-auto flex w-full flex-col gap-9">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="onboarding-agent-name">Agent name</Label>
                    {/*
                      Filled, not outlined, and the column's full width — the
                      same field the naming step before the hand-off draws.
                      `bg-muted` is the design's field surface; the default
                      Input is a hairline border over `bg-input/30`, which on
                      this ground reads as an empty outline rather than a place
                      to type. The border is kept but made transparent so the
                      focus ring, which colours the border, still has one.
                    */}
                    <Input
                      id="onboarding-agent-name"
                      className="h-(--sz-44px) rounded-lg border-transparent bg-muted shadow-none dark:bg-muted"
                      placeholder="e.g. Chief of staff"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      autoFocus
                    />
                  </div>
                </div>
              )}

              {/* Step 4: Connect a model — adapter + model + env check (capsule above) */}
              {step === 4 && (
                <div className="space-y-8">
                  {/* The two cards are self-describing; an "Adapter type"
                      eyebrow above them named the mechanism rather than the
                      choice. */}
                  <div>
                    {/* The row is `ModelSourceTiles`, the same component the
                        connect-step prototype is drawn with, so the shipped step
                        and the design under review cannot drift apart.

                        Sources come from `recommendedAdapters`, not a list
                        written here. That filter is `recommended` in the display
                        registry, which today means Claude Code and Codex and
                        nothing else — so the row stays two tiles because the
                        registry says so, and a third would appear here the day
                        someone marks one rather than the day someone remembers
                        to edit this file. */}
                    <ModelSourceTiles
                      label="Model source"
                      sources={recommendedAdapters.map((opt) => ({
                        id: opt.type,
                        // The vendor name where this step has one, the registry's
                        // tool name where it does not. `MODEL_SOURCE_NAMES` was
                        // added with the reasoning above it and then never read,
                        // so the row went on showing "Claude Code" and "Codex"
                        // — the tool names — under a heading asking which
                        // provider you are signing in to.
                        //
                        // The fallback is what keeps the row rendering if the
                        // registry ever marks a third adapter `recommended`:
                        // an unnamed source gets its tool name rather than
                        // nothing.
                        label: MODEL_SOURCE_NAMES[opt.type] ?? opt.label,
                        icon: <ModelSourceMark type={opt.type} Fallback={opt.icon} />,
                      }))}
                      mode={credentialMode}
                      selectedId={
                        sourcePicked &&
                        recommendedAdapters.some((opt) => opt.type === adapterType)
                          ? adapterType
                          : null
                      }
                      onSelect={(id) => {
                        setSourcePicked(true);
                        setAdapterType(id);
                        if (id === "codex_local") return;
                        if (id === "opencode_local") {
                          setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
                          return;
                        }
                        setModel("");
                      }}
                    />

                    {/* The credential switch stands where the adapter
                        disclosure used to. That disclosure existed to reach the
                        adapters this step does not offer, and with the row down
                        to the two that are supported it was a control whose
                        whole contents were out of scope. The question actually
                        left on this step is how the two are authenticated, so
                        that is what the line asks.

                        It names the destination rather than the state, which is
                        what a sentence has to do where a checkbox does not —
                        and it is only readable because the tiles' own tags,
                        directly above, say where you are. */}
                    <div className="-ml-3 mt-1">
                      <CredentialModeLink
                        mode={credentialMode}
                        onChange={setCredentialMode}
                      />
                    </div>

                  </div>

                  {/* One canvas under the tiles, holding whatever the current
                      choice needs: a browser-code login for Claude, a
                      displayed-code login for Codex, or a key field for either
                      when the mode is keys. Four inputs, one place — so the
                      Connect button below does not move every time the answer
                      changes.

                      Closed until a source is picked. `contentKey` is the
                      source and the mode together, because either one changing
                      means a different input, and that is what the canvas
                      swaps on. */}
                  <ConnectInputCanvas
                    open={canvasOpen}
                    contentKey={`${adapterType}:${credentialMode}`}
                  >
                    {credentialMode === "api" ? (
                      <ApiKeyField
                        envKey={apiKeyEnvKeyFor(adapterType)}
                        value={apiKey}
                        onChange={setApiKey}
                      />
                    ) : showAdapterLoginPanel &&
                      createdCompanyId &&
                      resolvedLoginEnvironmentId ? (
                      /* The same panel the agent configuration form shows after
                         a test — see AdapterLoginPanel in AgentConfigForm.tsx —
                         in the connect step's chrome and driven by the step's
                         own footer button. `autoStart` is that button: mounting
                         only happens once Connect is pressed, so the press has
                         already been taken by the time the panel exists.

                         No "Use saved login" control: the hire step already
                         applies a stored login on its own. */
                      <AdapterLoginPanel
                        key={`${adapterType}:${resolvedLoginEnvironmentId}`}
                        companyId={createdCompanyId}
                        adapterType={adapterType}
                        environmentId={resolvedLoginEnvironmentId}
                        chrome="onboarding"
                        autoStart
                        onCancel={() => setLoginStarted(false)}
                        onConnected={() => {
                          setLoginConnected(true);
                          // The browser-code login ends here, on this screen,
                          // so the step moves on by itself — there is no
                          // success state to sit on, and one would be a screen
                          // whose only content is that you may continue.
                          //
                          // The displayed-code login does not: it is still
                          // running in another tab when this fires, and the
                          // customer's attention is there. It waits for the
                          // press, which is what the enabled Next is for.
                          if (loginSubmitsBrowserCode) void handleGiveHeartbeat();
                        }}
                        onStored={() => {
                          queryClient.invalidateQueries({
                            queryKey: queryKeys.agents.authSignal(
                              createdCompanyId,
                              adapterType,
                              resolvedLoginEnvironmentId,
                            ),
                          });
                        }}
                      />
                    ) : (
                      /* The canvas only opens without a panel for one reason
                         now — `connectStepHasNoSandbox` — and it is the reason
                         worth saying out loud, because it is the one that makes
                         Connect a dead press.

                         Its two former neighbours are gone with the canvas that
                         opened on selection: "already signed in" reassured
                         against a question nobody had asked, and "checking…"
                         narrated a request the customer was not waiting on.
                         Neither survives a canvas that opens on a press. */
                      <p className="text-xs text-muted-foreground">
                        No managed sandbox is available to sign in against yet.
                      </p>
                    )}
                  </ConnectInputCanvas>

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

              {/* Step 1 shares the arc's footer so the pair keeps its shape and
                  position from the first screen onward. Its Back is the only one
                  that leaves the wizard's steps rather than walking them: step 1
                  is where a company is named, and behind it is the path chooser,
                  so `canGoBackFromOnboardingStep` — which bounds a run to the
                  steps it entered on — does not decide this one. */}
              {(isAgentArcStep || step === 1) && (
                <FooterNav
                  onBack={
                    step === 1
                      ? () => {
                          setOnboardingPath(null);
                          setStep(0);
                        }
                      : canGoBackFromOnboardingStep({ currentStep: step, entryStep })
                        ? () => setStep(backStepFrom(step))
                        : undefined
                  }
                  // The prototype's cloud flow hires on this step and calls the
                  // action "Create". Here the model step sits between, so this
                  // one advances — which is exactly the distinction the
                  // prototype's own local flow draws with "Next".
                  primaryLabel={
                    step === 1
                      ? "Continue"
                      : step === 5
                        ? "Get started"
                        : step === 4
                          ? // "Connect" is the step's own verb, and it is what
                            // starts the sign-in rather than what follows it.
                            //
                            // It becomes "Next" for the displayed-code login
                            // once that is running: at that point the sign-in
                            // is happening somewhere else, the button is not
                            // the thing doing it, and offering to "Connect" a
                            // second time would read as a retry.
                            connectStepLoggingIn && !loginSubmitsBrowserCode
                            ? "Next"
                            : "Connect"
                          : "Next"
                  }
                  loadingLabel={
                    step === 1
                      ? "Creating..."
                      : step === 4
                        ? "Connecting"
                        : "Launching..."
                  }
                  // The browser-code login is finished on this screen, so the
                  // button is genuinely busy for its duration and shows it. The
                  // displayed-code login is not — see `loginSubmitsBrowserCode`
                  // — so it stays a still, disabled Next instead of spinning
                  // against work happening in another tab.
                  loading={
                    step === 3
                      ? false
                      : loading || (connectStepLoggingIn && loginSubmitsBrowserCode)
                  }
                  primaryDisabled={
                    step === 1
                      ? !companyName.trim() || loading
                      : step === 3
                        ? !agentName.trim()
                        : step === 4
                          ? // Nothing is chosen on arrival, so the step cannot
                            // advance until something is. Without this a customer
                            // could pass the model step having touched none of
                            // it, and be hired against whatever the draft
                            // happened to carry. See `connectStepReady`, which
                            // Cmd+Enter asks as well.
                            !connectStepReady ||
                            loading ||
                            // A sign-in is running and has not landed. Nothing
                            // to press until it does.
                            connectStepLoggingIn
                          : loading || launchStateIncomplete
                  }
                  onPrimary={() => {
                    if (step === 1) {
                      if (skipsMissionStep) void handleCreateCompany();
                      else setStep(2);
                    } else if (step === 3) setStep(4);
                    // One button, two jobs — start the sign-in, or hire — and
                    // Cmd+Enter has to do the same thing. See
                    // `handleConnectStepPrimary`.
                    else if (step === 4) handleConnectStepPrimary();
                    else handleLaunchToDashboard();
                  }}
                />
              )}

              {/* Footer navigation for the steps that still use the old pair. */}
              {!isAgentArcStep && step !== 1 && (
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
