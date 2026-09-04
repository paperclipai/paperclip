import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { isValidBrowserCode } from "@paperclipai/shared";
import {
  CARD_ENTER,
  CARD_EXIT,
  CARD_EXIT_MS,
  CONNECTED_HOLD_MS,
  FOOTER_SETTLE,
  FOOTER_SETTLE_MS,
  SOURCE_COLLAPSE_MS,
  SOURCE_LINK_EXIT,
} from "./components/onboarding/onboarding-motion";

import {
  OnboardingLoginCard,
  OnboardingLoginCodeInput,
} from "./components/AdapterLoginChrome";
import { AgentPreview } from "./components/onboarding/AgentPreview";
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

/**
 * Where the sequence is.
 *
 * `loading` and `ready` are the same card at the same height — only its
 * contents differ — so the footer is pushed down once, when the card arrives,
 * and never again.
 */
type Phase =
  | "idle"
  /** The row answering: chosen tile travelling to centre, the other leaving. */
  | "collapsing"
  /** The card arriving on a spinner, pushing the footer down as it does. */
  | "loading"
  | "ready"
  | "waiting"
  | "connecting"
  /** Back, first beat: the card leaves, then the footer comes back up. */
  | "unwindCard"
  /** Back, second beat: the row reopens and the button reverts. */
  | "unwindRow"
  | "done";

/** Stand-ins for the round trips a real sign-in makes. */
const PROMPT_DELAY_MS = 1400;

const OAUTH_URL: Record<string, string> = {
  claude_local: "https://claude.ai/oauth/authorize?code=true&client=paperclip",
  codex_local: "https://auth.openai.com/codex/device",
};

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
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const mode: CredentialMode = useApiKeys ? "api" : "subscription";
  const providerName = selectedId === "codex_local" ? "OpenAI" : "Claude";
  const signInLabel = `Sign in to ${providerName}`;
  const authUrl = OAUTH_URL[selectedId ?? "claude_local"]!;

  const after = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  /*
    The sequence, one beat handing to the next.

    Each wait is the duration of the animation before it, so a beat never
    starts over the top of the one still running — which is what made the
    collapse and the card's arrival read as two unrelated things happening at
    once rather than one causing the other.
  */
  useEffect(() => {
    if (phase === "collapsing") {
      // The row finishes answering before the card starts arriving.
      after(SOURCE_COLLAPSE_MS, () => setPhase("loading"));
    } else if (phase === "loading") {
      after(PROMPT_DELAY_MS, () => setPhase("ready"));
    } else if (phase === "unwindCard") {
      // The card's own fade, then the footer's climb back up, before the row
      // is touched at all.
      after(CARD_EXIT_MS + FOOTER_SETTLE_MS, () => setPhase("unwindRow"));
    } else if (phase === "unwindRow") {
      after(SOURCE_COLLAPSE_MS, () => {
        setSelectedId(null);
        setPhase("idle");
      });
    }
  }, [phase]);

  /** Back: two beats, card first, row second. */
  const unwind = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setCode("");
    setPhase("unwindCard");
  };

  const reset = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setCode("");
    setSelectedId(null);
    setPhase("idle");
  };

  // Picking a source is what starts the sign-in — the row collapses, the link
  // goes, and the card opens on a wait, all from the one press.
  const pick = (id: string) => {
    if (phase !== "idle") return;
    setSelectedId(id);
    setPhase("collapsing");
  };

  // The paste is the answer; see the shipped panel for why it is the paste and
  // not the value. The hold after it is deliberate — `CONNECTED_HOLD_MS`.
  const pastedRef = useRef(false);
  useEffect(() => {
    if (!pastedRef.current) return;
    pastedRef.current = false;
    if (!isValidBrowserCode(code.trim())) return;
    setPhase("connecting");
    after(CONNECTED_HOLD_MS, () => setPhase("done"));
  }, [code]);

  // Collapsed from the moment a tile is pressed until the row is asked to
  // reopen — `unwindRow` is where it expands, one beat after the card left.
  const collapsed =
    selectedId !== null &&
    phase !== "idle" &&
    phase !== "unwindRow" &&
    phase !== "done";
  const cardOpen =
    phase === "loading" || phase === "ready" || phase === "waiting" || phase === "connecting";
  const done = phase === "done";

  // Four labels, three shapes. The button is only ever pressable on `ready`:
  // before that there is nothing to sign in to, and after it the sign-in is
  // happening somewhere this screen cannot hurry.
  const cta =
    // `unwindCard` keeps whatever the button said: the first beat of Back is
    // the card leaving, and changing the label at the same time would make two
    // things happen in a beat meant to carry one.
    phase === "unwindCard"
      ? { label: signInLabel, icon: "none" as const, disabled: true }
      : done
      ? { label: "Start over", icon: "arrow" as const, disabled: false }
      : phase === "ready"
        ? { label: signInLabel, icon: "none" as const, disabled: false }
        : phase === "waiting"
          ? { label: "Waiting for code", icon: "spinner" as const, disabled: true }
          : phase === "connecting"
            ? { label: "Connecting", icon: "spinner" as const, disabled: true }
            : { label: "Next", icon: "arrow" as const, disabled: true };

  return (
    <MotionConfig reducedMotion="user">
      {/* 40px inset, not 64: the sequence draws a 480px column inside the 560
          frame, wider than the arc's other steps. */}
      <div className="w-(--sz-560px) max-w-full px-10 py-10">
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
                onSelect={pick}
                collapsed={collapsed}
              />
              {/* Gone as soon as a source is picked, and faster than the row
                  collapses. Once a sign-in is running there is no switching to
                  keys without abandoning it, so leaving the control on screen
                  would invite a press that cannot be honoured. */}
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.div
                    key="credential-mode"
                    exit={{ opacity: 0, transition: SOURCE_LINK_EXIT }}
                  >
                    <CredentialModeLink
                      mode={mode}
                      onChange={(next) => setUseApiKeys(next === "api")}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/*
              The card holds its own space while it fades out — AnimatePresence
              keeps it mounted through the exit — so the footer below does not
              begin climbing until the card is genuinely gone. That is what
              makes Back read as two beats rather than one blur.
            */}
            <AnimatePresence initial={false}>
              {cardOpen && (
                <motion.div
                  key="auth-card"
                  className="mt-5"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: CARD_ENTER }}
                  exit={{ opacity: 0, transition: CARD_EXIT }}
                >
                  <OnboardingLoginCard
                    loading={phase === "loading"}
                    instruction={
                      <>
                        {/* The same destination as the button below. Two ways to
                            reach one link: the button for the customer following
                            the flow, the anchor for anyone who wants to copy it
                            into another browser. */}
                        <a
                          href={authUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          {signInLabel}
                        </a>
                        {" then come back and enter authorization code"}
                      </>
                    }
              >
                    <OnboardingLoginCodeInput
                      value={code}
                      onChange={setCode}
                      disabled={phase === "connecting"}
                      onSubmit={() => {
                        if (isValidBrowserCode(code.trim())) {
                          setPhase("connecting");
                          after(CONNECTED_HOLD_MS, () => setPhase("done"));
                        }
                      }}
                      onPaste={() => {
                        pastedRef.current = true;
                      }}
                    />
                      </OnboardingLoginCard>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}

        {/*
          Back unwinds the sign-in before it leaves the step. Once the row has
          collapsed there is a live session behind the card, and the nearest
          thing to "back" is the state before it started — the row open again,
          both sources offered. Only from there does Back mean the previous
          step.

          It is also the only way out now that the card has no Cancel of its
          own: one control, and what it undoes depends on how far in you are.
        */}
        {/* `layout`, not an animated height: the footer's position changes
            because the card above it mounted or unmounted, and letting motion
            measure that is what the canvas's own notes recommend after three
            failed attempts at animating a height directly. */}
        <motion.div layout transition={FOOTER_SETTLE}>
        <FooterNav
          onBack={() => {
            if (phase === "idle" || phase === "unwindCard" || phase === "unwindRow") return;
            unwind();
          }}
          primaryLabel={cta.label}
          primaryIcon={cta.icon}
          primaryDisabled={cta.disabled}
          onPrimary={() => {
            if (done) {
              reset();
              return;
            }
            if (phase === "ready") {
              window.open(authUrl, "_blank", "noreferrer,noopener");
              setPhase("waiting");
            }
          }}
        />
        </motion.div>

        {/* Preview-only. A real paste carries the code; here anything will do. */}
        {(phase === "ready" || phase === "waiting") && (
          <p className="pt-4 text-center text-xs text-muted-foreground/70">
            Preview: paste any text into the field to see the hold and the advance.
          </p>
        )}
      </div>
    </MotionConfig>
  );
}

/** `?state=` opens on a frame; everything stays clickable afterwards. */
const STATES: Record<string, { initialSourceId: string | null; initialPhase: Phase }> = {
  default: { initialSourceId: null, initialPhase: "idle" },
  loading: { initialSourceId: "claude_local", initialPhase: "loading" },
  ready: { initialSourceId: "claude_local", initialPhase: "ready" },
  waiting: { initialSourceId: "claude_local", initialPhase: "waiting" },
  openai: { initialSourceId: "codex_local", initialPhase: "ready" },
};

const requested = new URLSearchParams(window.location.search).get("state") ?? "default";
const initial = STATES[requested] ?? STATES.default!;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="flex min-h-dvh justify-center">
      <div className="my-auto">
        <ConnectFlowPreview {...initial} />
      </div>
    </div>
  </StrictMode>,
);
