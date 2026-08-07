import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { MISSION_CHIPS } from "../onboarding-data";
import { Chip, OnboardingCard, OnboardingHeading, Stepper } from "../OnboardingPrimitives";
import { FooterNav } from "../FooterNav";

/** Company name + mission step. */
export function CompanyStep({
  companyName,
  onCompanyNameChange,
  mission,
  onMissionChange,
  onBack,
  onNext,
  loading,
  step,
  total,
}: {
  companyName: string;
  onCompanyNameChange: (value: string) => void;
  mission: string;
  onMissionChange: (value: string) => void;
  onBack: () => void;
  onNext: () => void;
  loading?: boolean;
  step: number;
  total?: number;
}) {
  const [activeChip, setActiveChip] = useState<string | null>(null);
  return (
    <OnboardingCard>
      <Stepper step={step} total={total} />
      <div className="space-y-6">
        <OnboardingHeading
          title="What is the name of your company or team?"
          lede="This will be the name of your Paperclip organization — choose something your team will recognize."
        />
        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-company-name">Name</Label>
          <Input
            id="onboarding-company-name"
            placeholder="e.g. Northwind Labs"
            value={companyName}
            onChange={(e) => onCompanyNameChange(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-mission">What is the mission?</Label>
          <Textarea
            id="onboarding-mission"
            className="min-h-(--sz-88px)"
            placeholder="This could be your company mission, team goal, or desired outcome."
            value={mission}
            onChange={(e) => {
              onMissionChange(e.target.value);
              setActiveChip(null);
            }}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {MISSION_CHIPS.map((chip) => (
            <Chip
              key={chip}
              label={chip}
              active={activeChip === chip}
              onClick={() => {
                onMissionChange(chip);
                setActiveChip(chip);
              }}
            />
          ))}
        </div>
        <FooterNav
          onBack={onBack}
          primaryLabel="Next"
          primaryDisabled={!companyName.trim() || !mission.trim()}
          loading={loading}
          loadingLabel="Creating..."
          onPrimary={onNext}
        />
      </div>
    </OnboardingCard>
  );
}
