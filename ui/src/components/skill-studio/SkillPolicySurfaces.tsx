/**
 * @fileoverview Core Skill Studio permission surfaces (PAP-13865, Phase 3).
 *
 * These are the *only* permission-related visuals core renders, and they follow
 * the north star from the approved UX spec (PAP-13863): under the open default
 * there is no permission chrome at all. A denial banner (`SkillPolicyDenialNotice`)
 * appears only when an explicit company policy (State B) or a platform invariant
 * (State C) actually denied an action. The Paperclip EE affordance
 * (`PaperclipEeAffordance`) is advisory discovery only — it never disables a core
 * action and core never depends on EE. `SkillPolicyPeek` is a read-only,
 * concise effective-policy summary — never an editor (the editor lives in EE).
 */

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { pluginsApi } from "@/api/plugins";
import { skillPolicyApi } from "@/api/skillPolicy";
import { CollapsibleSection } from "@/components/agent-config-primitives";
import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import {
  eePluginPageLink,
  eePluginSettingsLink,
  PAPERCLIP_EE_MARKETING_URL,
  resolveEeSkillPolicyState,
  type EeAvailability,
} from "@/lib/ee-skill-policy";
import { classifySkillDenial, type SkillDenial } from "@/lib/skill-policy-denial";
import { Link } from "@/lib/router";

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
// EE availability hook
// ---------------------------------------------------------------------------

export interface EeSkillPolicyAvailability {
  availability: EeAvailability;
  /** In-app deep link to the EE policy page (only when installed & we have a prefix). */
  pageLink: string | null;
  /** Deep link to Plugin settings (to enable a disabled EE plugin). */
  settingsLink: string | null;
}

/**
 * Resolve the Paperclip EE plugin's availability for the current company. This
 * is a soft dependency: the query failing or returning nothing simply means the
 * affordance renders in its "absent" form — core skill work is never blocked.
 */
export function useEeSkillPolicyAvailability(companyPrefix: string | null): EeSkillPolicyAvailability {
  const { data: plugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
    staleTime: 60_000,
  });

  return useMemo(() => {
    const { availability, plugin } = resolveEeSkillPolicyState(plugins);
    return {
      availability,
      pageLink: eePluginPageLink(plugin, companyPrefix),
      settingsLink: eePluginSettingsLink(plugin),
    };
  }, [plugins, companyPrefix]);
}

// ---------------------------------------------------------------------------
// Paperclip EE discovery affordance (non-blocking)
// ---------------------------------------------------------------------------

const EE_DISCOVERY_LEAD = "Need per-agent or per-action skill rules?";

/**
 * A single quiet footer line pointing at Paperclip EE for detailed policy
 * administration. Advisory only — never a paywall on the current actions and
 * never a prerequisite. Renders correctly across all four EE lifecycle states.
 */
export function PaperclipEeAffordance({
  availability,
  pageLink,
  settingsLink,
  className,
}: {
  availability: EeAvailability;
  pageLink: string | null;
  settingsLink: string | null;
  className?: string;
}) {
  const linkClass = "underline underline-offset-2 hover:text-foreground";
  const base = "text-xs text-muted-foreground";

  if (availability === "enabled" && pageLink) {
    return (
      <p className={base + (className ? ` ${className}` : "")}>
        {EE_DISCOVERY_LEAD}{" "}
        <Link className={linkClass} to={pageLink}>
          Manage detailed skill policy in Paperclip EE.
        </Link>
      </p>
    );
  }

  if (availability === "disabled") {
    return (
      <p className={base + (className ? ` ${className}` : "")}>
        {EE_DISCOVERY_LEAD} Paperclip EE is installed but disabled.{" "}
        {settingsLink ? (
          <Link className={linkClass} to={settingsLink}>
            Enable it in Plugin settings.
          </Link>
        ) : (
          <span>Enable it in Plugin settings.</span>
        )}
      </p>
    );
  }

  if (availability === "error") {
    return (
      <p className={base + (className ? ` ${className}` : "")}>
        {EE_DISCOVERY_LEAD} Paperclip EE failed to load — detailed policy editing is
        temporarily unavailable. Skill management still works.{" "}
        {settingsLink ? (
          <Link className={linkClass} to={settingsLink}>
            Open Plugin settings.
          </Link>
        ) : null}
      </p>
    );
  }

  // absent — text-only discovery link to marketing site.
  return (
    <p className={base + (className ? ` ${className}` : "")}>
      {EE_DISCOVERY_LEAD} Manage detailed skill policy in{" "}
      <a className={linkClass} href={PAPERCLIP_EE_MARKETING_URL} target="_blank" rel="noreferrer">
        Paperclip EE.
      </a>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Denial notice (State B / State C)
// ---------------------------------------------------------------------------

/**
 * Persistent, actionable denial banner. Rendered only when `classifySkillDenial`
 * returns a denial (explicit policy or platform invariant) — never for transient
 * errors, which stay on the toast path. State B carries a non-blocking EE link
 * when EE is installed; State C never points at EE (policy cannot waive safety).
 */
export function SkillPolicyDenialNotice({
  denial,
  ee,
  onDismiss,
  className,
}: {
  denial: SkillDenial;
  ee?: EeSkillPolicyAvailability;
  onDismiss?: () => void;
  className?: string;
}) {
  const showEeLink =
    denial.allowsEeRemediation && ee && ee.availability === "enabled" && !!ee.pageLink;

  const actions = (
    <div className="flex items-center gap-2">
      {showEeLink && ee?.pageLink ? (
        <Button asChild variant="link" size="sm" className="h-auto p-0">
          <Link to={ee.pageLink}>Open skill policy in EE</Link>
        </Button>
      ) : null}
      {onDismiss ? (
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );

  return (
    <InlineBanner
      tone="warning"
      icon={denial.state === "policy" ? ShieldCheck : AlertTriangle}
      title={denial.title}
      actions={onDismiss || showEeLink ? actions : undefined}
      className={className}
    >
      <p>{denial.remediation}</p>
    </InlineBanner>
  );
}

// ---------------------------------------------------------------------------
// Effective-policy peek (read-only, minimal)
// ---------------------------------------------------------------------------

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

/**
 * A concise, read-only effective-policy summary so an operator can answer "why
 * can't I do X here?" without EE. Under the open default this reads
 * "Default: Allow · Explicit rules: 0" and is collapsed. Editing routes to EE —
 * core never renders the rule editor.
 */
export function SkillPolicyPeek({
  companyId,
  ee,
  className,
}: {
  companyId: string;
  ee?: EeSkillPolicyAvailability;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: policy } = useQuery({
    queryKey: queryKeys.skillPolicy.effective(companyId),
    queryFn: () => skillPolicyApi.get(companyId),
    enabled: Boolean(companyId) && open,
    staleTime: 30_000,
  });

  const defaultLabel = policy ? (policy.defaultEffect === "allow" ? "Allow" : "Deny") : "—";
  const ruleCount = policy ? String(policy.rules.length) : "—";
  const stateLabel = policy
    ? policy.materialized
      ? `Restricted · revision ${policy.revision}`
      : "Open default"
    : "—";

  return (
    <div className={className}>
      <CollapsibleSection title="View skill policy" open={open} onToggle={() => setOpen((v) => !v)}>
        <div className="divide-y divide-border/60">
          <PolicyRow label="Status" value={stateLabel} />
          <PolicyRow label="Default" value={defaultLabel} />
          <PolicyRow label="Explicit rules" value={ruleCount} />
        </div>
        {ee ? (
          <PaperclipEeAffordance
            availability={ee.availability}
            pageLink={ee.pageLink}
            settingsLink={ee.settingsLink}
            className="mt-3"
          />
        ) : null}
      </CollapsibleSection>
    </div>
  );
}
