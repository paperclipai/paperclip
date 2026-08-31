import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";

import { OnboardingWizard } from "@/components/OnboardingWizard";
import { PillGuy } from "@/components/onboarding/PillGuy";
import { Stepper } from "@/components/onboarding/Stepper";
import { useCompanyListQuery } from "@/api/companies-query";
import { useDialog } from "@/context/DialogContext";
import {
  STORYBOOK_COMPANY_ID,
  clearOnboardingDraft,
  seedOnboardingDraft,
} from "../fixtures/onboardingDraft";

/**
 * The onboarding wizard's agent arc: create the agent, connect a model, review.
 * These are the three steps a customer walks inside the tenant — the
 * organization is named in Cloud before they arrive, which is why the strip
 * counts to three rather than to the wizard's own step numbers.
 *
 * The step stories below mount the real wizard against the Storybook API
 * fixtures. That matters more here than in most stories: these screens only
 * render for a signed-in account that owns a provisioned stack, so before this
 * existed the only way to see them was to walk a real signup — and when the
 * connect step failed on a live stack, the review step behind it could not be
 * reached at all.
 */
const meta = {
  title: "Onboarding/Agent arc",
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;

/**
 * Seeds the draft the wizard restores from, opens it, and takes the draft back
 * out again on the way past.
 *
 * Three details the wizard's own design forces:
 *
 * The draft is written during render, not in an effect. Roughly twenty
 * `useState(saved?.x ?? default)` initializers read the restored blob exactly
 * once, on first render, so a draft written after mount arrives too late to
 * matter.
 *
 * `createdCompanyId` has to be a company the fixtures report as owned.
 * `restoreOnboardingState` treats restoring as an authorization decision and
 * discards the whole blob when the saved company is not in the list — correctly,
 * since localStorage is per-origin and would otherwise hand one account's draft
 * to another.
 *
 * Step 5 is seeded rather than requested: `openOnboarding({ initialStep })`
 * accepts 1–4 only, because the review step is somewhere the wizard arrives
 * rather than somewhere it starts.
 *
 * And the cleanup is not housekeeping. That same per-origin storage is shared
 * with every other story in the session: a draft left behind makes the next
 * story restore a saved step ahead of the one it asked for, so the reviewer
 * lands on a screen they did not click on and reads it as a wizard bug.
 */
function WizardAtStep({ step }: { step: 3 | 4 | 5 }) {
  const [seeded] = useState(() => {
    seedOnboardingDraft(step);
    return true;
  });

  useEffect(() => clearOnboardingDraft, []);

  // Nothing is mounted until the companies list has settled, and that ordering
  // is load-bearing rather than tidiness. The wizard's own mount gate waits on
  // `isFetching`, but this query is *disabled* until the account settles, and a
  // disabled query is not fetching — so mounting immediately gets an inner
  // wizard whose ~20 one-shot initializers read a null draft, take `initialStep`
  // instead, and then persist that back over the seed. A real session does not
  // hit this because the dashboard has already loaded the list by the time
  // anyone opens onboarding.
  const companies = useCompanyListQuery();
  const ready = companies.isSuccess && companies.data !== undefined;

  const { openOnboarding } = useDialog();
  useEffect(() => {
    if (!seeded || !ready) return;
    // `initialStep` is deliberately omitted for the review step. An explicit
    // option overrides the restored draft — "options take precedence over saved
    // state" is the wizard's rule, not an accident — so passing one here would
    // clamp 5 to 4 and land on Connect. Steps 3 and 4 pass it because being
    // explicit is better when the option can express the step; step 5 cannot be
    // expressed that way, so the draft carries it alone.
    openOnboarding(
      step <= 4
        ? { initialStep: step as 3 | 4, companyId: STORYBOOK_COMPANY_ID }
        : { companyId: STORYBOOK_COMPANY_ID },
    );
  }, [seeded, ready, openOnboarding, step]);

  if (!ready) return null;
  return <OnboardingWizard />;
}

export const CreateYourAgent: StoryObj = {
  render: () => <WizardAtStep step={3} />,
};

export const ConnectAModel: StoryObj = {
  render: () => <WizardAtStep step={4} />,
};

export const Review: StoryObj = {
  render: () => <WizardAtStep step={5} />,
};

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
 * The agent's two states, side by side. `dormant` waits to be configured;
 * `alive` is the hired agent on the review step.
 */
export const PillStates: StoryObj = {
  render: () => (
    <div className="flex items-center gap-12">
      {(["dormant", "alive"] as const).map((state) => (
        <div key={state} className="flex flex-col items-center gap-3">
          <PillGuy state={state} className="size-(--sz-72px)" />
          <span className="text-(length:--text-micro) uppercase tracking-widest text-muted-foreground">
            {state}
          </span>
        </div>
      ))}
    </div>
  ),
};

/**
 * The transition on its own, on a loop.
 *
 * Worth a story of its own because it is the arc's payoff and the hardest part
 * to judge from a still. The two states share a silhouette but differ in fill,
 * eye shape, and a tuft the dormant state does not have at all, so they
 * cross-fade rather than path-morph — there is no honest interpolation between
 * them, and a faked one warps the eyes through shapes the design never draws.
 */
export const PillMorph: StoryObj = {
  render: function PillMorphStory() {
    const [alive, setAlive] = useState(false);
    useEffect(() => {
      const id = setInterval(() => setAlive((v) => !v), 1800);
      return () => clearInterval(id);
    }, []);
    return (
      <div className="flex flex-col items-center gap-4">
        <PillGuy state={alive ? "alive" : "dormant"} className="size-(--sz-72px)" />
        <button
          type="button"
          onClick={() => setAlive((v) => !v)}
          className="text-(length:--text-micro) uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          {alive ? "alive" : "dormant"} — click to toggle
        </button>
      </div>
    );
  },
};
