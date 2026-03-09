import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";

/**
 * Modal content rendered when the user clicks the "Open modal" entry in the sidebar.
 * The host mounts this inside a modal shell (backdrop, title bar with Close, focus trap).
 */
export function SidebarModalContent({
  context,
}: {
  launcher: { displayName: string; pluginDisplayName: string };
  context: PluginHostContext;
}) {
  return (
    <section className="space-y-3" aria-label="Sidebar modal example">
      <p className="text-sm text-muted-foreground">
        This modal was opened from the sidebar entry added by the Sidebar Modal example plugin.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Company:</dt>
        <dd className="font-mono truncate" title={context.companyId ?? undefined}>
          {context.companyId ?? "—"}
        </dd>
        <dt className="text-muted-foreground">Company prefix:</dt>
        <dd>{context.companyPrefix ?? "—"}</dd>
      </dl>
    </section>
  );
}
