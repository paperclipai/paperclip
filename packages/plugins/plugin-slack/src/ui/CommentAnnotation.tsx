import React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginCommentAnnotationProps } from "@paperclipai/plugin-sdk/ui";

export function SlackCommentAnnotation({ context }: PluginCommentAnnotationProps) {
  const { data: messageTs, loading } = usePluginData<string>(
    "message-ts-for-comment",
    { commentId: context.entityId },
  );

  if (loading || !messageTs) return null;

  return (
    <span style={styles.badge} title={`Posted to Slack at ${messageTs}`}>
      📨 Posted to Slack
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  badge: {
    display: "inline-block",
    fontSize: "11px",
    color: "#4A8CFF",
    background: "#EEF3FF",
    borderRadius: "4px",
    padding: "2px 6px",
    marginLeft: "8px",
    verticalAlign: "middle",
  },
};
