import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

export function PipelinesSidebar({ context }: PluginSidebarProps) {
  const nav = useHostNavigation();

  const href = context.companyPrefix
    ? `/${context.companyPrefix}/pipelines`
    : "/pipelines";

  const linkProps = nav.linkProps(href);

  return (
    <a
      {...linkProps}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 6,
        color: "#d1d5db",
        textDecoration: "none",
        fontSize: 13,
        fontWeight: 500,
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.background = "#1f2937";
        (e.currentTarget as HTMLAnchorElement).style.color = "#f9fafb";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.background = "transparent";
        (e.currentTarget as HTMLAnchorElement).style.color = "#d1d5db";
      }}
    >
      {/* Pipeline icon */}
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ flexShrink: 0 }}
      >
        <rect x="2" y="2" width="4" height="4" rx="1" fill="currentColor" opacity="0.8" />
        <rect x="6" y="6" width="4" height="4" rx="1" fill="currentColor" opacity="0.6" />
        <rect x="10" y="10" width="4" height="4" rx="1" fill="currentColor" opacity="0.4" />
        <line x1="6" y1="4" x2="8" y2="4" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
        <line x1="10" y1="8" x2="12" y2="8" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
      </svg>
      Pipelines
    </a>
  );
}
