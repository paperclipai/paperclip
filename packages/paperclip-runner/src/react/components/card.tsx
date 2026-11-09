import * as React from "react";

function slotClass(slot: string, className: string | undefined) {
  return `${slot} ${className ?? ""}`.trim();
}

/** Source-adapted shadcn Card family for the standalone devtool. */
export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return <section data-slot="card" className={slotClass("pcr-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={slotClass("pcr-card-header", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={slotClass("pcr-card-title", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="card-description" className={slotClass("pcr-card-description", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={slotClass("pcr-card-content", className)} {...props} />;
}
