import { useMemo } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { listUIAdapters } from "@/adapters";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { isVisualAdapterChoice } from "@/adapters/metadata";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentCapsule } from "../../AgentCapsule";
import { OnboardingCard, OnboardingHeading, Stepper } from "../OnboardingPrimitives";
import { FooterNav } from "../FooterNav";
import { AgentPreview } from "../AgentPreview";
import { capsuleHandoffExit, capsuleHeroMotion } from "../onboarding-motion";

const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);

function visualAdapters() {
  return listUIAdapters()
    .filter((a) => !SYSTEM_ADAPTER_TYPES.has(a.type) && isVisualAdapterChoice(a.type))
    .map((a) => ({ ...getAdapterDisplay(a.type), type: a.type }))
    .filter((a) => !a.comingSoon);
}

/**
 * Local-flow only: pick the model/adapter the first agent runs on. Recommended
 * options are surfaced as cards; the rest are grouped in an "Additional models"
 * dropdown. Selecting from either sets the same adapterType.
 */
export function AdapterStep({
  adapterType,
  onAdapterChange,
  agentName,
  agentRole,
  onBack,
  onNext,
  loading,
  step,
  total,
}: {
  adapterType: string;
  onAdapterChange: (type: string) => void;
  agentName: string;
  agentRole: string;
  onBack: () => void;
  onNext: () => void;
  loading?: boolean;
  step: number;
  total?: number;
}) {
  const { recommended, additional } = useMemo(() => {
    const all = visualAdapters();
    return {
      recommended: all.filter((a) => a.recommended),
      // Top handful of other models beyond the recommended ones.
      additional: all.filter((a) => !a.recommended).slice(0, 5),
    };
  }, []);

  // The dropdown reflects the selection only when it isn't one of the cards.
  const additionalValue = additional.some((a) => a.type === adapterType) ? adapterType : undefined;

  return (
    <OnboardingCard>
      <Stepper step={step} total={total} />
      <div className="space-y-6">
        {/* Carried-over outlined capsule from the agent step: enters with the
            same hero scale/fade as the task pill and hands off (scale down) on
            exit, but stays "configured" (outlined) — no coming-alive here. */}
        <div className="flex flex-col items-center gap-2">
          <motion.div {...capsuleHeroMotion} exit={capsuleHandoffExit}>
            <AgentCapsule state="configured" gradient={5} glow="blue" size="md" />
          </motion.div>
          <AgentPreview agentName={agentName} agentRole={agentRole} />
        </div>
        <OnboardingHeading
          title="Connect a model"
          lede="What model would you like your first agent to use? You can choose different models when creating additional agents."
          center
        />
        <div className="grid grid-cols-2 gap-2">
          {recommended.map((opt) => {
            const selected = adapterType === opt.type;
            return (
              <button
                key={opt.type}
                type="button"
                onClick={() => onAdapterChange(opt.type)}
                className={cn(
                  "relative flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                  selected
                    ? "border-foreground bg-accent"
                    : "border-border hover:border-muted-foreground",
                )}
              >
                <span className="absolute -top-1.5 right-1.5 rounded-full bg-green-500 px-1.5 py-0.5 text-(length:--text-nano) font-semibold leading-none text-white">
                  Recommended
                </span>
                <opt.icon className="size-4" />
                <span className="font-medium">{opt.label}</span>
                <span className="text-(length:--text-nano) text-muted-foreground">
                  {opt.description}
                </span>
              </button>
            );
          })}
        </div>

        {additional.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-(length:--text-micro) font-medium uppercase tracking-widest text-muted-foreground">
              Additional models
            </span>
            <Select value={additionalValue} onValueChange={onAdapterChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose another model…" />
              </SelectTrigger>
              <SelectContent>
                {additional.map((opt) => (
                  <SelectItem key={opt.type} value={opt.type}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <FooterNav
          onBack={onBack}
          primaryLabel="Connect now"
          primaryDisabled={!adapterType}
          loading={loading}
          loadingLabel="Bringing to life..."
          onPrimary={onNext}
        />
      </div>
    </OnboardingCard>
  );
}
