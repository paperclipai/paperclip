import * as React from "react";

/** Source-adapted shadcn Button for the standalone, non-Tailwind devtool. */
export function Button({
  className = "",
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      data-slot="button"
      className={`ui-button ${className}`.trim()}
      {...props}
    />
  );
}
