import { cn } from "../../lib/utils";

/**
 * The agent arc — create the agent, connect it, review — is the part of the
 * wizard a customer walks as a numbered sequence. Company creation happens in
 * Cloud before the tenant is ever reached, so it is not one of these steps.
 */
export const AGENT_ARC_TOTAL_STEPS = 3;

/** Wizard step numbers that make up the arc, in order. */
const AGENT_ARC_WIZARD_STEPS = [3, 4, 5] as const;

/**
 * Map a wizard step onto its position in the arc, or `null` when the step is
 * outside it.
 *
 * The two numbering schemes exist for different reasons and must not be
 * conflated: the wizard's own step numbers include entries the customer may
 * never see (the front door, and the company/mission steps that are skipped
 * when Cloud already created the company), while the strip counts only what
 * this leg of the walk actually shows. Deriving one from the other with
 * arithmetic would silently produce "Step 0 of 3" the first time a step is
 * inserted ahead of the arc.
 */
export function agentArcStepFor(wizardStep: number): number | null {
  const index = AGENT_ARC_WIZARD_STEPS.indexOf(wizardStep as (typeof AGENT_ARC_WIZARD_STEPS)[number]);
  return index === -1 ? null : index + 1;
}

/** Segmented progress strip with a "Step N of M" label. */
export function Stepper({ step, total = AGENT_ARC_TOTAL_STEPS }: { step: number; total?: number }) {
  return (
    <div className="mb-7 flex flex-col gap-3.5">
      <div className="flex items-center gap-2" aria-hidden="true">
        {Array.from({ length: total }, (_, index) => index + 1).map((segment) => (
          <span
            key={segment}
            className={cn(
              "h-(--sz-3px) flex-1 rounded-full transition-colors",
              segment <= step ? "bg-foreground" : "bg-border",
            )}
          />
        ))}
      </div>
      {/* The segments are decorative; this line is what a screen reader gets. */}
      <span className="text-(length:--text-micro) font-medium uppercase tracking-widest text-muted-foreground">
        Step {step} of {total}
      </span>
    </div>
  );
}
