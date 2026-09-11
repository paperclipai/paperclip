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
  tone?: "neutral" | "accent" | "warning" | "danger";
  assertive?: boolean;
}) {
  return (
    <div
      data-slot="banner"
      data-tone={tone}
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      className={`ui-banner ${className}`.trim()}
      {...props}
    />
  );
}

export function BannerText({ className = "", ...props }: React.ComponentProps<"p">) {
  return <p data-slot="banner-text" className={`ui-banner-text ${className}`.trim()} {...props} />;
}

export function BannerActions({ className = "", ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="banner-actions"
      className={`ui-banner-actions ${className}`.trim()}
      {...props}
    />
  );
}
