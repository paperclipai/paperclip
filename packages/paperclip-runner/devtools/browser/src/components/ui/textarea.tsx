import * as React from "react";

/** Source-adapted shadcn Textarea for editable fixture JSON. */
export function Textarea({
  className = "",
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={`ui-textarea ${className}`.trim()}
      {...props}
    />
  );
}
