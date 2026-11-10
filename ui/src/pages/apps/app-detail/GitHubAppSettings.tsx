import { getAppStoreDefinition, type ToolConnection, type AppDefinition } from "@paperclipai/shared";
import { KeySection } from "./AdvancedPanel";

export function GitHubAppConfiguration({ connection, galleryEntry, canReplace, unavailableMessage, onReplaced }: {
  connection: ToolConnection;
  galleryEntry: AppDefinition | null;
  canReplace: boolean;
  unavailableMessage: string;
  onReplaced: () => void;
}) {
  return (
    <section className="space-y-3" aria-label="GitHub App configuration">
      <h2 className="text-sm font-semibold">GitHub App configuration</h2>
      <GitHubAppSettings config={connection.config ?? {}} />
      <p className="text-sm text-muted-foreground">
        Replace the private key below. Create a new connection to change
        the App, installation, repositories, GitHub permissions or ownership. Manage agent access and Paperclip action permissions below.
      </p>
      <KeySection connection={connection} galleryEntry={galleryEntry} canReplace={canReplace}
        unavailableMessage={unavailableMessage} onReplaced={onReplaced} />
    </section>
  );
}

export function GitHubAppSettings({ config }: { config: Record<string, unknown> }) {
  const value = config.methodConfig;
  const settings = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const text = (key: string) => typeof settings[key] === "string" || typeof settings[key] === "number"
    ? String(settings[key]) : "Not configured";
  const profile = getAppStoreDefinition("github")?.methods
    .find((method) => method.key === "app-installation")?.tenantFields
    ?.find((field) => field.key === "permissionProfile")?.options
    ?.find((option) => option.value === settings.permissionProfile)?.label;
  let permissions: [string, string][] | null = null;
  if (settings.permissionProfile === "custom" && typeof settings.customPermissions === "string") {
    try {
      const parsed: unknown = JSON.parse(settings.customPermissions);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed);
        if (entries.length > 0 && entries.every(([key, level]) =>
          /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key)
          && (level === "read" || level === "write" || level === "admin"))) {
          permissions = entries.sort(([a], [b]) => a.localeCompare(b)) as [string, string][];
        }
      }
    } catch {}
  }

  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">View configured settings</summary>
      <div className="space-y-4 pt-4">
        <p className="text-xs text-muted-foreground">Saved configuration for validation. These are the permissions Paperclip requests, not a live report of permissions granted by GitHub.</p>
        <dl className="space-y-3 text-sm">
          {[["App ID or Client ID", text("appId")], ["Installation ID", text("installationId")], ["Repositories", text("repositories")]].map(([label, content]) => (
            <div key={label} className="space-y-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-words whitespace-pre-wrap font-mono">{content}</dd>
            </div>
          ))}
          <div className="space-y-1">
            <dt className="text-muted-foreground">GitHub permissions</dt>
            <dd>{profile ?? text("permissionProfile")}</dd>
          </div>
        </dl>
        {settings.permissionProfile === "custom" && (permissions ? (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Configured GitHub permissions</caption>
            <thead><tr className="border-b border-border"><th scope="col" className="py-2 font-medium">Resource</th><th scope="col" className="py-2 font-medium">Access</th></tr></thead>
            <tbody>{permissions.map(([resource, level]) => (
              <tr key={resource} className="border-b border-border"><td className="break-words py-2 font-mono">{resource}</td><td className="py-2 capitalize">{level}</td></tr>
            ))}</tbody>
          </table>
        ) : <p className="text-sm text-muted-foreground">Saved custom permissions could not be read. Check the connection configuration.</p>)}
      </div>
    </details>
  );
}
