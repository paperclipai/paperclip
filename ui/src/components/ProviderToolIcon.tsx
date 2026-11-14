import { createContext, useContext, useMemo, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { pickMcpIcon, sanitizeMcpIconSrc, type McpIcon, type ProviderToolIconEntry } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { useResolvedTheme } from "@/context/ThemeContext";
import { cn } from "@/lib/utils";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * A provider's tool icon (MCP SEP-973) with the taxonomy icon as fallback.
 * The icon is always an `<img>` with no referrer, never inlined markup, so an
 * SVG icon's scripts never run. The source is re-checked at render time and
 * a failed load falls back to the taxonomy icon.
 */
export function ProviderToolIcon({
  icons,
  fallback: Fallback,
  className,
  testId,
}: {
  icons: readonly McpIcon[] | null | undefined;
  fallback: IconComponent;
  className?: string;
  testId?: string;
}) {
  // Subscribed, so a theme switch re-picks the icon for the new theme.
  const icon = pickMcpIcon(icons, useResolvedTheme());
  const src = icon ? sanitizeMcpIconSrc(icon.src, icon.mimeType) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return <Fallback className={className} aria-hidden data-testid={testId} />;
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      draggable={false}
      width={14}
      height={14}
      data-testid={testId}
      data-provider-icon="true"
      onError={() => setFailedSrc(src)}
      className={cn("object-contain", className)}
    />
  );
}

/** Gateway tool name (`mcp.<app>-<connection>:<tool>`) inside a transcript tool name. */
const GATEWAY_TOOL_NAME = /(?:mcp|app)\.[a-z0-9-]+-[a-z0-9]{1,8}:[a-z0-9-]+/i;

export function gatewayToolNameIn(rawName: string | null | undefined): string | null {
  return rawName ? GATEWAY_TOOL_NAME.exec(rawName)?.[0]?.toLowerCase() ?? null : null;
}

/** Native runner tool name (`app_<name>_<12-hex digest>`) inside a transcript tool name. */
const NATIVE_TOOL_NAME = /app_[A-Za-z0-9_]*_[0-9a-f]{12}(?![0-9a-f])/;

export function nativeToolNameIn(rawName: string | null | undefined): string | null {
  return rawName ? NATIVE_TOOL_NAME.exec(rawName)?.[0] ?? null : null;
}

export type ProviderToolIconLookup = (rawName: string | null | undefined) => McpIcon[] | null;

export function providerToolIconLookup(entries: readonly ProviderToolIconEntry[]): ProviderToolIconLookup {
  const byName = new Map(entries.map((entry) => [entry.gatewayToolName.toLowerCase(), entry.icons]));
  const byNativeName = new Map(entries.flatMap((entry) => entry.nativeToolName ? [[entry.nativeToolName, entry.icons] as const] : []));
  return (rawName) => {
    const name = gatewayToolNameIn(rawName);
    if (!name) {
      // Native runners name tools `app_<name>_<digest>` in their transcripts.
      const native = nativeToolNameIn(rawName);
      return native ? byNativeName.get(native) ?? null : null;
    }
    // Same-named tools on one connection get a `-<id>` suffix from the gateway.
    return byName.get(name) ?? byName.get(name.replace(/-[0-9a-f]{8}$/, "")) ?? null;
  };
}

const NO_ICONS: ProviderToolIconLookup = () => null;
const ProviderToolIconsContext = createContext<ProviderToolIconLookup>(NO_ICONS);

/**
 * Loads a company's provider tool icons once (one small, cached request) so
 * every tool row in the chat finds its icon without a request of its own.
 */
export function ProviderToolIconsProvider({ companyId, children }: { companyId: string | null | undefined; children: ReactNode }) {
  const query = useQuery({
    queryKey: queryKeys.tools.providerIcons(companyId ?? ""),
    queryFn: () => toolsApi.listProviderToolIcons(companyId!),
    enabled: Boolean(companyId),
    staleTime: 10 * 60_000,
  });
  const entries = query.data?.icons;
  const lookup = useMemo(() => (entries?.length ? providerToolIconLookup(entries) : NO_ICONS), [entries]);
  return <ProviderToolIconsContext.Provider value={lookup}>{children}</ProviderToolIconsContext.Provider>;
}

/** Static icons, for stories and tests. */
export function ProviderToolIconsStaticProvider({ entries, children }: { entries: readonly ProviderToolIconEntry[]; children: ReactNode }) {
  const lookup = useMemo(() => providerToolIconLookup(entries), [entries]);
  return <ProviderToolIconsContext.Provider value={lookup}>{children}</ProviderToolIconsContext.Provider>;
}

export function useProviderToolIcons(rawName: string | null | undefined): McpIcon[] | null {
  return useContext(ProviderToolIconsContext)(rawName);
}
