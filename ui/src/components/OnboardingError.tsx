import { Button } from "@/components/ui/button";
import type { CategorizedOnboardingError } from "../lib/onboarding-error";
import { getOnboardingErrorCopy } from "../lib/onboarding-error-copy";

export interface OnboardingErrorProps {
  error: CategorizedOnboardingError | null;
  onRetry?: (() => void) | null;
  retrying?: boolean;
}

export function OnboardingError({ error, onRetry, retrying = false }: OnboardingErrorProps) {
  if (!error) return null;

  // Step 2's adapter environment surface owns its own rendering — we suppress.
  if (error.class === "adapter_environment") return null;

  const copy = getOnboardingErrorCopy(error);

  if (copy.variant === "inline") {
    return (
      <div role="alert" data-testid="onboarding-error" data-class={error.class}>
        <p className="text-xs text-destructive">{copy.body}</p>
      </div>
    );
  }

  const showRetry = Boolean(copy.retryLabel && onRetry);

  return (
    <div
      role="alert"
      data-testid="onboarding-error"
      data-class={error.class}
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 space-y-1.5"
    >
      {copy.title && (
        <p className="text-xs font-medium text-destructive">{copy.title}</p>
      )}
      <p className="text-xs text-destructive/90 leading-relaxed">{copy.body}</p>
      {showRetry && (
        <div className="pt-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs"
            onClick={onRetry ?? undefined}
            disabled={retrying}
            data-testid="onboarding-error-retry"
          >
            {retrying ? "Retrying..." : copy.retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
