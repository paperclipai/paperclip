import type { ActivityEvent } from "@paperclipai/shared";
import { Plus, Minus } from "lucide-react";
import { useTranslation } from "@/i18n";
import { IssueReferencePill } from "./IssueReferencePill";

type ActivityIssueReference = {
  id: string;
  identifier?: string | null;
  title?: string | null;
};

function readIssueReferences(details: Record<string, unknown> | null | undefined, key: string): ActivityIssueReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ActivityIssueReference => !!item && typeof item === "object");
}

function Section({
  label,
  icon,
  items,
  strikethrough,
}: {
  label: string;
  icon: React.ReactNode;
  items: ActivityIssueReference[];
  strikethrough?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        aria-label={label}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      >
        {icon}
        <span className="sr-only">{label}</span>
      </span>
      {items.map((issue) => (
        <IssueReferencePill
          key={`${label}:${issue.id}`}
          strikethrough={strikethrough}
          issue={{
            id: issue.id,
            identifier: issue.identifier ?? null,
            title: issue.title ?? issue.identifier ?? issue.id,
          }}
        />
      ))}
    </div>
  );
}

export function IssueReferenceActivitySummary({ event }: { event: Pick<ActivityEvent, "details"> }) {
  const { t } = useTranslation();
  const added = readIssueReferences(event.details, "addedReferencedIssues");
  const removed = readIssueReferences(event.details, "removedReferencedIssues");
  if (added.length === 0 && removed.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      <Section
        label={t("components.issueReferenceActivitySummary.addedReferences", { defaultValue: "Added references" })}
        icon={<Plus className="h-3 w-3 text-green-600 dark:text-green-400" aria-hidden="true" />}
        items={added}
      />
      <Section
        label={t("components.issueReferenceActivitySummary.removedReferences", { defaultValue: "Removed references" })}
        icon={<Minus className="h-3 w-3 text-red-600 dark:text-red-400" aria-hidden="true" />}
        items={removed}
        strikethrough
      />
    </div>
  );
}
