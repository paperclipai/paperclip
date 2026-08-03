import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OnboardingCard, OnboardingHeading } from "../OnboardingPrimitives";

/**
 * Local-flow only: a gentle, OPTIONAL email ask before the numbered steps, with
 * an explicit privacy assurance. Both Continue and Skip advance; the email is
 * collected into container state (persistence is out of scope for now).
 */
export function EmailStep({
  email,
  onEmailChange,
  onContinue,
  onSkip,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  return (
    <OnboardingCard>
      <div className="space-y-6">
        <OnboardingHeading
          title="Want product updates?"
          lede="Leave an email and we'll let you know about meaningful releases. Totally optional."
          center
        />
        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-email">
            Email <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="onboarding-email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-px size-4 shrink-0 text-foreground/70" />
          <span>
            We'll never use this for marketing or share it with third parties — it's only for
            the occasional product update.
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <Button size="lg" className="w-full rounded-full" onClick={onContinue}>
            Continue
          </Button>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </div>
    </OnboardingCard>
  );
}
