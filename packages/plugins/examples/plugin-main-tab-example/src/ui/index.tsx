import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";

/**
 * Example tab for the Issue detail page (main UI).
 * This slot is mounted by the host in the issue detail tab bar
 * and receives the current issue context.
 */
export function IssueDetailTab({ context }: PluginDetailTabProps) {
  return (
    <section className="space-y-3 p-4" aria-label="Plugin tab for issue">
      <h3 className="text-sm font-semibold">Plugin tab (main UI)</h3>
      <p className="text-xs text-muted-foreground">
        This tab was added by the Main Tab example plugin. It appears in the
        issue detail tab bar alongside Comments, Subissues, and Activity.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Entity type:</dt>
        <dd>{context.entityType}</dd>
        <dt className="text-muted-foreground">Entity ID:</dt>
        <dd className="font-mono truncate" title={context.entityId}>
          {context.entityId}
        </dd>
        {context.companyId && (
          <>
            <dt className="text-muted-foreground">Company:</dt>
            <dd className="font-mono truncate" title={context.companyId}>
              {context.companyId}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
