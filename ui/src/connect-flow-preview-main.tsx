import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { isValidBrowserCode } from "@paperclipai/shared";

import {
  OnboardingLoginCard,
  OnboardingLoginCodeInput,
  OnboardingLoginCodeRow,
  OnboardingLoginUrlRow,
} from "./components/AdapterLoginChrome";
import { AgentPreview } from "./components/onboarding/AgentPreview";
import { ConnectInputCanvas } from "./components/onboarding/ConnectInputCanvas";
import { CredentialModeLink } from "./components/onboarding/CredentialModeLink";
import { FooterNav } from "./components/onboarding/FooterNav";
import {
  ModelSourceTiles,
  type CredentialMode,
  type ModelSource,
} from "./components/onboarding/ModelSourceTiles";
import { OnboardingHeading } from "./components/onboarding/OnboardingPrimitives";
import { PillGuy } from "./components/onboarding/PillGuy";
import { SleepingZs } from "./components/onboarding/SleepingZs";
import { Stepper } from "./components/onboarding/Stepper";
import "./index.css";

/**
 * Backend-free walkthrough of the connect step's sign-in, deployed so the flow
 * can be reviewed from a link rather than a checkout.
 *
 * The sibling of `connect-model-preview-main.tsx`, and the difference between
 * them is the point of this one. That page renders `ConnectModelPreview`, a
 * mock built to ask a question about the tile row. This one imports the
 * *shipped* login card, rows and field from `components/AdapterLoginChrome` —
 * the same components the wizard renders — so what is on screen is the
 * implementation rather than a drawing of it. The step's furniture around them
 * (stepper, avatar, heading, tiles, credential link, footer) is the real
 * presentational set too.
 *
 * What is faked is only the server. The three delays below stand in for a
 * session start, a prompt round trip, and the poll that lands while the
 * customer is finishing a login somewhere else. The wizard itself is not here:
 * it needs a query client, a router and a company.
 */

const PROMPT_DELAY_MS = 1200;
const SUBMIT_DELAY_MS = 900;
const POLL_DELAY_MS = 3200;

/**
 * OpenAI's blossom, inlined — the shipped step inlines it for the same reason.
 * The supplied asset is a white fill that disappears on a light tile, and only
 * an inline path can take `currentColor`. Keep in step with the copy in
 * `OnboardingWizard.tsx`.
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

const MODEL_SOURCES: ModelSource[] = [
  {
    id: "claude_local",
    label: "Claude",
    icon: <img src="/brands/claude-color.svg" alt="" className="size-full" />,
  },
  { id: "codex_local", label: "OpenAI", icon: <OpenAiBlossom className="size-full" /> },
];

/** Where the flow is. `auth` splits by source, exactly as the step does. */
type Phase = "idle" | "connecting" | "auth" | "submitting" | "done";

function ConnectFlowPreview({
  initialSourceId,
  initialPhase,
}: {
  initialSourceId: string | null;
  initialPhase: Phase;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSourceId);
  const [useApiKeys, setUseApiKeys] = useState(false);
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [code, setCode] = useState("");
  const [polled, setPolled] = useState(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const submitsBrowserCode = selectedId === "claude_local";
  const mode: CredentialMode = useApiKeys ? "api" : "subscription";

  const after = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // The prompt round trip.
  useEffect(() => {
    if (phase !== "connecting") return;
    after(PROMPT_DELAY_MS, () => setPhase("auth"));
  }, [phase]);

  // The poll that lands while the customer is away in another tab, for the
  // displayed-code login only. Armed on *reaching* `auth` rather than on
  // leaving `connecting`, so a `?state=openai` deep link arms it too — hung off
  // the transition, that link opened on a Next that never enabled.
  useEffect(() => {
    if (phase !== "auth" || submitsBrowserCode || polled) return;
    after(POLL_DELAY_MS, () => setPolled(true));
  }, [phase, submitsBrowserCode, polled]);

  const finishSubmit = () => {
    setPhase("submitting");
    after(SUBMIT_DELAY_MS, () => setPhase("done"));
  };

  // The same two-part rule the shipped panel uses: the paste arms the submit,
  // and the value gates it. Both halves matter here. Running it from the paste
  // handler alone would submit whatever was in the field *before* the paste —
  // the handler fires first — and skipping the check would advance the flow on
  // an empty or malformed paste, which is a worse lie than not previewing it,
  // since demonstrating this interaction is what the page is for.
  const pastedRef = useRef(false);
  useEffect(() => {
    if (!pastedRef.current) return;
    pastedRef.current = false;
    if (!isValidBrowserCode(code.trim())) return;
    finishSubmit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const reset = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPhase("idle");
    setCode("");
    setPolled(false);
  };

  const loggingIn = phase === "connecting" || phase === "auth" || phase === "submitting";
  const done = phase === "done";

  return (
    <MotionConfig reducedMotion="user">
      <div className="w-(--sz-560px) max-w-full p-10">
        <Stepper step={done ? 3 : 2} />

        <div className="flex flex-col items-center">
          <div className="relative size-(--sz-72px)">
            <PillGuy state={done ? "alive" : "dormant"} className="size-full" />
            {!done && <SleepingZs />}
          </div>
          <AgentPreview agentName="Ron" agentRole="" />
        </div>

        <div className="pt-6">
          <OnboardingHeading
            center
            title={done ? "Connected" : "Connect a model"}
            lede={
              done
                ? "The step advances straight to Review — there is no success screen."
                : "Paperclip works with your existing subscription or API keys."
            }
          />
        </div>

        {!done && (
          <>
            <div className="space-y-2 pt-12">
              <ModelSourceTiles
                label="Model source"
                sources={MODEL_SOURCES}
                mode={mode}
                selectedId={selectedId}
                onSelect={(id) => {
                  if (loggingIn) return;
                  setSelectedId(id);
                }}
              />
              <CredentialModeLink
                mode={mode}
                onChange={(next) => {
                  setUseApiKeys(next === "api");
                  reset();
                }}
              />
            </div>

            {/* Opens on the press, not on the selection — the card is the
                sign-in, so there is nothing to hold before one starts. */}
            <ConnectInputCanvas
              open={phase === "auth" || phase === "submitting"}
              contentKey={`${selectedId}:${mode}`}
            >
              {submitsBrowserCode ? (
                <OnboardingLoginCard
                  instruction="Open Claude link then come back and enter code"
                  onCancel={reset}
                >
                  <OnboardingLoginUrlRow url="https://claude.ai/oauth/authorize?code=true&client=paperclip&scope=all" />
                  <OnboardingLoginCodeInput
                    value={code}
                    onChange={setCode}
                    disabled={phase === "submitting"}
                    onSubmit={() => {
                      if (code.trim()) finishSubmit();
                    }}
                    onPaste={() => {
                      pastedRef.current = true;
                    }}
                  />
                </OnboardingLoginCard>
              ) : (
                <OnboardingLoginCard
                  instruction="Copy this code then open the authentication link"
                  onCancel={reset}
                >
                  {/* Code above link — see the same order in the shipped panel.
                      Pressing the link leaves for another tab that wants this
                      code, so it is read before the link is there to press. */}
                  <OnboardingLoginCodeRow code="Q2RJ-E1YIF" />
                  <OnboardingLoginUrlRow url="https://auth.openai.com/codex/device" />
                </OnboardingLoginCard>
              )}
            </ConnectInputCanvas>
          </>
        )}

        <FooterNav
          onBack={phase === "idle" ? () => {} : undefined}
          primaryLabel={
            // "Start over" is preview-only: the real step has left for Review
            // by now, and this page has nowhere to send you but back.
            done ? "Start over" : loggingIn && !submitsBrowserCode ? "Next" : "Connect"
          }
          loadingLabel="Connecting"
          // Busy only where the work is happening on this screen. The
          // displayed-code login finishes in another tab, so its button is
          // waiting rather than working, and stays still.
          loading={loggingIn && submitsBrowserCode}
          primaryDisabled={
            done ? false : selectedId === null || (loggingIn && !(polled && !submitsBrowserCode))
          }
          onPrimary={() => {
            if (done) reset();
            else if (phase === "idle") setPhase("connecting");
            else if (polled && !submitsBrowserCode) setPhase("done");
          }}
        />

        {/* Preview-only. A real paste carries the code; here anything will do. */}
        {phase === "auth" && submitsBrowserCode && (
          <p className="pt-4 text-center text-xs text-muted-foreground/70">
            Preview: paste any text into the field to see the auto-submit.
          </p>
        )}
        {phase === "auth" && !submitsBrowserCode && !polled && (
          <p className="pt-4 text-center text-xs text-muted-foreground/70">
            Preview: Next enables when the poll lands, a few seconds from now.
          </p>
        )}
      </div>
    </MotionConfig>
  );
}

/** `?state=` opens on a frame; everything stays clickable afterwards. */
const STATES: Record<string, { initialSourceId: string | null; initialPhase: Phase }> = {
  default: { initialSourceId: null, initialPhase: "idle" },
  selected: { initialSourceId: "claude_local", initialPhase: "idle" },
  connecting: { initialSourceId: "claude_local", initialPhase: "connecting" },
  claude: { initialSourceId: "claude_local", initialPhase: "auth" },
  openai: { initialSourceId: "codex_local", initialPhase: "auth" },
};

const requested = new URLSearchParams(window.location.search).get("state") ?? "default";
const initial = STATES[requested] ?? STATES.default!;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Centred against the viewport with `min-h-dvh` and `my-auto`, the way the
        sibling preview is: align-items would put the top of a too-tall step out
        of scroll reach, and auto margins collapse instead. */}
    <div className="flex min-h-dvh justify-center">
      <div className="my-auto">
        <ConnectFlowPreview {...initial} />
      </div>
    </div>
  </StrictMode>,
);
