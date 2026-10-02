import * as React from "react";

/** Source-adapted shadcn Button for the standalone, non-Tailwind devtool. */
export function Button({
  className = "",
  variant = "default",
  ...props
}: React.ComponentProps<"button"> & {
  variant?: "default" | "danger" | "ghost";
}) {
  return (
    <button
      data-slot="button"
      className={`pcr-button pcr-button--${variant} ${className}`.trim()}
      {...props}
    />
  );
}
