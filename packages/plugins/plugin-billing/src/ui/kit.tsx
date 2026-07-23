/**
 * Local, minimal design kit for the billing plugin's own pages.
 *
 * Mirrors the pattern plugin-llm-wiki's UI actually uses (see
 * packages/plugins/plugin-llm-wiki/src/ui/app.tsx): host CSS custom
 * properties read through inline styles (with hard-coded oklch fallbacks so
 * the plugin still looks right if the host hasn't set the variables), a
 * Card/CardHeader/CardBody trio instead of raw sections, a small Button with
 * host-convention variants, PropRow instead of raw <dl>, and Callout instead
 * of bare alert paragraphs. No SDK host component (DataTable, KeyValueList,
 * ActionBar, MetricCard, ...) is used by llm-wiki either — this file is the
 * "reality wins" equivalent, kept local so it stays test-invisible (nothing
 * here is stubbed by the host bridge).
 */

import type { CSSProperties, ReactNode } from "react";

export const tokens = {
  border: "var(--border, oklch(0.269 0 0))",
  card: "var(--card, oklch(0.205 0 0))",
  bg: "var(--background, oklch(0.145 0 0))",
  fg: "var(--foreground, oklch(0.985 0 0))",
  muted: "var(--muted-foreground, oklch(0.708 0 0))",
  accent: "var(--accent, oklch(0.269 0 0))",
  primary: "var(--primary, oklch(0.985 0 0))",
  primaryFg: "var(--primary-foreground, oklch(0.205 0 0))",
  destructive: "var(--destructive, oklch(0.637 0.237 25.331))",
};

export const fontStack = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

export function Stack({ gap = 18, style, children }: { gap?: number; style?: CSSProperties; children: ReactNode }) {
  return <div style={{ display: "grid", gap, minWidth: 0, fontFamily: fontStack, ...style }}>{children}</div>;
}

export function PageHeading({ children }: { children: ReactNode }) {
  return <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: tokens.fg }}>{children}</h2>;
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <section
      style={{
        background: tokens.card,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        overflow: "hidden",
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </section>
  );
}

export function CardHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div
      style={{
        padding: "12px 16px",
        borderBottom: `1px solid ${tokens.border}`,
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12,
        minWidth: 0,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: tokens.fg, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {title}
      </h3>
      {right ? <div style={{ marginLeft: "auto", minWidth: 0 }}>{right}</div> : null}
    </div>
  );
}

export function CardBody({ children, padding = 16 }: { children: ReactNode; padding?: number | string }) {
  return <div style={{ padding }}>{children}</div>;
}

/** Label/value row, replacing raw <dl>/<dt>/<dd> pairs. */
export function PropRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        flexWrap: "wrap",
        gap: 12,
        padding: "6px 0",
        fontSize: 13,
        minWidth: 0,
        borderBottom: `1px solid ${tokens.border}`,
      }}
    >
      <span style={{ color: tokens.muted, fontSize: 12, flexShrink: 0 }}>{label}</span>
      <span style={{ flex: "1 1 220px", minWidth: 0, textAlign: "right", overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

export function PropRowList({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid" }}>{children}</div>;
}

type ButtonVariant = "primary" | "default" | "destructive" | "ghost";

export function Button({
  variant = "default",
  disabled,
  onClick,
  children,
  type = "button",
  style,
}: {
  variant?: ButtonVariant;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  type?: "button" | "submit";
  style?: CSSProperties;
}) {
  const palette: Record<ButtonVariant, CSSProperties> = {
    primary: { background: tokens.primary, color: tokens.primaryFg, border: "1px solid transparent" },
    default: { background: tokens.card, color: tokens.fg, border: `1px solid ${tokens.border}` },
    ghost: { background: "transparent", color: tokens.fg, border: "1px solid transparent" },
    destructive: { background: "transparent", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.5 0.18 25)" },
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 14px",
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: fontStack,
        whiteSpace: "nowrap",
        ...palette[variant],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function ActionRow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", ...style }}>{children}</div>;
}

type CalloutTone = "info" | "warning" | "danger";

const calloutPalette: Record<CalloutTone, { bg: string; fg: string; border: string }> = {
  info: { bg: "oklch(0.2 0.04 250)", fg: "oklch(0.85 0.08 250)", border: "oklch(0.4 0.1 250)" },
  warning: { bg: "oklch(0.22 0.06 70)", fg: "oklch(0.85 0.1 70)", border: "oklch(0.45 0.12 70)" },
  danger: { bg: "oklch(0.22 0.06 25)", fg: "oklch(0.85 0.12 25)", border: "oklch(0.45 0.12 25)" },
};

export function Callout({
  children,
  tone = "info",
  role,
}: {
  children: ReactNode;
  tone?: CalloutTone;
  role?: "alert" | "status";
}) {
  const palette = calloutPalette[tone];
  return (
    <div
      role={role}
      style={{
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
        padding: "12px 14px",
        fontSize: 13,
        lineHeight: 1.55,
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      {children}
    </div>
  );
}

export function LoadingBlock({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "28px 16px", textAlign: "center", color: tokens.muted, fontSize: 13 }}>{children}</div>
  );
}

export function Mono({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12, overflowWrap: "anywhere", ...style }}>
      {children}
    </span>
  );
}
