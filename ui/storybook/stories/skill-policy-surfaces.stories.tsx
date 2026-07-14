import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  PaperclipEeAffordance,
  SkillPolicyDenialNotice,
} from "@/components/skill-studio/SkillPolicySurfaces";
import type { EeSkillPolicyAvailability } from "@/components/skill-studio/SkillPolicySurfaces";
import { classifySkillDenial } from "@/lib/skill-policy-denial";
import { ApiError } from "@/api/client";

// PAP-13865 Phase 3: the *only* permission chrome core renders. Under the open
// default there is nothing here at all — install/edit/update/test/reset/remove
// are just live actions. A denial banner appears only when an explicit company
// policy (State B) or a platform-safety invariant (State C) actually denied an
// action; the Paperclip EE line is advisory discovery that never gates anything.

const eeEnabled: EeSkillPolicyAvailability = {
  availability: "enabled",
  pageLink: "/ACME/plugins/paperclip-ee",
  settingsLink: "/company/settings/instance/plugins/paperclipai.paperclip-ee",
};
const eeAbsent: EeSkillPolicyAvailability = {
  availability: "absent",
  pageLink: null,
  settingsLink: null,
};

function policyDenial() {
  return classifySkillDenial(
    new ApiError("denied", 403, {
      code: "skill_policy_denied",
      reason: "explicit_rule",
      remediation: "A company administrator can change the skill policy to allow this.",
    }),
    "Installing external skills",
  )!;
}

function platformDenial() {
  return classifySkillDenial(
    new ApiError("blocked", 403, { code: "skill_unsafe_content_blocked", reason: "platform_invariant" }),
  )!;
}

function Frame({ label, width, children }: { label: string; width: number; children: React.ReactNode }) {
  return (
    <div className="space-y-2 p-6" style={{ maxWidth: `${width}px` }}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

const meta = {
  title: "Product/Skills/Policy surfaces",
  component: SkillPolicyDenialNotice,
  args: { denial: policyDenial() },
  parameters: {
    docs: {
      description: {
        component:
          "Core Skill Studio permission surfaces (PAP-13865 §9.10). No permission chrome under the open default; an actionable denial banner only for explicit policy (State B) or platform-safety (State C) failures; a non-blocking Paperclip EE discovery line.",
      },
    },
  },
} satisfies Meta<typeof SkillPolicyDenialNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Desktop: every state stacked so the copy can be reviewed at a glance. */
export const Desktop: Story = {
  render: () => (
    <Frame label="Skill policy surfaces — desktop" width={720}>
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">State B — explicit company policy (EE installed)</div>
          <SkillPolicyDenialNotice denial={policyDenial()} ee={eeEnabled} onDismiss={() => {}} />
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">State C — platform safety failure (never points at EE)</div>
          <SkillPolicyDenialNotice denial={platformDenial()} ee={eeEnabled} onDismiss={() => {}} />
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">State B — EE not installed (no broken link)</div>
          <SkillPolicyDenialNotice denial={policyDenial()} ee={eeAbsent} onDismiss={() => {}} />
        </div>
        <div className="space-y-3 border-t border-border pt-4">
          <div className="text-xs font-medium text-muted-foreground">Paperclip EE discovery affordance — all lifecycle states</div>
          <PaperclipEeAffordance availability="absent" pageLink={null} settingsLink={null} />
          <PaperclipEeAffordance availability="enabled" pageLink={eeEnabled.pageLink} settingsLink={eeEnabled.settingsLink} />
          <PaperclipEeAffordance availability="disabled" pageLink={null} settingsLink={eeEnabled.settingsLink} />
          <PaperclipEeAffordance availability="error" pageLink={null} settingsLink={eeEnabled.settingsLink} />
        </div>
      </div>
    </Frame>
  ),
};

/** Narrow layout: banner + affordance reflow to a single column. */
export const Narrow: Story = {
  render: () => (
    <Frame label="Skill policy surfaces — narrow" width={360}>
      <div className="space-y-6">
        <SkillPolicyDenialNotice denial={policyDenial()} ee={eeEnabled} onDismiss={() => {}} />
        <SkillPolicyDenialNotice denial={platformDenial()} ee={eeEnabled} onDismiss={() => {}} />
        <div className="border-t border-border pt-4">
          <PaperclipEeAffordance availability="absent" pageLink={null} settingsLink={null} />
        </div>
      </div>
    </Frame>
  ),
};
