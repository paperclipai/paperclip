import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "../ui/button";

/**
 * Shared footer for the arc's step cards: a ghost pill "Back" and a primary
 * pill CTA that shows a spinner and a loading label while its action runs.
 *
 * `onBack` is optional — a run that entered on this step has nowhere behind it
 * to return to, and an inert Back button reads as a dead control rather than a
 * boundary.
 */
export function FooterNav({
  onBack,
  primaryLabel,
  primaryDisabled,
  loading,
  loadingLabel,
  onPrimary,
}: {
  onBack?: () => void;
  primaryLabel: string;
  primaryDisabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  onPrimary: () => void;
}) {
  return (
    <div className="flex items-center justify-between pt-9">
      {onBack ? (
        // Same size as the primary, not a tier down. Back is ghost until you
        // point at it, and a shorter pill made the hover surface read as a
        // different kind of control sitting slightly low in the row rather than
        // the other half of a pair.
        //
        // The padding stays asymmetric against size="lg"'s symmetric px-4: the
        // arrow needs less room on its side than the word does on its own.
        <Button
          variant="ghost"
          size="lg"
          className="rounded-full has-[>svg]:pl-4 has-[>svg]:pr-5"
          onClick={onBack}
          disabled={loading}
        >
          <ArrowLeft className="mr-1 size-3.5" />
          Back
        </Button>
      ) : (
        <span />
      )}
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
