import type { Meta, StoryObj } from "@storybook/react-vite";

import { ApiError } from "@/api/client";
import { SkillPolicyDenialNotice } from "@/components/skill-studio/SkillPolicySurfaces";
import { classifySkillDenial } from "@/lib/skill-policy-denial";

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
    new ApiError("blocked", 403, {
      code: "skill_unsafe_content_blocked",
      reason: "platform_invariant",
    }),
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
          "Core Skill Studio permission surfaces. No permission chrome under the open default; an actionable denial banner appears only for explicit policy or platform-safety failures.",
      },
    },
  },
} satisfies Meta<typeof SkillPolicyDenialNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  render: () => (
    <Frame label="Skill policy surfaces — desktop" width={720}>
      <div className="space-y-6">
        <SkillPolicyDenialNotice denial={policyDenial()} onDismiss={() => {}} />
        <SkillPolicyDenialNotice denial={platformDenial()} onDismiss={() => {}} />
      </div>
    </Frame>
  ),
};

export const Narrow: Story = {
  render: () => (
    <Frame label="Skill policy surfaces — narrow" width={360}>
      <div className="space-y-6">
        <SkillPolicyDenialNotice denial={policyDenial()} onDismiss={() => {}} />
        <SkillPolicyDenialNotice denial={platformDenial()} onDismiss={() => {}} />
      </div>
    </Frame>
  ),
};
