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
 * than no number at all. The strip's own "Step N of 3" line carries the count.
 */
export const AGENT_ARC_STEP_LABELS = [
  "Create your first agent",
  "Connect a model",
  "Review",
] as const;

/** Wizard step numbers that make up the arc, in order. */
export const AGENT_ARC_WIZARD_STEPS = [3, 4, 5] as const;

/**
 * The full walk, for a run that started at the front door rather than partway
 * into the arc.
 *
 * Step 2 is absent: onboarding no longer asks for the mission, so a segment for
 * it would be one the run can never fill. The run still passes *through* step 2
 * on the "grow" path, which is why position is counted rather than looked up —
 * see `onboardingStepPositionFor`.
 */
export const ONBOARDING_WIZARD_STEPS = [1, 3, 4, 5] as const;

/** Destinations for the full walk, in the same order. */
export const ONBOARDING_STEP_LABELS = [
  "Name your organization",
  "Create your first agent",
  "Connect a model",
  "Review",
] as const;

/**
 * Position in the full walk: how many of its steps are at or behind `step`.
 *
 * Counted rather than indexed because the wizard visits steps the strip does
 * not draw. On the mission step there is no segment to be "on", and an index
 * lookup would return nothing and light none of them — reporting no progress
 * from a screen the customer reached by making progress. Counting keeps the
 * strip on the last segment actually completed.
 */
export function onboardingStepPositionFor(step: number): number {
  return ONBOARDING_WIZARD_STEPS.filter((entry) => entry <= step).length;
}

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
 * Segmented progress strip: three dots, centred over the step's own centred
 * hero and heading.
 *
 * The "Step N of M" count is announced but not drawn. Three dots at this size
 * are read in a glance — there is no counting to help with — so the line was
 * spending a whole row, and the only left-aligned element on an otherwise
 * centred step, to restate what the dots already say. Assistive tech has no
 * glance, so the sentence stays in the accessibility tree.
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
  labels = AGENT_ARC_STEP_LABELS,
  canJumpToStep,
  onJumpToStep,
}: {
  step: number;
  total?: number;
  /**
   * What each segment goes to. Defaults to the arc's three; the full walk from
   * the front door passes its own four, since the same strip serves both and a
   * segment announcing "Create your first agent" on the organization step would
   * be worse than a bare number.
   */
  labels?: readonly string[];
  canJumpToStep?: (target: number) => boolean;
  onJumpToStep?: (target: number) => void;
}) {
  return (
    <div className="mb-11 flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, index) => index + 1).map((segment) => {
        const jumpable = Boolean(canJumpToStep?.(segment) && onJumpToStep);
        return (
          <button
            key={segment}
            type="button"
            aria-label={labels[segment - 1] ?? `Step ${segment}`}
            aria-current={segment === step ? "step" : undefined}
            disabled={!jumpable}
            onClick={() => jumpable && onJumpToStep?.(segment)}
            className={cn(
              // Dots, not bars: three of them, keeping the bar strip's gap so
              // the rhythm is unchanged. A full-width bar implied a continuous
              // quantity — how much of the arc is done — which three discrete
              // steps do not have. At 6px they carry the row on their own now
              // that no label sits under them.
              "size-1.5 shrink-0 rounded-full transition-colors",
              segment <= step ? "bg-foreground" : "bg-border",
              jumpable ? "cursor-pointer" : "cursor-default",
            )}
          />
        );
      })}
      {/* Out of flow, so it neither takes a row nor picks up the gap. */}
      <span className="sr-only">
        Step {step} of {total}
      </span>
    </div>
  );
}
