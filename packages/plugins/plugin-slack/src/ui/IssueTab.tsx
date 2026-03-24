import React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";

interface ThreadEntry {
  channelId: string;
  threadTs: string;
  slackUrl?: string;
  createdAt: string;
}

export function SlackIssueTab({ context }: PluginDetailTabProps) {
  const { data: thread, loading, error } = usePluginData<ThreadEntry>(
    "thread-for-issue",
    { issueId: context.entityId },
  );

  if (loading) {
    return <div style={styles.container}><p style={styles.muted}>Loading…</p></div>;
  }

  if (error) {
    return (
      <div style={styles.container}>
        <p style={styles.error}>Failed to load Slack thread: {error.message}</p>
      </div>
    );
  }

  if (!thread) {
    return (
      <div style={styles.container}>
        <p style={styles.muted}>
          No Slack thread linked to this issue yet. Threads are created automatically
          when issues are posted to a mapped Slack channel.
        </p>
      </div>
    );
  }

  const formattedTs = new Date(Number(thread.threadTs) * 1000).toLocaleString();

  return (
    <div style={styles.container}>
      <h3 style={styles.title}>Slack Thread</h3>
      <dl style={styles.dl}>
        <dt style={styles.dt}>Channel</dt>
        <dd style={styles.dd}><code>#{thread.channelId}</code></dd>

        <dt style={styles.dt}>Posted at</dt>
        <dd style={styles.dd}>{formattedTs}</dd>

        {thread.slackUrl && (
          <>
            <dt style={styles.dt}>Link</dt>
            <dd style={styles.dd}>
              <a href={thread.slackUrl} target="_blank" rel="noopener noreferrer" style={styles.link}>
                Open in Slack →
              </a>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: "20px", fontFamily: "system-ui, sans-serif" },
  title: { margin: "0 0 16px", fontSize: "15px", fontWeight: 600 },
  dl: { display: "grid", gridTemplateColumns: "120px 1fr", gap: "10px 0", fontSize: "13px" },
  dt: { fontWeight: 600, color: "#555" },
  dd: { margin: 0 },
  link: { color: "#4A8CFF", textDecoration: "none" },
  muted: { color: "#888", fontSize: "13px" },
  error: { color: "#c00", fontSize: "13px" },
};
