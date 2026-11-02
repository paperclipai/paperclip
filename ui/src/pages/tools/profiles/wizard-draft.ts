import type { ToolProfileWithDetails } from "@paperclipai/shared";
import type { TemplateKey } from "./profile-model";

/**
 * The wizard stashes its non-server-modelled progress (which step the user
 * reached, which template they started from) inside the profile's free-form
 * `metadata`. This is never rendered, so it sits outside the vocabulary gate.
 */

export type WizardStep = 1 | 2 | 3;

export interface WizardMeta {
  lastCompletedStep: WizardStep;
  template: TemplateKey | null;
}

const KEY = "wizard";

export function readWizardMeta(
  profile: Pick<ToolProfileWithDetails, "metadata"> | null | undefined,
): WizardMeta | null {
  const raw = (profile?.metadata as Record<string, unknown> | null | undefined)?.[KEY];
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const step = obj.lastCompletedStep;
  if (step !== 1 && step !== 2 && step !== 3) return null;
  return {
    lastCompletedStep: step,
    template: (typeof obj.template === "string" ? obj.template : null) as TemplateKey | null,
  };
}

/** Merge wizard progress into a metadata object, preserving any other keys. */
export function withWizardMeta(
  metadata: Record<string, unknown> | null | undefined,
  meta: WizardMeta,
): Record<string, unknown> {
  return { ...(metadata ?? {}), [KEY]: meta };
}

/** Where to resume a draft: the first step the user has not yet completed. */
export function resumeStep(meta: WizardMeta | null): WizardStep {
  if (!meta) return 1;
  return Math.min(meta.lastCompletedStep + 1, 3) as WizardStep;
}
