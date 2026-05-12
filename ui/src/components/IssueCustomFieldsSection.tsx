import { useQuery } from "@tanstack/react-query";
import { issuesApi, type IssueCustomField } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { sanitizeCustomFieldUrl } from "../lib/custom-field-url";

function CustomFieldValue({ field }: { field: IssueCustomField }) {
  if (field.type === "url") {
    const safe = field.valueText ? sanitizeCustomFieldUrl(field.valueText) : null;
    if (!safe) return <span className="text-muted-foreground">{field.valueText}</span>;
    return (
      <a
        href={safe}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:underline break-all"
      >
        {field.valueText}
      </a>
    );
  }

  if (field.type === "number") {
    return <span>{field.valueNumber ?? field.valueText}</span>;
  }

  return <span className="break-words">{field.valueText}</span>;
}

interface IssueCustomFieldsSectionProps {
  issueId: string;
}

export function IssueCustomFieldsSection({ issueId }: IssueCustomFieldsSectionProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.issues.customFields(issueId),
    queryFn: () => issuesApi.listCustomFields(issueId),
  });

  const fields = data?.customFields ?? [];

  if (isError) {
    return (
      <div className="text-sm text-muted-foreground">
        Plugin custom fields unavailable.
      </div>
    );
  }

  if (isLoading || fields.length === 0) return null;

  const byPlugin = new Map<string, { pluginId: string; pluginDisplayName: string; fields: IssueCustomField[] }>();
  for (const field of fields) {
    const entry = byPlugin.get(field.pluginId) ?? { pluginId: field.pluginId, pluginDisplayName: field.pluginDisplayName, fields: [] };
    entry.fields.push(field);
    byPlugin.set(field.pluginId, entry);
  }

  return (
    <div className="flex flex-col gap-4">
      {Array.from(byPlugin.values()).map((group) => (
        <div key={group.pluginId} className="flex flex-col gap-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {group.pluginDisplayName}
          </div>
          <div className="flex flex-col gap-1">
            {group.fields.map((field) => (
              <div key={field.key} className="flex items-baseline gap-2 text-sm">
                <span className="text-muted-foreground shrink-0 min-w-[120px]">{field.label}</span>
                <CustomFieldValue field={field} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
