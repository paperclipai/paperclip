import { useQuery } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { queryKeys } from "../lib/queryKeys";
import { selectDefaultCompanyGoalId } from "../lib/onboarding-launch";
import {
  selectExistingCompanyMission,
  type ExistingCompanyMission,
} from "../lib/onboarding-mission";

/**
 * Whether a company already has its mission, for deciding which onboarding
 * step it belongs on.
 *
 * A company created by Paperclip Cloud does have one: Cloud collects the
 * mission at signup and the tenant writes it as a company-level goal. Opening
 * such a company on the mission step asks the customer something they answered
 * minutes earlier on another origin.
 *
 * `settled` says whether the answer can be acted on. Callers wait for it
 * before opening the wizard, because the wizard applies a step once, when it
 * opens, and does not revise it afterwards — see the sync effect in
 * `OnboardingWizard`. A step decided before the lookup finishes would be the
 * step the customer is left on.
 *
 * Settled, not answered, on purpose. A gate that waits for the data itself
 * fails closed: a goals request that exhausts its retries leaves the value
 * undefined forever, and onboarding would then never open at all. `hasMission`
 * stays `undefined` after a failure, which {@link onboardingStepForCompany}
 * reads as "no mission" — the customer is asked for it again, and the flow
 * continues. Asking a question twice is recoverable; never opening onboarding
 * is not. This is the same fail-open rule the wake and provisioning readiness
 * gates follow: a check that guards a convenience must never be able to block
 * the thing it guards.
 *
 * `mission` carries the same goal back in the shape the wizard's mission
 * textarea holds it. A company entered on the agent step never runs steps 1
 * and 2, so that field is otherwise empty — and it is what seeds the lead
 * agent's instructions, so an empty one costs the customer the mission they
 * gave at signup.
 *
 * `fetching` is exposed separately from `settled` for the same reason the
 * draft ownership gate distinguishes them: retained goals from a previous read
 * are the right company's but not necessarily its current mission, so a
 * consumer that must not act on a stale mission waits on this rather than on
 * `settled`.
 *
 * The goal list is read under the query key the launch path already uses, so
 * this shares that cache entry rather than adding a request.
 */
export function useCompanyMission(companyId: string | null | undefined): {
  hasMission: boolean | undefined;
  settled: boolean;
  mission: ExistingCompanyMission;
  fetching: boolean;
} {
  const { data: goals, isPending, isFetching } = useQuery({
    queryKey: queryKeys.goals.list(companyId ?? ""),
    queryFn: () => goalsApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  return {
    hasMission: goals ? selectDefaultCompanyGoalId(goals) !== null : undefined,
    // A disabled query stays pending forever, so no company means nothing to
    // wait for rather than an answer that never comes.
    settled: !companyId || !isPending,
    mission: goals
      ? selectExistingCompanyMission(goals)
      : { goalId: null, goalInput: "" },
    fetching: Boolean(companyId) && isFetching,
  };
}
