import { AnimatePresence, motion } from "motion/react";
import { Building2, Pencil, UserPlus } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { AgentCapsule } from "../../AgentCapsule";
import type { FirstTaskChoice } from "../onboarding-data";
import { ChoiceCard, OnboardingCard, OnboardingHeading, Stepper } from "../OnboardingPrimitives";
import { FooterNav } from "../FooterNav";
import { AgentPreview } from "../AgentPreview";
import { capsuleHeroMotion, STEP_EASE } from "../onboarding-motion";

/** Assign-the-first-task step: three choice cards + a custom-task reveal. */
export function TaskStep({
  agentName,
  agentRole,
  taskChoice,
  onSelectChoice,
  customTask,
  onCustomTaskChange,
  onBack,
  onGetStarted,
  loading,
  error,
  step,
  total,
}: {
  agentName: string;
  agentRole: string;
  taskChoice: FirstTaskChoice | null;
  onSelectChoice: (choice: FirstTaskChoice) => void;
  customTask: string;
  onCustomTaskChange: (value: string) => void;
  onBack: () => void;
  onGetStarted: () => void;
  loading?: boolean;
  error?: string | null;
  step: number;
  total?: number;
}) {
  // Sentence-initial in the lede, so the fallback is capitalized.
  const agentLabel = agentName || agentRole || "Your agent";
  return (
    <OnboardingCard>
      <Stepper step={step} total={total} />
      <div className="space-y-6">
        <div className="flex flex-col items-center gap-2">
          <motion.div {...capsuleHeroMotion}>
            <AgentCapsule
              state="online"
              gradient={5}
              glow="blue"
              size="md"
              // "Coming alive" (radial fill + outline carryover-fade) runs 2×
              // the default reveal duration here for a hero beat.
              style={{ ["--agent-cap-reveal-duration"]: "2.8s" } as React.CSSProperties}
            />
          </motion.div>
          <AgentPreview agentName={agentName} agentRole={agentRole} />
        </div>
        <OnboardingHeading
          title="Assign your agent a first task"
          lede={<>Where should we start? {agentLabel} is ready for instructions.</>}
          center
        />
        {/* The reveal sits OUTSIDE the gap-3 flex and owns its own top spacing
            (pt-3), so collapsing to height 0 leaves no phantom flex gap to snap
            away on unmount — the collapse mirrors the expand exactly. overflow
            is hidden only while animating and visible at rest so the textarea's
            focus ring isn't clipped. */}
        <div>
          <div className="flex flex-col gap-3">
            <ChoiceCard
              icon={<UserPlus className="size-5" />}
              title="Create a hiring plan"
              description="A staffing plan for the agents your team needs — roles, order, and what each one owns."
              selected={taskChoice === "hiring"}
              onClick={() => onSelectChoice("hiring")}
            />
            <ChoiceCard
              icon={<Building2 className="size-5" />}
              title="Write a team strategy doc"
              description="Turn your mission into a one-page strategy: goals, bets, and how you'll measure them."
              selected={taskChoice === "strategy"}
              onClick={() => onSelectChoice("strategy")}
            />
            <ChoiceCard
              icon={<Pencil className="size-5" />}
              title="Write your own task…"
              description="Describe anything else you want done first."
              selected={taskChoice === "custom"}
              onClick={() => onSelectChoice("custom")}
            />
          </div>
          <AnimatePresence initial={false}>
            {taskChoice === "custom" && (
              <motion.div
                key="custom-task-input"
                initial={{ height: 0, opacity: 0, overflow: "hidden" }}
                animate={{
                  height: "auto",
                  opacity: 1,
                  transitionEnd: { overflow: "visible" },
                }}
                exit={{ height: 0, opacity: 0, overflow: "hidden" }}
                transition={{ duration: 0.3, ease: STEP_EASE }}
              >
                <div className="pt-3">
                  <Textarea
                    autoFocus
                    className="min-h-(--sz-88px)"
                    placeholder="Describe the first task…"
                    value={customTask}
                    onChange={(e) => onCustomTaskChange(e.target.value)}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <FooterNav
          onBack={onBack}
          primaryLabel="Get started"
          primaryDisabled={!taskChoice || (taskChoice === "custom" && !customTask.trim())}
          loading={loading}
          loadingLabel="Launching..."
          onPrimary={onGetStarted}
        />
      </div>
    </OnboardingCard>
  );
}
