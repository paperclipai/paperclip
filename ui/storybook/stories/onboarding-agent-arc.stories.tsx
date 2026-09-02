import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";
import { useEffect, useState } from "react";

import { OnboardingWizard } from "@/components/OnboardingWizard";
import { PillGuy } from "@/components/onboarding/PillGuy";
import { Stepper } from "@/components/onboarding/Stepper";
import { useCompanyListQuery } from "@/api/companies-query";
import { useDialog } from "@/context/DialogContext";
import {
  ONBOARDING_ARC_ENTRY_STEP,
  STORYBOOK_COMPANY_ID,
  clearOnboardingDraft,
  seedOnboardingDraft,
} from "../fixtures/onboardingDraft";
import {
  resetOnboardingFixtureState,
  setOnboardingFixtureState,
} from "../fixtures/onboardingEnvironment";

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
 * Seeds the draft the wizard restores from, opens it at the arc's first step,
 * and takes the draft back out again on the way past.
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
 * Every story enters here, at step 3, and the later ones walk forward. Opening
 * directly on a later step is the obvious shortcut and it is wrong: `entryStep`
 * is captured once at mount from exactly this draft, `initialStep` sets both it
 * and the current step together, and Back is offered only while
 * `currentStep > entryStep`. A story opened on step 4 is a step 4 that can never
 * show its Back button — which is not a preview of the step, it is a preview of
 * a state no customer is ever in.
 *
 * And the cleanup is not housekeeping. That same per-origin storage is shared
 * with every other story in the session: a draft left behind makes the next
 * story restore a saved step ahead of the one it asked for, so the reviewer
 * lands on a screen they did not click on and reads it as a wizard bug.
 */
function WizardArc() {
  const [seeded] = useState(() => {
    seedOnboardingDraft();
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
    openOnboarding({
      initialStep: ONBOARDING_ARC_ENTRY_STEP,
      companyId: STORYBOOK_COMPANY_ID,
    });
  }, [seeded, ready, openOnboarding]);

  if (!ready) return null;
  return <OnboardingWizard />;
}

/**
 * Every wait here is given an explicit timeout because the library's default is
 * one second, and every wait in this file outlasts it: the wizard does not mount
 * until the companies query settles, the hire runs four requests end to end. A
 * default-timeout wait gives up, the play function fails, and the story renders
 * the step it started on — which looks exactly like a story that was written to
 * open there. That is the failure this whole file exists to avoid, so it is
 * worth naming rather than inlining.
 */
const STEP_TIMEOUT_MS = 15_000;

/**
 * Presses the wizard's primary button once it is enabled, and waits for the
 * step it opens.
 *
 * The dialog is portalled to `document.body`, so the queries are scoped to the
 * body rather than to `canvasElement` — a canvas-scoped query finds an empty
 * mount point and times out.
 *
 * Waiting for `toBeEnabled` is not defensive padding. Connect stays disabled
 * through `adapterEnvLoading` and `missionUnresolvedForHire`, both of which
 * resolve from queries, so clicking on first paint clicks a dead button and the
 * story silently stops one step short of where it says it is.
 *
 * The button is queried again immediately before the click rather than reused
 * from the wait above. The wizard re-renders as those queries land, and a node
 * captured a moment earlier can be detached by the time it is clicked — a click
 * that raises no error and does nothing.
 */
async function advance(from: string, to: string) {
  await waitFor(
    () => expect(screen.getByRole("button", { name: from })).toBeEnabled(),
    { timeout: STEP_TIMEOUT_MS },
  );
  await userEvent.click(screen.getByRole("button", { name: from }));
  await screen.findByRole("button", { name: to }, { timeout: STEP_TIMEOUT_MS });
}

/**
 * Naming the organization — the step before the arc, and the one a self-hosted
 * run starts on. It carries no draft and no company: this is where a company is
 * created, so seeding either would be describing a run that had already been
 * here.
 *
 * Worth a story because it is dressed as the arc steps that follow it, and that
 * only holds if the three are looked at together. Its Back leaves the wizard's
 * steps for the front door rather than walking back through them, so it is the
 * one Back on the flow that `canGoBackFromOnboardingStep` does not decide.
 */
function NamingStep() {
  useEffect(() => clearOnboardingDraft, []);
  const companies = useCompanyListQuery();
  const ready = companies.isSuccess && companies.data !== undefined;
  const { openOnboarding } = useDialog();
  useEffect(() => {
    if (!ready) return;
    // No `companyId`: this step is where one is created, and naming the run's
    // company here would be handing it the thing it exists to ask for.
    openOnboarding({ initialStep: 1 });
  }, [ready, openOnboarding]);
  if (!ready) return null;
  return <OnboardingWizard />;
}

export const NameYourOrganization: StoryObj = {
  render: () => <NamingStep />,
};

/**
 * The arc's first step, and the one place Back is correctly absent: a run
 * entering here has nowhere behind it that belongs to it — step 1 creates a
 * company, and this run already holds one.
 */
export const CreateYourAgent: StoryObj = {
  render: () => <WizardArc />,
};

/**
 * The connect step as a signed-out cloud tenant meets it: a managed sandbox
 * resolves, and the provider sign-in panel is offered because the auth signal
 * comes back absent.
 */
export const ConnectAModel: StoryObj = {
  beforeEach: () => {
    setOnboardingFixtureState({
      environments: "managed-sandbox",
      authSignal: "absent",
    });
    return resetOnboardingFixtureState;
  },
  render: () => <WizardArc />,
  play: () => advance("Next", "Connect"),
};

/**
 * The same step once the provider is already authenticated. The sign-in panel
 * is gone — this is the only difference, and it is worth a story because the
 * panel's absence is otherwise indistinguishable from it being broken.
 */
export const ConnectAModelAlreadySignedIn: StoryObj = {
  beforeEach: () => {
    setOnboardingFixtureState({
      environments: "managed-sandbox",
      authSignal: "present",
    });
    return resetOnboardingFixtureState;
  },
  render: () => <WizardArc />,
  play: () => advance("Next", "Connect"),
};

/**
 * No managed sandbox to test against.
 *
 * This is the state a walker actually hit on staging, and the step is honest
 * about it rather than passing and stranding them later. Worth being able to
 * look at without breaking a stack to get there.
 */
export const ConnectAModelNoSandbox: StoryObj = {
  beforeEach: () => {
    setOnboardingFixtureState({ environments: "none", authSignal: "unknown" });
    return resetOnboardingFixtureState;
  },
  render: () => <WizardArc />,
  play: () => advance("Next", "Connect"),
};

/**
 * The review step, reached by hiring rather than by claiming a hire happened.
 *
 * Walking the whole arc is what makes this an honest preview of the step: the
 * Back button is offered because the run genuinely walked forward into it, and
 * `launchStateIncomplete` is satisfied because an agent genuinely exists. A
 * seeded `createdAgentId` would paint over that guard rather than clear it.
 */
export const Review: StoryObj = {
  beforeEach: () => {
    setOnboardingFixtureState({
      environments: "managed-sandbox",
      authSignal: "present",
    });
    return resetOnboardingFixtureState;
  },
  render: () => <WizardArc />,
  play: async () => {
    await advance("Next", "Connect");
    await advance("Connect", "Get started");
  },
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
        <PillGuy
          state={alive ? "alive" : "dormant"}
          className="size-(--sz-72px)"
        />
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
