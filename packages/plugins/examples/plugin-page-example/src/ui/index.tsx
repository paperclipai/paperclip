import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";

/**
 * Example company-context plugin page.
 * Rendered at /:companyPrefix/plugins/:pluginId when the plugin is enabled for that company.
 */
export function PluginPage({ context }: PluginPageProps) {
  return (
    <section className="space-y-3" aria-label="Plugin page example">
      <h2 className="text-lg font-semibold">Plugin page</h2>
      <p className="text-sm text-muted-foreground">
        This page was added by @paperclipai/plugin-page-example.
      </p>
      <p className="text-xs text-muted-foreground">Company context: {context.companyId ?? "—"}</p>
    </section>
  );
}
