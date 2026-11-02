import { t, useTranslation } from "@/i18n";
import { Copy } from "lucide-react";
import { CopyText } from "./CopyText";

export function RoutineSectionHeading({
  title,
  copyText = null,
}: {
  title: string;
  /** Description markdown to copy. Omit the button when this is null. */
  copyText?: string | null;
}) {
  useTranslation();
  return (
    <div className="mb-4 flex items-center gap-1">
      <h2 id="routine-section-title" className="text-lg font-semibold">
        {title}
      </h2>
      {copyText != null ? (
        <CopyText
          text={copyText}
          ariaLabel={t("oct19Core.coverage043")}
          title={t("oct19Core.coverage043")}
          copiedLabel={t("oct19Core.coverage044")}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </CopyText>
      ) : null}
    </div>
  );
}
