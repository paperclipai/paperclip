import { cn } from "../../lib/utils";

/**
 * The agent arc — create the agent, connect it, review — is the part of the
 * wizard a customer walks as a numbered sequence. Company creation happens in
 * Cloud before the tenant is ever reached, so it is not one of these steps.
 */
export const AGENT_ARC_TOTAL_STEPS = 3;

/**
 * What each segment goes to. These are the labels assistive tech reads, in
 * place of a bare number: the wizard has its own step numbering, and two
 * controls both announcing "Step 1" while meaning different steps is worse
 * than no number at all. The visible "Step N of 3" line carries the count.
 */
export const AGENT_ARC_STEP_LABELS = [
  "Create your first agent",
  "Connect a model",
  "Review",
] as const;

/** Wizard step numbers that make up the arc, in order. */
export const AGENT_ARC_WIZARD_STEPS = [3, 4, 5] as const;

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

/**
 * Segmented progress strip with a "Step N of M" label.
 *
 * Segments double as the way back to a step already completed, which is the
 * affordance the wizard's full-length bar provides outside the arc. A segment
 * the customer may not return to stays a disabled button rather than
 * disappearing: the wizard can be entered partway in, and a strip that simply
 * omitted the steps behind the entry point would misreport how far along they
 * are.
 */
export function Stepper({
  step,
  total = AGENT_ARC_TOTAL_STEPS,
  canJumpToStep,
  onJumpToStep,
}: {
  step: number;
  total?: number;
  canJumpToStep?: (target: number) => boolean;
  onJumpToStep?: (target: number) => void;
}) {
  return (
    <div className="mb-7 flex flex-col gap-3.5">
      <div className="flex items-center gap-2">
        {Array.from({ length: total }, (_, index) => index + 1).map((segment) => {
          const jumpable = Boolean(canJumpToStep?.(segment) && onJumpToStep);
          return (
            <button
              key={segment}
              type="button"
              aria-label={AGENT_ARC_STEP_LABELS[segment - 1] ?? `Step ${segment}`}
              aria-current={segment === step ? "step" : undefined}
              disabled={!jumpable}
              onClick={() => jumpable && onJumpToStep?.(segment)}
              className={cn(
                "h-(--sz-3px) flex-1 rounded-full transition-colors",
                segment <= step ? "bg-foreground" : "bg-border",
                jumpable ? "cursor-pointer" : "cursor-default",
              )}
            />
          );
        })}
      </div>
      <span className="text-(length:--text-micro) font-medium uppercase tracking-widest text-muted-foreground">
        Step {step} of {total}
      </span>
    </div>
  );
}
