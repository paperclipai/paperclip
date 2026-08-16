import type { Goal } from "@paperclipai/shared";

import { formatOnboardingGoalInput, parseOnboardingGoalInput } from "./onboarding-goal";
import { selectDefaultCompanyGoalId } from "./onboarding-launch";

export type ExistingCompanyMission = {
  goalId: string | null;
  goalInput: string;
};

/**
 * Read an existing company's mission back out of its goals, in the shape the
 * wizard's mission textarea holds.
 *
 * The wizard can be entered on a company that already exists — the
 * `/{prefix}/onboarding` route, the dashboard's auto-open, or an in-app "add
 * agent" entry. On those paths steps 1 and 2 never run, so the mission has to
 * come from the company rather than from the form. Two things downstream read
 * it: the Review step's checklist, and the lead agent's instructions bundle.
 */
export function selectExistingCompanyMission(goals: Goal[]): ExistingCompanyMission {
  const goalId = selectDefaultCompanyGoalId(goals);
  if (!goalId) return { goalId: null, goalInput: "" };

  const goal = goals.find((entry) => entry.id === goalId) ?? null;

  return {
    goalId,
    goalInput: goal ? formatOnboardingGoalInput(goal.title, goal.description) : "",
  };
}

/**
 * Whether an existing company's mission has yet to be read back from the
 * server.
 *
 * On an existing-company entry the mission is never typed — it is hydrated
 * from the company's goals. Until that read lands, the wizard's mission field
 * still holds whatever the last run saved, which may be empty or may belong to
 * an entirely different company. Hiring the lead agent inside that window
 * seeds its instructions from that field and reports nothing wrong, so the
 * hire waits for the read.
 *
 * `fetching` counts as unresolved even when data is already present. Loaded
 * goals can be a cached read from before the wizard opened, with the current
 * request still in flight; they are at least the right company's, but not
 * necessarily its current mission. This is the same distinction the draft
 * ownership gate draws — `isFetching`, not `isLoading` — and for the same
 * reason: retained data is not an answer to the question being asked now.
 */
export function isExistingCompanyMissionUnresolved(params: {
  existingCompanyId?: string | null;
  goalsLoaded: boolean;
  goalsFetching?: boolean;
}): boolean {
  if (!params.existingCompanyId) return false;
  if (params.goalsFetching) return true;

  return !params.goalsLoaded;
}
export type MissionGoalPayload = {
  title: string;
  description?: string | null;
  level?: "company";
  status?: "active";
};

export type MissionPersistencePlan =
  | { kind: "skip" }
  | { kind: "create"; payload: MissionGoalPayload }
  | { kind: "update"; goalId: string; payload: MissionGoalPayload };

/**
 * Decide what confirming the mission has to write.
 *
 * The wizard used to early-return whenever a company id was already present,
 * so a mission typed on an existing company was silently discarded. An existing
 * company still needs no `companies.create` — but its mission must land on the
 * company-level goal, updating the goal the company already has rather than
 * creating a second one.
 */
export function planMissionPersistence(params: {
  goalInput: string;
  existingGoalId: string | null;
}): MissionPersistencePlan {
  const parsed = parseOnboardingGoalInput(params.goalInput);
  if (!parsed.title) return { kind: "skip" };

  if (params.existingGoalId) {
    return {
      kind: "update",
      goalId: params.existingGoalId,
      payload: { title: parsed.title, description: parsed.description },
    };
  }

  return {
    kind: "create",
    payload: {
      title: parsed.title,
      ...(parsed.description ? { description: parsed.description } : {}),
      level: "company",
      status: "active",
    },
  };
}
