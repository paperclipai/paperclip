import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import type { AdapterAuthSignal } from "@paperclipai/shared";

/**
 * The environment and auth state the connect step reads, as something a story
 * can choose.
 *
 * The step's provider sign-in panel is gated on four separate things — the
 * adapter declaring a login capability, a *sandbox* environment resolving, that
 * environment's provider supporting a login PTY, and the auth signal coming back
 * absent. Miss any one and the panel silently does not render, which looks
 * exactly like it having been deleted.
 *
 * That is not hypothetical: the first version of these fixtures returned an
 * empty environment list, and the sign-in panel was invisible in every story
 * because of it. So the states are named here and selected per story rather than
 * left implicit in a single hard-coded response.
 */

export type OnboardingEnvironmentState =
  /** A cloud tenant as it should be: one managed sandbox, sign-in reachable. */
  | "managed-sandbox"
  /** The broken shape seen on staging — the step can offer no place to test. */
  | "none";

export const STORYBOOK_SANDBOX_PROVIDER = "daytona";
export const STORYBOOK_SANDBOX_ENVIRONMENT_ID = "environment-storybook-sandbox";

interface FixtureState {
  environments: OnboardingEnvironmentState;
  authSignal: AdapterAuthSignal;
}

/**
 * Mutable on purpose. The fetch fixtures are installed once, before any story
 * renders, so a story cannot swap the handler — it sets what the handler reads.
 */
export const onboardingFixtureState: FixtureState = {
  environments: "managed-sandbox",
  authSignal: "absent",
};

export function setOnboardingFixtureState(next: Partial<FixtureState>): void {
  Object.assign(onboardingFixtureState, next);
}

export function resetOnboardingFixtureState(): void {
  onboardingFixtureState.environments = "managed-sandbox";
  onboardingFixtureState.authSignal = "absent";
}

/**
 * `managedByPaperclip` and a non-local driver are what `resolveManagedSandbox
 * EnvironmentId` looks for; `config.provider` is what the capability lookup keys
 * on. All three have to line up or the environment resolves and the panel still
 * does not appear.
 */
export function storybookEnvironments(): unknown[] {
  if (onboardingFixtureState.environments === "none") return [];
  return [
    {
      id: STORYBOOK_SANDBOX_ENVIRONMENT_ID,
      companyId: "company-storybook",
      name: "Managed sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: STORYBOOK_SANDBOX_PROVIDER },
      metadata: { managedByPaperclip: true },
    },
  ];
}

export function storybookEnvironmentCapabilities(): unknown {
  return {
    sandboxProviders: {
      [STORYBOOK_SANDBOX_PROVIDER]: { supportsLoginPty: true },
    },
  };
}

export function storybookAuthSignal(): { status: AdapterAuthSignal } {
  return { status: onboardingFixtureState.authSignal };
}

/**
 * The environment test, answering from the same auth state the sign-in panel
 * reads.
 *
 * This is the hire's gate, not decoration. `blocksAgentCreate` stops the hire on
 * a `fail`, and on any result — `pass` included — carrying a check whose code is
 * `adapter_auth_missing`. Both shipped adapters emit that code when a sandbox
 * target has no ready authentication, so a customer who has not signed in cannot
 * reach the review step.
 *
 * An earlier version of this fixture returned `pass` with an empty check list
 * whatever the auth state, which let Connect through with no model connected —
 * the exact defect this step exists to prevent, reproduced in the one place
 * built for catching it. A fixture that always passes cannot show a gate.
 */
export function storybookEnvironmentTest(adapterType: string): unknown {
  const authenticated = onboardingFixtureState.authSignal === "present";
  return {
    adapterType,
    // `warn` rather than `fail`: the gate is the check code, and the wizard is
    // explicit that a warn with no missing-auth check still hires. Using `fail`
    // would pass this story for the wrong reason and hide a regression in that
    // rule.
    status: authenticated ? "pass" : "warn",
    checks: authenticated
      ? []
      : [
          {
            code: ADAPTER_AUTH_MISSING_CHECK_CODE,
            status: "warn",
            title: "No working authentication",
            detail: "Sign in to the provider before hiring this agent.",
          },
        ],
    testedAt: new Date(0).toISOString(),
  };
}
