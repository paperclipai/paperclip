import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import type { UiLayoutBlock } from "@/hooks/useUiLayout";
import { InlineBanner } from "./InlineBanner";

export function UiLayoutNotice({
  blocked,
  error,
  subject,
  onRetry,
  onOverwrite,
  className,
}: {
  blocked: UiLayoutBlock;
  error: unknown;
  subject: string;
  onRetry: () => void;
  onOverwrite: () => void;
  className?: string;
}) {
  if (blocked === null) return null;
  if (blocked === "load-error") {
    return (
      <InlineBanner
        tone="warning"
        compact
        className={className}
        title={`Your saved ${subject} layout could not be loaded. Changes are not saved.`}
        actions={<Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
      >
        {describeError(error, { action: `load your ${subject} layout` }).body}
      </InlineBanner>
    );
  }
  return (
    <InlineBanner
      tone="warning"
      compact
      className={className}
      title={`Your saved ${subject} layout cannot be read by this version. Changes are not saved.`}
      actions={<Button size="sm" variant="outline" onClick={onOverwrite}>Replace saved layout</Button>}
    >
      The saved layout is kept as it is until you choose to replace it.
    </InlineBanner>
  );
}
