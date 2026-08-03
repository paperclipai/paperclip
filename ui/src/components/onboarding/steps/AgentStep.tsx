import { motion } from "motion/react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentCapsule } from "../../AgentCapsule";
import { ROLE_OPTIONS } from "../onboarding-data";
import { OnboardingCard, OnboardingHeading, Stepper } from "../OnboardingPrimitives";
import { FooterNav } from "../FooterNav";
import { AgentPreview } from "../AgentPreview";
import { capsuleHandoffExit, capsuleMotion } from "../onboarding-motion";

/** Create-your-first-agent step: role select + optional name, with the capsule. */
export function AgentStep({
  agentRole,
  agentName,
  onRoleChange,
  onNameChange,
  onBack,
  onNext,
  loading,
  step,
  total,
  primaryLabel = "Create",
  loadingLabel = "Creating...",
}: {
  agentRole: string;
  agentName: string;
  onRoleChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onBack: () => void;
  onNext: () => void;
  loading?: boolean;
  step: number;
  total?: number;
  /** CTA label — cloud hires here ("Create"); local advances to the adapter step ("Next"). */
  primaryLabel?: string;
  loadingLabel?: string;
}) {
  const previewVisible = Boolean(agentName || agentRole);
  return (
    <OnboardingCard>
      <Stepper step={step} total={total} />
      <div className="space-y-6">
        <div className="flex flex-col items-center gap-2">
          <motion.div {...capsuleMotion} exit={capsuleHandoffExit}>
            <AgentCapsule
              state={previewVisible ? "configured" : "slot"}
              strokeDraw
              gradient={5}
              glow="blue"
              size="md"
            />
          </motion.div>
          <AgentPreview agentName={agentName} agentRole={agentRole} />
        </div>
        <OnboardingHeading title="Create your first agent" center />
        <div className="mx-auto flex w-full max-w-(--sz-320px) flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="onboarding-agent-role">Role</Label>
            <Select value={agentRole || undefined} onValueChange={onRoleChange}>
              <SelectTrigger id="onboarding-agent-role" className="w-full">
                <SelectValue placeholder="Select a role…" />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="onboarding-agent-name">
              Name <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="onboarding-agent-name"
              placeholder="Name"
              value={agentName}
              onChange={(e) => onNameChange(e.target.value)}
            />
          </div>
        </div>
        <FooterNav
          onBack={onBack}
          primaryLabel={primaryLabel}
          primaryDisabled={!agentRole.trim()}
          loading={loading}
          loadingLabel={loadingLabel}
          onPrimary={onNext}
        />
      </div>
    </OnboardingCard>
  );
}
