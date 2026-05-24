import type { CategorizedOnboardingError, OnboardingErrorClass } from "./onboarding-error";

export interface OnboardingErrorCopy {
  /**
   * Visual treatment hint. "inline" renders without a banner background
   * (used for field-level validation). "banner" renders with the standard
   * destructive banner.
   */
  variant: "inline" | "banner";
  title: string | null;
  body: string;
  retryLabel: string | null;
  secondaryLabel: string | null;
}

const DEFAULT_RETRY = "Try again";

function joinFieldMessages(error: CategorizedOnboardingError): string {
  if (error.fields.length === 0) {
    return error.serverMessage ?? "Please check the form and try again.";
  }
  return error.fields
    .map((f) => (f.path ? `${f.path}: ${f.message}` : f.message))
    .join(" • ");
}

export function getOnboardingErrorCopy(error: CategorizedOnboardingError): OnboardingErrorCopy {
  switch (error.class as OnboardingErrorClass) {
    case "validation":
      return {
        variant: "inline",
        title: null,
        body: joinFieldMessages(error),
        retryLabel: null,
        secondaryLabel: null,
      };

    case "name_conflict":
      return {
        variant: "banner",
        title: "That name is taken",
        body: "Pick a different name and try again.",
        retryLabel: DEFAULT_RETRY,
        secondaryLabel: null,
      };

    case "adapter_environment":
      // Step 2's AdapterEnvironmentResult renders this case. OnboardingError
      // suppresses rendering so we don't double up.
      return {
        variant: "banner",
        title: null,
        body: "",
        retryLabel: null,
        secondaryLabel: null,
      };

    case "unknown_server_error": {
      const incident = error.incidentId
        ? ` We've logged it as ${error.incidentId}.`
        : " We've logged it.";
      return {
        variant: "banner",
        title: "Something went wrong on our side",
        body: `Something went wrong while saving.${incident} You can retry, or try a different name.`,
        retryLabel: DEFAULT_RETRY,
        secondaryLabel: null,
      };
    }

    case "network":
      return {
        variant: "banner",
        title: "Couldn't reach Paperclip",
        body: "Check your connection and try again.",
        retryLabel: DEFAULT_RETRY,
        secondaryLabel: null,
      };

    default:
      return {
        variant: "banner",
        title: "Something went wrong",
        body: "Please try again.",
        retryLabel: DEFAULT_RETRY,
        secondaryLabel: null,
      };
  }
}
