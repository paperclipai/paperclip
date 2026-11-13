/**
 * @fileoverview Core Skill Studio permission surfaces (PAP-13865, Phase 3).
 *
 * These are the *only* permission-related visuals core renders, and they follow
 * the north star from the approved UX spec (PAP-13863): under the open default
 * there is no permission chrome at all. A denial banner (`SkillPolicyDenialNotice`)
 * appears only when an explicit company policy (State B) or a platform invariant
 * (State C) actually denied an action.
 */

import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";

import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { classifySkillDenial, type SkillDenial } from "@/lib/skill-policy-denial";

// ---------------------------------------------------------------------------
// Denial banner state hook
// ---------------------------------------------------------------------------

export interface SkillPolicyDenialController {
  /** The active denial to render as a persistent banner, or null when clear. */
  denial: SkillDenial | null;
  /**
   * Classify a failed skill mutation. Explicit-policy (State B) and
   * platform-invariant (State C) denials are captured into the banner and
   * `true` is returned so the caller can suppress its transient error toast.
   * Everything else returns `false` — the caller keeps the existing toast path.
   */
  capture: (error: unknown, actionLabel?: string) => boolean;
  /** Clear the banner (dismiss, or on a subsequent successful action). */
  reset: () => void;
}

/**
 * Page-level controller for the skill-policy denial banner. A denial is a
 * durable, actionable state (not a transient toast), so it persists until the
 * operator dismisses it or a later action clears it. Transient errors never
 * reach the banner — they stay on the caller's toast path.
 */
export function useSkillPolicyDenial(): SkillPolicyDenialController {
  const [denial, setDenial] = useState<SkillDenial | null>(null);
  const capture = useCallback((error: unknown, actionLabel?: string) => {
    const classified = classifySkillDenial(error, actionLabel);
    if (classified) {
      setDenial(classified);
      return true;
    }
    return false;
  }, []);
  const reset = useCallback(() => setDenial(null), []);
  return { denial, capture, reset };
}

// ---------------------------------------------------------------------------
// Denial notice (State B / State C)
// ---------------------------------------------------------------------------

/**
 * Persistent, actionable denial banner. Rendered only when `classifySkillDenial`
 * returns a denial (explicit policy or platform invariant) — never for transient
 * errors, which stay on the toast path.
 */
export function SkillPolicyDenialNotice({
  denial,
  onDismiss,
  className,
}: {
  denial: SkillDenial;
  onDismiss?: () => void;
  className?: string;
}) {
  const actions = onDismiss ? (
    <Button variant="ghost" size="sm" onClick={onDismiss}>
      Dismiss
    </Button>
  ) : undefined;

  return (
    <InlineBanner
      tone="warning"
      icon={denial.state === "policy" ? ShieldCheck : AlertTriangle}
      title={denial.title}
      actions={actions}
      className={className}
    >
      <p>{denial.remediation}</p>
    </InlineBanner>
  );
}
