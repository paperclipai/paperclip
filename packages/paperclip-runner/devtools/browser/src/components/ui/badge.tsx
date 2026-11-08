import * as React from "react";

/** Source-adapted shadcn Badge with semantic state supplied through data-tone. */
export function Badge({
  className = "",
  tone = "neutral",
  ...props
}: React.ComponentProps<"span"> & {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
}) {
  return (
    <span
      data-slot="badge"
      data-tone={tone}
      className={`ui-badge ${className}`.trim()}
      {...props}
    />
  );
}
