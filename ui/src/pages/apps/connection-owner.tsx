import { useTranslation, t as translate } from "@/i18n";
import type { McpConnection, ToolConnection } from "@paperclipai/shared";
import { humanizeConnectionDisplayName } from "@paperclipai/shared";
import { Identity } from "@/components/Identity";
import type { CompanyUserProfile } from "@/lib/company-members";

export type ConnectionOwnerProfile = CompanyUserProfile;

export function connectionOwnerProfile(
  connection: Pick<ToolConnection, "createdByUserId">,
  profiles: ReadonlyMap<string, CompanyUserProfile>,
): ConnectionOwnerProfile | null {
  if (!connection.createdByUserId) return null;
  return profiles.get(connection.createdByUserId) ?? {
    label: connection.createdByUserId === "local-board" ? translate("connections:board_e879b0b") : translate("connections:board_member_5ba4ac1"),
    image: null,
  };
}

function ownerGivenName(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return translate("connections:board_e879b0b");
  const first = trimmed.split(/\s+/)[0] ?? trimmed;
  return first.includes("@") ? first.split("@")[0] || translate("connections:board_e879b0b") : first;
}

function possessive(label: string): string {
  return translate("connections:s_18addd3", { label, context: label.toLowerCase().endsWith("s") ? "s" : undefined });
}

/**
 * Keep intentionally customized account names, while making the default app
 * name useful in a multi-user company ("Dotta’s Notion", "Sam’s Gmail").
 */
export function connectionDisplayNameForOwner(
  connection: Pick<ToolConnection, "name">,
  applicationName: string,
  owner: ConnectionOwnerProfile | null,
): string {
  const rawName = connection.name.trim();
  // Provider account identifiers are machine values, not prose. Preserve
  // their casing and punctuation so an email address or tenant hostname stays
  // recognizable in the inline account list.
  const connectionName =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawName) ||
    /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(rawName)
      ? rawName
      : humanizeConnectionDisplayName(connection);
  if (!owner) return connectionName;
  if (connectionName.trim().toLocaleLowerCase() !== applicationName.trim().toLocaleLowerCase()) {
    return connectionName;
  }
  return translate("connections:_5892e0c", { possessive: possessive(ownerGivenName(owner.label)), applicationName: applicationName });
}

/** Use the same owner naming as outbound connections, without changing OAuth client identity. */
export function assistantConnectionDisplayName(connection: McpConnection): string {
  const clientName = connection.clientName.trim();
  const owner = connection.user ? translate("connections:_1ba34f9", { possessive: possessive(ownerGivenName(connection.user.name)) }) : "";
  return translate("connections:connection_6a064be", { owner: owner, clientName: clientName });
}

export function ConnectionOwnerIdentity({ owner }: { owner: ConnectionOwnerProfile | null }) {
  const { t } = useTranslation("connections");
  if (!owner) return <span className="text-xs text-muted-foreground">{t("unknown_bc7819b")}</span>;
  return (
    <Identity
      name={owner.label}
      avatarUrl={owner.image}
      size="sm"
      className="text-muted-foreground"
    />
  );
}
