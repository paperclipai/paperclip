import { useTranslation } from "@/i18n";
import { Blocks } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { appTabHref } from "./app-tabs";
import { composioChildParentConnectionId, composioChildToolkitSlug } from "./composio-services";

/**
 * "via Composio" on a connection that Composio brokers (PAP-17865).
 *
 * A toolkit child looks like any other app in the connections list, which hides
 * the coupling that matters most: its credentials live in Composio, and pausing
 * or removing the Composio connection takes it down too. The chip states that
 * relationship wherever the child appears, and links to the broker's Services tab
 * so the parent is one click away.
 */
export function ConnectionProvenanceChip({
  connection,
  className,
}: {
  connection: {
    config?: Record<string, unknown> | null;
    credentialSource?: string;
    externalCredential?: { connectorUid?: string } | null;
  } | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const chipClass = cn(
    "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground",
    className,
  );
  if (connection?.credentialSource === "vercel_connect") {
    const connectorUid = connection.externalCredential?.connectorUid;
    return (
      <span
        className={chipClass}
        title={connectorUid ? t("localizationApps.credentialsVercel", { id: connectorUid }) : t("localizationApps.credentialsManagedByVercelConnect733")}
      >
        <Blocks className="h-3 w-3" />{t("localizationApps.viaVercelConnect734")}</span>
    );
  }

  const toolkitSlug = composioChildToolkitSlug(connection);
  if (!toolkitSlug) return null;
  const parentConnectionId = composioChildParentConnectionId(connection);
  const label = (
    <>
      <Blocks className="h-3 w-3" />{t("localizationApps.viaComposio735")}</>
  );

  // Without a parent id there is nowhere to send the reader, so the chip stays a
  // label rather than becoming a dead link.
  if (!parentConnectionId) {
    return <span className={chipClass} title={t("localizationApps.brokeredComposio", { slug: toolkitSlug })}>{label}</span>;
  }

  return (
    <Link
      to={appTabHref(parentConnectionId, "services")}
      className={cn(chipClass, "transition-colors hover:bg-accent hover:text-accent-foreground")}
      title={t("localizationApps.brokeredComposioOpenServices", { slug: toolkitSlug })}
      onClick={(event) => event.stopPropagation()}
    >
      {label}
    </Link>
  );
}

/** Backward-compatible name for callers outside the Apps v2 surfaces. */
export const ComposioProvenanceChip = ConnectionProvenanceChip;
