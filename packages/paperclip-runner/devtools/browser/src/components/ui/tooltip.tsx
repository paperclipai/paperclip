import * as React from "react";

/**
 * Source-adapted shadcn Tooltip. The content is always mirrored into a
 * described-by element, so a tooltip is never the only channel for a
 * diagnostic (interaction map A5).
 */
export function Tooltip({
  content,
  id,
  children,
}: {
  content: string;
  id: string;
  children: React.ReactElement<{ "aria-describedby"?: string }>;
}) {
  return (
    <span data-slot="tooltip" className="ui-tooltip">
      {React.cloneElement(children, { "aria-describedby": id })}
      <span role="tooltip" id={id} className="ui-tooltip-content">
        {content}
      </span>
    </span>
  );
}
