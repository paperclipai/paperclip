// Cloud onboarding flow — the thin container that owns state + backend wiring
// and composes the shared step views inside the shared OnboardingScaffold.
// Advances Start → Company → Agent → Task, then launches the first task and
// opens the dashboard. The local flow (LocalOnboardingFlow) reuses the same
// shared steps + shell and inserts its extra steps.
import { useState } from "react";
import { useNavigate } from "@/lib/router";
import { useOnboardingFlow } from "@/hooks/useOnboardingFlow";
import { firstTaskPayload, ROLE_ACRONYMS, type FirstTaskChoice } from "./onboarding-data";
import { OnboardingScaffold } from "./OnboardingScaffold";
import { StartStep } from "./steps/StartStep";
import { CompanyStep } from "./steps/CompanyStep";
import { AgentStep } from "./steps/AgentStep";
import { TaskStep } from "./steps/TaskStep";

type Step = "start" | "company" | "agent" | "task";

const DEFAULT_ADAPTER = "claude_local";

// Numbered steps drive the Stepper position ("Step N of M").
const NUMBERED: Step[] = ["company", "agent", "task"];
function stepper(s: Step) {
  return { step: NUMBERED.indexOf(s) + 1, total: NUMBERED.length };
}

export interface CloudOnboardingFlowProps {
  /** Called when the user dismisses onboarding. */
  onClose?: () => void;
  /** Starting step. Defaults to "start". Used by the standalone preview harness. */
  initialStep?: Step;
  /**
   * Preview-only: skip all backend calls (company/agent/task creation) so the
   * flow can be clicked end-to-end without a backend. Used by the standalone
   * preview harness — never enabled in the real app.
   */
  previewMock?: boolean;
  /**
   * When set, onboarding runs against an already-created company (the "add an
   * agent to an existing company" entry): company creation is skipped and the
   * flow starts at the agent step.
   */
  existingCompany?: { id: string; prefix: string | null };
}

export function CloudOnboardingFlow({
  onClose,
  initialStep = "start",
  previewMock = false,
  existingCompany,
}: CloudOnboardingFlowProps) {
  const navigate = useNavigate();
  const flow = useOnboardingFlow(
    existingCompany
      ? { createdCompanyId: existingCompany.id, createdCompanyPrefix: existingCompany.prefix }
      : undefined,
  );

  const [step, setStep] = useState<Step>(initialStep);
  const [companyName, setCompanyName] = useState("");
  const [mission, setMission] = useState("");
  const [agentRole, setAgentRole] = useState("");
  const [agentName, setAgentName] = useState("");
  const [taskChoice, setTaskChoice] = useState<FirstTaskChoice | null>(null);
  const [customTask, setCustomTask] = useState("");

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

  async function handleCreateAgent() {
    if (previewMock) {
      setStep("task");
      return;
    }
    const result = await flow.hireLeadAgent({
      agentName: agentName || agentRole,
      adapter: { adapterType: DEFAULT_ADAPTER, model: "", command: "", args: "", url: "" },
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
      // The cloud agent step has no environment probe; keep hire simple.
      requireEnvProbe: false,
    });
    if (result) setStep("task");
  }

  async function handleGetStarted() {
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

  return (
    <OnboardingScaffold stepKey={step} onClose={onClose}>
      {step === "start" && <StartStep onSetup={() => setStep("company")} />}
      {step === "company" && (
        <CompanyStep
          {...stepper("company")}
          companyName={companyName}
          onCompanyNameChange={setCompanyName}
          mission={mission}
          onMissionChange={setMission}
          onBack={() => setStep("start")}
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
          onBack={existingCompany ? () => onClose?.() : () => setStep("company")}
          onNext={handleCreateAgent}
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
          onBack={() => setStep("agent")}
          onGetStarted={handleGetStarted}
          loading={flow.loading}
          error={flow.error}
        />
      )}
    </OnboardingScaffold>
  );
}
