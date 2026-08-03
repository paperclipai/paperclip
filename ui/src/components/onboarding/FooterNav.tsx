import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shared footer navigation for onboarding step cards: a ghost pill "Back"
 * button (visible on hover) and a primary pill CTA that shows a spinner +
 * loading label while its action runs.
 */
export function FooterNav({
  onBack,
  primaryLabel,
  primaryDisabled,
  loading,
  loadingLabel,
  onPrimary,
}: {
  onBack: () => void;
  primaryLabel: string;
  primaryDisabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  onPrimary: () => void;
}) {
  return (
    <div className="flex items-center justify-between pt-2">
      {/* has-[>svg]:pr-4 gives the "Back" text room from the pill's right edge
          (overrides size="sm"'s has-[>svg]:px-2.5 for the right side only). */}
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full has-[>svg]:pr-4"
        onClick={onBack}
        disabled={loading}
      >
        <ArrowLeft className="mr-1 size-3.5" />
        Back
      </Button>
      <Button
        size="lg"
        className="rounded-full px-6"
        onClick={onPrimary}
        disabled={primaryDisabled || loading}
      >
        {loading ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
        {loading && loadingLabel ? loadingLabel : primaryLabel}
        {!loading ? <ArrowRight className="ml-1 size-3.5" /> : null}
      </Button>
    </div>
  );
}
