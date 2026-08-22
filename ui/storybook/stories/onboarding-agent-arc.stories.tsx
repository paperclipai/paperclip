import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentCapsule } from "@/components/AgentCapsule";
import { Stepper } from "@/components/onboarding/Stepper";

/**
 * The onboarding wizard's agent arc: create the agent, connect it, review.
 * These are the three steps a customer walks inside the tenant — company
 * creation happens in Cloud before they arrive, which is why the strip counts
 * to three rather than to the wizard's own step numbers.
 */
const meta = {
  title: "Onboarding/Agent arc",
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;

export const ProgressStrip: StoryObj = {
  render: () => (
    <div className="w-[420px] space-y-10">
      {[1, 2, 3].map((step) => (
        <Stepper key={step} step={step} />
      ))}
    </div>
  ),
};

/**
 * The capsule's three states, which the wizard holds in one tree slot so the
 * morph reads as a single object coming to life rather than three renders.
 */
export const CapsuleStates: StoryObj = {
  render: () => (
    <div className="flex items-center gap-12">
      {(["slot", "configured", "online"] as const).map((state) => (
        <div key={state} className="flex flex-col items-center gap-3">
          <AgentCapsule state={state} gradient={5} glow="blue" size="md" strokeDraw />
          <span className="text-(length:--text-micro) uppercase tracking-widest text-muted-foreground">
            {state}
          </span>
        </div>
      ))}
    </div>
  ),
};

/**
 * The same three states rendered with the default cross-fade, for comparison
 * with the traced outline above.
 */
export const CapsuleStatesCrossfade: StoryObj = {
  render: () => (
    <div className="flex items-center gap-12">
      {(["slot", "configured", "online"] as const).map((state) => (
        <div key={state} className="flex flex-col items-center gap-3">
          <AgentCapsule state={state} gradient={5} glow="blue" size="md" />
          <span className="text-(length:--text-micro) uppercase tracking-widest text-muted-foreground">
            {state}
          </span>
        </div>
      ))}
    </div>
  ),
};
