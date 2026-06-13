import {
  useHostContext,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { PLUGIN_ID } from "../constants.js";

export function GitHubConnectorSettingsPage(_props: PluginSettingsPageProps) {
  const { companyId } = useHostContext();

  return (
    <div style={{ padding: "1.5rem", fontFamily: "sans-serif", maxWidth: 640 }}>
      <h2 style={{ marginTop: 0 }}>GitHub Connector</h2>
      <p style={{ color: "#555" }}>
        Bidirectional sync between GitHub issues / pull requests and Paperclip issues.
        Agent wakeups are triggered on <code>pull_request_review</code> and <code>push</code> events.
      </p>

      <section style={{ marginTop: "1.5rem" }}>
        <h3>Setup checklist</h3>
        <ol>
          <li>Create a GitHub webhook pointing at the Paperclip webhook URL for this plugin.</li>
          <li>Set the webhook secret and enter it in the <strong>Webhook Secret</strong> config field.</li>
          <li>
            Create a GitHub personal access token (or app token) with <code>repo</code> scope,
            store it as a Paperclip secret, and enter the secret reference in <strong>GitHub Token Secret Reference</strong>.
          </li>
          <li>Fill in <strong>Repository Owner</strong> and <strong>Repository Name</strong>.</li>
          <li>Optionally add agent IDs to <strong>Trigger Agent IDs</strong> for PR-review and push wakeups.</li>
        </ol>
      </section>

      <section style={{ marginTop: "1.5rem", fontSize: "0.85rem", color: "#888" }}>
        Plugin ID: {PLUGIN_ID} — Company: {companyId ?? "—"}
      </section>
    </div>
  );
}
