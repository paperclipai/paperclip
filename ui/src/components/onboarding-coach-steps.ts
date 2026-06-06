import { MessageSquare, SlidersHorizontal } from "lucide-react";
import type { OnboardingStepTabItem } from "./OnboardingStepTabs";

export const COACH_STEP_CONFIGURE = "configure";
export const COACH_STEP_CHAT = "chat";

export function buildCoachStepTabs(options?: {
  chatDisabled?: boolean;
}): ReadonlyArray<OnboardingStepTabItem> {
  return [
    {
      id: COACH_STEP_CONFIGURE,
      label: "Configure",
      icon: SlidersHorizontal,
    },
    {
      id: COACH_STEP_CHAT,
      label: "Chat",
      icon: MessageSquare,
      disabled: options?.chatDisabled ?? false,
    },
  ];
}

export const COACH_STEP_TABS = buildCoachStepTabs();
