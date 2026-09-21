import { useState } from "react";
import { SlackAvatarStep as AvatarStep } from "@/pages/apps/chat/SlackAvatarStep";
import { Button } from "@/components/ui/button";
import { SetupWizardNavigation } from "@/components/SetupWizard";
import avatar from "./ceo-cliptoon.png";

const labels = [
  "Choose agent",
  "Create Slack app",
  "Add credentials",
  "Verify Slack connection",
  "Add avatar",
  "Connect your Slack account",
  "Try it",
];

/** Design preview: the PNG uses the production Cliptoon renderer; wizard state is local. */
export function SlackAvatarStep({
  agentName = "CEO",
  appName = "ceo-paperclip",
  initialUploaded = false,
}: {
  agentName?: string;
  appName?: string;
  initialUploaded?: boolean;
}) {
  const [step, setStep] = useState(4);
  const [uploaded, setUploaded] = useState(initialUploaded);
  const [exited, setExited] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-6 py-4 text-sm">
        <span className="text-muted-foreground">Connectors</span>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span>Connect Slack</span>
      </header>
      <div className="flex flex-col md:flex-row">
        <details className="border-b border-border p-4 md:hidden">
          <summary className="cursor-pointer text-sm font-medium">
            Step {step + 1} of {labels.length} · {labels[step]}
          </summary>
          <div className="pt-4">
            <SetupWizardNavigation
              inline
              labels={labels}
              step={step}
              availableStep={Math.max(4, step)}
              onSelect={(next) => {
                setStep(next);
                setExited(false);
              }}
            />
          </div>
        </details>
        <aside className="hidden shrink-0 border-r border-border p-6 md:block md:w-64">
          <SetupWizardNavigation
            inline
            labels={labels}
            step={step}
            availableStep={Math.max(4, step)}
            onSelect={(next) => {
              setStep(next);
              setExited(false);
            }}
          />
        </aside>
        <main className="min-w-0 flex-1 p-6 md:p-8">
          <div className="max-w-2xl space-y-8">
            {step === 4 && !exited ? (
              <AvatarStep
                agentName={agentName}
                appName={appName}
                avatarUrl={avatar}
                uploaded={uploaded}
                onUploaded={() => {
                  setUploaded(true);
                  setStep(5);
                }}
                onSkip={() => setStep(5)}
                onSaveExit={() => setExited(true)}
              />
            ) : (
              <>
                <h1 className="text-xl font-bold">
                  {exited ? "Setup paused" : labels[step]}
                </h1>
                <p role="status" className="text-sm text-muted-foreground">
                  {exited
                    ? "Preview only: Save & exit would save your place and return to Connectors."
                    : step === 5
                      ? "Next, link your personal Slack account to Paperclip. This preview stops at the handoff to that step."
                      : "This preview focuses on the new avatar step. Existing setup steps keep their current behavior."}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep(4);
                    setExited(false);
                  }}
                >
                  Back to avatar step
                </Button>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
