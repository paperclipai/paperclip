import * as React from "react";

/**
 * Source-adapted shadcn Alert. Failures stay in the transcript record, so this
 * is only used for standing conditions (reconnect, pending request, replay).
 */
export function Banner({
  className = "",
  tone = "neutral",
  assertive = false,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: "neutral" | "info" | "accent" | "success" | "warning" | "danger";
  assertive?: boolean;
}) {
  return (
    <div
      data-slot="banner"
      data-tone={tone}
      {...(assertive ? { role: "alert", "aria-live": "assertive" } : {})}
      className={`pcr-banner ${className}`.trim()}
      {...props}
    />
  );
}

export function BannerText({ className = "", ...props }: React.ComponentProps<"p">) {
  return <p data-slot="banner-text" className={`pcr-banner-text ${className}`.trim()} {...props} />;
}

export function BannerActions({ className = "", ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="banner-actions"
      className={`pcr-banner-actions ${className}`.trim()}
      {...props}
    />
  );
}
