import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";

/**
 * Example tab for Agent detail page.
 */
export function AgentDetailTab({ context }: PluginDetailTabProps) {
  return (
    <section className="space-y-2" aria-label="Plugin tab for agent">
      <p className="text-sm font-medium">Plugin tab for agent</p>
      <p className="text-xs text-muted-foreground">
        Entity: {context.entityType} — {context.entityId}
      </p>
    </section>
  );
}

/**
 * Example tab for Goal detail page.
 */
export function GoalDetailTab({ context }: PluginDetailTabProps) {
  return (
    <section className="space-y-2" aria-label="Plugin tab for goal">
      <p className="text-sm font-medium">Plugin tab for goal</p>
      <p className="text-xs text-muted-foreground">
        Entity: {context.entityType} — {context.entityId}
      </p>
    </section>
  );
}
