// Standalone preview harness for the onboarding flows (no app shell / left nav),
// modeled on the repo's thread-components harness.
//
// - `?flow=cloud` (default) renders CloudOnboardingFlow; `?flow=local` renders
//   LocalOnboardingFlow. Test both side-by-side in two tabs.
// - The cloud flow walks the full arc (account → OTP → welcome …). The LOCAL
//   flow has no sign-in at all — it opens on its welcome screen, which carries
//   the orbiting-paperclip backdrop the auth screens would have shown.
// - `?step=<name>` deep-links straight to one screen. Cloud: account | otp |
//   start | company | agent | task. Local: start | email | company | agent |
//   adapter | task.
//
// SAFETY: `previewMock` makes every wired CTA skip its backend call, so the
// flow is clickable end-to-end with no database writes. This harness is for
// visual review / sharing only.
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "@/lib/router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "./context/ThemeContext";
import { CompanyProvider } from "./context/CompanyContext";
import { CloudOnboardingFlow } from "./components/onboarding/CloudOnboardingFlow";
import { LocalOnboardingFlow } from "./components/onboarding/LocalOnboardingFlow";
import { AccountScreen, OtpScreen } from "./components/onboarding/OnboardingAuthScreens";
import {
  AUTH_EXIT_DURATION,
  OnboardingAuthBackdrop,
} from "./components/onboarding/OnboardingAuthBackdrop";
import "./index.css";

// "exiting" holds the gap between the auth screens fading out and the flow
// mounting, so the paperclip reaches 0% before the next screen appears.
type Phase = "account" | "otp" | "exiting" | "flow";

const params = new URLSearchParams(window.location.search);
const isLocal = params.get("flow") === "local";
const requestedStep = params.get("step");

// Step names valid within the selected flow (drives deep-link vs. auth phase).
const CLOUD_STEPS = ["start", "company", "agent", "task"] as const;
const LOCAL_STEPS = ["start", "email", "company", "agent", "adapter", "task"] as const;
const flowSteps: readonly string[] = isLocal ? LOCAL_STEPS : CLOUD_STEPS;
const isFlowStep = requestedStep !== null && flowSteps.includes(requestedStep);

const flowStart = isFlowStep ? requestedStep! : "start";
// Which phase the harness opens on. The local flow skips sign-in entirely, so
// it always opens on its welcome screen; cloud still walks account → OTP first.
const initialPhase: Phase = isLocal
  ? "flow"
  : isFlowStep
    ? "flow"
    : requestedStep === "otp"
      ? "otp"
      : "account";

function Preview() {
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const authVisible = phase === "account" || phase === "otp";
  const exitTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(exitTimer.current), []);

  // Finishing sign-in fades the auth card + orbiting paperclip all the way out
  // FIRST, and only then mounts the flow — so the backdrop is fully gone before
  // the next screen appears rather than the two overlapping.
  function finishAuth() {
    setPhase("exiting");
    exitTimer.current = window.setTimeout(
      () => setPhase("flow"),
      AUTH_EXIT_DURATION * 1000,
    );
  }

  return (
    <>
      {phase === "flow" &&
        (isLocal ? (
          <LocalOnboardingFlow initialStep={flowStart as never} previewMock onClose={() => {}} />
        ) : (
          <CloudOnboardingFlow initialStep={flowStart as never} previewMock onClose={() => {}} />
        ))}
      <OnboardingAuthBackdrop visible={authVisible}>
        {phase === "otp" ? (
          <OtpScreen email="you@company.com" onContinue={finishAuth} />
        ) : (
          <AccountScreen onContinue={() => setPhase("otp")} />
        )}
      </OnboardingAuthBackdrop>
    </>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter>
          <CompanyProvider>
            <TooltipProvider>
              <Preview />
            </TooltipProvider>
          </CompanyProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
