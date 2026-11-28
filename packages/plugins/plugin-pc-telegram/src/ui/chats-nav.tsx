import { useEffect, useRef, type CSSProperties } from "react";
import { useHostNavigation, usePluginData, usePluginStream } from "@paperclipai/plugin-sdk/ui";
import type { OverviewData } from "./connect-page.js";
import { uiText } from "./locale.js";

const chatLink: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  margin: "0 8px",
  padding: "6px 8px",
  borderRadius: 8,
  color: "inherit",
  textDecoration: "none",
  fontSize: "var(--text-compact, 13px)",
  fontWeight: 500,
  minWidth: 0,
};

const chatLabel: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

function instanceLabel(displayName: string): string {
  const name = displayName.trim();
  if (!name || /^\d{5,}$/.test(name)) return uiText("Telegram");
  return name;
}

export function TelegramChatsNav({
  context,
}: {
  context?: { companyId?: string | null; companyPrefix?: string | null } | null;
}) {
  const companyId = context?.companyId ?? "";
  const prefix = context?.companyPrefix ?? "";
  const navigation = useHostNavigation();
  const overview = usePluginData<OverviewData>(
    "overview",
    companyId ? { companyId } : undefined,
  );
  const refreshOverview = useRef(overview.refresh);
  refreshOverview.current = overview.refresh;
  const inboxStream = usePluginStream(
    companyId ? "telegram-inbox" : "telegram-inbox:none",
    companyId ? { companyId } : undefined,
  );
  useEffect(() => {
    if (!inboxStream.lastEvent) return;
    refreshOverview.current();
  }, [inboxStream.lastEvent]);
  useEffect(() => {
    if (!companyId) return undefined;
    const onVisible = () => {
      if (!document.hidden) refreshOverview.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [companyId]);
  const accounts = overview.data?.connections ?? [];
  if (!companyId || !prefix || overview.error) return null;
  if (accounts.length === 0) {
    if (overview.loading) return null;
    return <div style={{ ...chatLink, opacity: 0.6 }}>{uiText("No chats")}</div>;
  }
  return (
    <div style={{ display: "grid", gap: 2 }}>
      {accounts.map((account) => {
        const label = instanceLabel(account.displayName);
        return (
          <a
            key={account.telegramUserId}
            {...navigation.linkProps(`/${prefix}/telegram-inbox`)}
            style={chatLink}
            title={label}
          >
            <span style={{ fontSize: 10, opacity: 0.6, width: 16, flex: "0 0 auto" }}>TG</span>
            <span style={chatLabel}>{label}</span>
          </a>
        );
      })}
    </div>
  );
}
