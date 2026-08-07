// Local onboarding flow — the thin container for the local (self-hosted) app.
// Reuses the shared step views + shell (OnboardingScaffold) and inserts the
// local-only pieces: an optional email ask before the numbered steps, a
// model/adapter step after naming the agent (which runs the env probe on hire),
// and a "star us on GitHub" interstitial after "Get started".
//
// Order: Start → Email → Company(1) → Agent(2) → Adapter(3) → Task(4)
//        → [Get started] → GitHub-star interstitial → dashboard.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useOnboardingFlow } from "@/hooks/useOnboardingFlow";
import { firstTaskPayload, ROLE_ACRONYMS, type FirstTaskChoice } from "./onboarding-data";
import { OnboardingScaffold } from "./OnboardingScaffold";
import { AUTH_EXIT_DURATION, OnboardingAuthBackdrop } from "./OnboardingAuthBackdrop";
import { GithubStarInterstitial } from "./GithubStarInterstitial";
import { StartStep } from "./steps/StartStep";
import { EmailStep } from "./steps/EmailStep";
import { CompanyStep } from "./steps/CompanyStep";
import { AgentStep } from "./steps/AgentStep";
import { AdapterStep } from "./steps/AdapterStep";
import { TaskStep } from "./steps/TaskStep";

type Step = "start" | "email" | "company" | "agent" | "adapter" | "task";

const DEFAULT_ADAPTER = "claude_local";

// Numbered steps drive the Stepper position ("Step N of M").
const NUMBERED: Step[] = ["company", "agent", "adapter", "task"];
function stepper(s: Step) {
  return { step: NUMBERED.indexOf(s) + 1, total: NUMBERED.length };
}

export interface LocalOnboardingFlowProps {
  onClose?: () => void;
  initialStep?: Step;
  previewMock?: boolean;
}

export function LocalOnboardingFlow({
  onClose,
  initialStep = "start",
  previewMock = false,
}: LocalOnboardingFlowProps) {
  const navigate = useNavigate();
  const flow = useOnboardingFlow();

  const [step, setStep] = useState<Step>(initialStep);
  const [showGithubStar, setShowGithubStar] = useState(false);
  // The welcome screen is rendered by OnboardingAuthBackdrop — the same shell
  // the cloud flow's auth screens use — so leaving it plays the identical
  // hand-off: card lowers + fades while the paperclip fades out, and only once
  // that finishes does the step shell mount. "exiting" holds that gap.
  const [welcomePhase, setWelcomePhase] = useState<"welcome" | "exiting" | "done">(
    initialStep === "start" ? "welcome" : "done",
  );
  const welcomeTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(welcomeTimer.current), []);

  function leaveWelcome() {
    setWelcomePhase("exiting");
    welcomeTimer.current = window.setTimeout(() => {
      setStep("email");
      setWelcomePhase("done");
    }, AUTH_EXIT_DURATION * 1000);
  }

  const [email, setEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [mission, setMission] = useState("");
  const [agentRole, setAgentRole] = useState("");
  const [agentName, setAgentName] = useState("");
  const [adapterType, setAdapterType] = useState(DEFAULT_ADAPTER);
  const [taskChoice, setTaskChoice] = useState<FirstTaskChoice | null>(null);
  const [customTask, setCustomTask] = useState("");

  const adapterInput = { adapterType, model: "", command: "", args: "", url: "" };

  // Switching adapters invalidates the previous adapter's environment probe:
  // drop it so the retry re-probes and the step stops showing a verdict about
  // an adapter the user is no longer hiring on.
  function handleAdapterChange(value: string) {
    setAdapterType(value);
    flow.clearAdapterEnvResult();
  }

  function handleRoleChange(value: string) {
    setAgentRole(value);
    setAgentName(value in ROLE_ACRONYMS ? ROLE_ACRONYMS[value] : "");
  }

  async function handleCreateCompany() {
    if (previewMock) {
      setStep("agent");
      return;
    }
    const result = await flow.createCompanyAndGoal({ companyName, companyGoal: mission });
    if (result) setStep("agent");
  }

  // Adapter step → hire the lead agent on the chosen local adapter, requiring
  // the environment probe to pass (the local flow's key difference from cloud).
  async function handleHireAgent() {
    if (previewMock) {
      setStep("task");
      return;
    }
    const result = await flow.hireLeadAgent({
      agentName: agentName || agentRole,
      adapter: adapterInput,
      instructions: {
        companyName,
        companyGoal: mission,
        growPath: false,
        growWorkflows: "",
        growPainPoints: "",
        growAutomate: "",
        q1: "",
        q2: "",
        q3: "",
        q4: "",
      },
      requireEnvProbe: true,
    });
    if (result) setStep("task");
  }

  function handleGetStarted() {
    if (!taskChoice) return;
    setShowGithubStar(true);
  }

  // Runs from the interstitial's CTAs — the same completion as the cloud flow.
  async function completeOnboarding() {
    if (!taskChoice) return;
    if (previewMock) {
      window.alert(
        "Preview complete — in the real app this launches the first task and opens your dashboard.",
      );
      return;
    }
    const result = await flow.launchFirstTask(firstTaskPayload(taskChoice, customTask));
    if (result) {
      onClose?.();
      navigate(result.companyPrefix ? `/${result.companyPrefix}/dashboard` : "/dashboard");
    }
  }

  // Welcome screen: same shell + exit transition as the cloud auth screens.
  // The local flow skips sign-in, so this screen carries the orbiting paperclip.
  if (welcomePhase !== "done") {
    return (
      <OnboardingAuthBackdrop visible={welcomePhase === "welcome"} onClose={onClose}>
        <StartStep onSetup={leaveWelcome} />
      </OnboardingAuthBackdrop>
    );
  }

  return (
    <OnboardingScaffold stepKey={showGithubStar ? "github-star" : step} onClose={onClose}>
      {showGithubStar ? (
        <GithubStarInterstitial onContinue={completeOnboarding} />
      ) : (
        <>
          {step === "email" && (
            <EmailStep
              email={email}
              onEmailChange={setEmail}
              onContinue={() => setStep("company")}
              onSkip={() => setStep("company")}
            />
          )}
          {step === "company" && (
            <CompanyStep
              {...stepper("company")}
              companyName={companyName}
              onCompanyNameChange={setCompanyName}
              mission={mission}
              onMissionChange={setMission}
              onBack={() => setStep("email")}
              onNext={handleCreateCompany}
              loading={flow.loading}
            />
          )}
          {step === "agent" && (
            <AgentStep
              {...stepper("agent")}
              agentRole={agentRole}
              agentName={agentName}
              onRoleChange={handleRoleChange}
              onNameChange={setAgentName}
              onBack={() => setStep("company")}
              onNext={() => setStep("adapter")}
              primaryLabel="Next"
            />
          )}
          {step === "adapter" && (
            <AdapterStep
              {...stepper("adapter")}
              adapterType={adapterType}
              onAdapterChange={handleAdapterChange}
              agentName={agentName}
              agentRole={agentRole}
              onBack={() => setStep("agent")}
              onNext={handleHireAgent}
              loading={flow.loading}
            />
          )}
          {step === "task" && (
            <TaskStep
              {...stepper("task")}
              agentName={agentName}
              agentRole={agentRole}
              taskChoice={taskChoice}
              onSelectChoice={setTaskChoice}
              customTask={customTask}
              onCustomTaskChange={setCustomTask}
              onBack={() => setStep("adapter")}
              onGetStarted={handleGetStarted}
              loading={flow.loading}
              error={flow.error}
            />
          )}
        </>
      )}
    </OnboardingScaffold>
  );
}
