import { useTranslation } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import type { IssueDocument } from "@paperclipai/shared";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";
import { cn, relativeTime } from "../lib/utils";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import { ChevronDown, ChevronRight, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type IssueContinuationHandoffProps = {
  document: IssueDocument | null | undefined;
  focusSignal?: number;
  externalReferences?: MarkdownExternalReferenceMap;
};

export function IssueContinuationHandoff({
  document,
  focusSignal = 0,
  externalReferences,
}: IssueContinuationHandoffProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [highlighted, setHighlighted] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!document || focusSignal <= 0) return;
    setExpanded(true);
    setHighlighted(true);
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlighted(false), 3000);
    return () => clearTimeout(timer);
  }, [document, focusSignal]);

  if (!document) return null;

  const title = document.title?.trim() || t("localizationIssueChrome.handoffTitle");

  return (
    <div
      ref={rootRef}
      id={`document-${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}`}
      className={cn(
        "mb-3 rounded-lg border border-border bg-accent/20 p-3 transition-colors duration-1000",
        highlighted && "border-primary/50 bg-primary/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
          aria-label={expanded ? t("localizationIssueChrome.handoffCollapse") : t("localizationIssueChrome.handoffExpand")}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <History className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{title}</span>
            <Badge variant="outline" className="border-border font-mono text-(length:--text-nano) uppercase text-muted-foreground">
              {t("localizationIssueChrome.handoffBadge")}
            </Badge>
          </div>
          <div className="text-(length:--text-micro) text-muted-foreground">
            {t(document.latestRevisionNumber > 0 ? "localizationIssueChrome.handoffUpdatedRevision" : "localizationIssueChrome.handoffUpdated", { time: relativeTime(document.updatedAt), revision: document.latestRevisionNumber })}
          </div>
        </div>
        <AgentSetupPrompt
          prompt={document.body}
          label={t("oct5Core.continueWithAgent")}
          title={t("oct5Core.taskHandoff")}
          description={t("oct5Core.handoffDescription")}
          align="end"
        />
      </div>
      {expanded ? (
        <div className="mt-3 rounded-md border border-border bg-background/80 p-3">
          <MarkdownBody
            className="paperclip-edit-in-place-content text-sm leading-6"
            softBreaks={false}
            externalReferences={externalReferences}
          >
            {document.body}
          </MarkdownBody>
        </div>
      ) : null}
    </div>
  );
}
